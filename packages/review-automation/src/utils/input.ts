/**
 * 自动化输入边界：只接受有界 JSON，不执行表达式代码，不读取对象原型。
 * 调用：const event = reviewEvent(value, 'owner/repo')。
 */
import type { Json, ObjectValue, ReviewEvent } from "../types.js";

export class AutomationError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  constructor(code: string, message: string, status = 400, retryable = false) {
    super(message);
    this.name = "AutomationError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}
export function object(
  value: unknown,
  name = "input",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AutomationError("invalid_input", `${name} must be a JSON object`);
  return value as Record<string, unknown>;
}
export function text(
  value: unknown,
  name: string,
  max = 200,
  fallback?: string,
): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw new AutomationError(
      "invalid_input",
      `${name} must contain 1 to ${max} characters`,
    );
  return value.trim();
}
export function integer(
  value: unknown,
  name: string,
  min: number,
  max: number,
  fallback?: number,
): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new AutomationError(
      "invalid_input",
      `${name} must be an integer between ${min} and ${max}`,
    );
  return value;
}
export function bool(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean")
    throw new AutomationError("invalid_input", `${name} must be a boolean`);
  return value;
}
export function repositoryName(value: unknown): string {
  const name = text(value, "repository", 200).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/.test(name))
    throw new AutomationError(
      "invalid_repository",
      "repository must be owner/name",
    );
  return name;
}
export function jsonValue(value: unknown, maxBytes = 128 * 1024): Json {
  let nodes = 0;
  const visit = (entry: unknown, depth: number): Json => {
    nodes += 1;
    if (nodes > 10_000 || depth > 20)
      throw new AutomationError(
        "invalid_input",
        "JSON data is too deeply nested or contains too many values",
      );
    if (
      entry === null ||
      typeof entry === "boolean" ||
      typeof entry === "string"
    )
      return entry;
    if (typeof entry === "number" && Number.isFinite(entry)) return entry;
    if (Array.isArray(entry))
      return entry.map((child) => visit(child, depth + 1));
    if (entry && typeof entry === "object") {
      const result: ObjectValue = {};
      for (const [key, child] of Object.entries(entry)) {
        if (["__proto__", "constructor", "prototype"].includes(key))
          throw new AutomationError(
            "invalid_input",
            "JSON contains a reserved object key",
          );
        result[key] = visit(child, depth + 1);
      }
      return result;
    }
    throw new AutomationError(
      "invalid_input",
      "data must contain JSON values only",
    );
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes)
    throw new AutomationError(
      "input_too_large",
      "JSON data exceeds the configured size limit",
      413,
    );
  return result;
}
export function jsonObject(value: unknown, name = "input"): ObjectValue {
  return jsonValue(object(value, name)) as ObjectValue;
}
export function iso(value: unknown, name: string): string {
  const raw = text(value, name, 100);
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime()))
    throw new AutomationError(
      "invalid_input",
      `${name} must be an ISO timestamp`,
    );
  return parsed.toISOString();
}
export function reviewEvent(value: unknown, repository: string): ReviewEvent {
  const source = object(value, "event");
  const event: ReviewEvent = {
    id: text(source.id, "event.id", 300),
    type: text(source.type, "event.type", 100),
    repository: repositoryName(source.repository),
    occurredAt: iso(source.occurredAt, "event.occurredAt"),
  };
  if (event.repository !== repository)
    throw new AutomationError(
      "repository_mismatch",
      "event repository does not match the command repository",
    );
  if (source.subject !== undefined) {
    const subject = object(source.subject, "event.subject");
    if (subject.kind !== "pr" && subject.kind !== "issue")
      throw new AutomationError(
        "invalid_input",
        "subject.kind must be pr or issue",
      );
    event.subject = {
      kind: subject.kind,
      number: integer(subject.number, "subject.number", 1, 2_147_483_647),
    };
    if (subject.labels !== undefined) {
      if (!Array.isArray(subject.labels) || subject.labels.length > 100)
        throw new AutomationError(
          "invalid_input",
          "subject.labels must be a bounded list",
        );
      event.subject.labels = [
        ...new Set(subject.labels.map((label) => text(label, "label", 200))),
      ];
    }
  }
  if (source.gate !== undefined) {
    if (
      source.gate !== "pass" &&
      source.gate !== "warn" &&
      source.gate !== "fail"
    )
      throw new AutomationError("invalid_input", "invalid gate decision");
    event.gate = source.gate;
  }
  if (source.risk !== undefined) {
    if (
      !["info", "low", "medium", "high", "critical"].includes(
        String(source.risk),
      )
    )
      throw new AutomationError("invalid_input", "invalid risk");
    event.risk = source.risk as ReviewEvent["risk"] & string;
  }
  if (source.findings !== undefined) {
    const findings = object(source.findings, "event.findings");
    event.findings = {
      total: integer(findings.total, "findings.total", 0, 1_000_000),
    };
    for (const key of [
      "new",
      "critical",
      "high",
      "medium",
      "low",
      "info",
    ] as const)
      if (findings[key] !== undefined)
        event.findings[key] = integer(
          findings[key],
          `findings.${key}`,
          0,
          1_000_000,
        );
  }
  if (source.data !== undefined)
    event.data = jsonObject(source.data, "event.data");
  if (source.trace !== undefined) {
    const trace = object(source.trace, "event.trace");
    if (!Array.isArray(trace.ruleIds) || trace.ruleIds.length > 32)
      throw new AutomationError(
        "invalid_input",
        "trace.ruleIds must be bounded",
      );
    event.trace = {
      depth: integer(trace.depth, "trace.depth", 0, 32),
      ruleIds: trace.ruleIds.map((id) => text(id, "trace.ruleId")),
    };
  }
  return event;
}
/** 规范化对象键用于相同事件键的内容冲突检测。 */
export function canonical(value: Json): string {
  const ordered = (entry: Json): Json =>
    Array.isArray(entry)
      ? entry.map(ordered)
      : entry !== null && typeof entry === "object"
        ? Object.fromEntries(
            Object.entries(entry)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, child]) => [key, ordered(child)]),
          )
        : entry;
  return JSON.stringify(ordered(value));
}
