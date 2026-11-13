/**
 * 工作台边界输入；域方法只接收这里整理后的值。
 * @example const repository = repositoryName(input.repository);
 */
import type { Severity } from "../types.js";

export class WorkbenchError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "WorkbenchError";
  }
}

/** 只接受 JSON 对象，数组和 null 均不是请求对象。 */
export function object(
  value: unknown,
  field = "input",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkbenchError("invalid_input", `${field} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

/** 去掉首尾空格后检查文本长度；不会把对象偷偷转为字符串。 */
export function text(
  value: unknown,
  field: string,
  max = 500,
  fallback?: string,
): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string") {
    throw new WorkbenchError("invalid_input", `${field} 必须是文本`);
  }
  const clean = value.trim();
  if (!clean || clean.length > max || clean.includes("\0")) {
    throw new WorkbenchError(
      "invalid_input",
      `${field} 长度必须为 1 到 ${max}`,
    );
  }
  return clean;
}

/** 允许空字符串的说明字段，同样限制大小。 */
export function optionalText(
  value: unknown,
  field: string,
  max = 10_000,
): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > max || value.includes("\0")) {
    throw new WorkbenchError(
      "invalid_input",
      `${field} 必须是至多 ${max} 字的文本`,
    );
  }
  return value.trim();
}

/** 仓库名作为权限边界，规范化一次后下游不再猜大小写。 */
export function repositoryName(value: unknown): string {
  const repository = text(value, "repository", 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new WorkbenchError(
      "invalid_repository",
      "repository 应为 owner/name",
    );
  }
  if (repository.endsWith("/.") || repository.endsWith("/..")) {
    throw new WorkbenchError("invalid_repository", "仓库名称无效");
  }
  return repository.toLowerCase();
}

/** 整数用于钱、次数和 token，禁止 Infinity/小数/负数溜进累计值。 */
export function integer(
  value: unknown,
  field: string,
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
  ) {
    throw new WorkbenchError(
      "invalid_input",
      `${field} 必须是 ${min} 到 ${max} 的整数`,
    );
  }
  return value;
}

/** 置信度是 0 到 1；不接受字符串和非有限数。 */
export function confidence(value: unknown, fallback = 1): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new WorkbenchError(
      "invalid_input",
      "confidence 必须为 0 到 1 的数字",
    );
  }
  return value;
}

export function boolean(
  value: unknown,
  field: string,
  fallback?: boolean,
): boolean {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "boolean")
    throw new WorkbenchError("invalid_input", `${field} 必须为布尔值`);
  return value;
}

export function choice<T extends string>(
  value: unknown,
  field: string,
  choices: readonly T[],
  fallback?: T,
): T {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new WorkbenchError(
      "invalid_input",
      `${field} 可选值：${choices.join(", ")}`,
    );
  }
  return value as T;
}

export const severities: readonly Severity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
];

/** 数组同时限制元素数量；空数组是否有意义由对应业务决定。 */
export function array(value: unknown, field: string, max = 10_000): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new WorkbenchError(
      "invalid_input",
      `${field} 必须是最多 ${max} 项的数组`,
    );
  }
  return value;
}

export function strings(
  value: unknown,
  field: string,
  max = 100,
  maxLength = 500,
): string[] {
  if (value === undefined) return [];
  return [
    ...new Set(
      array(value, field, max).map((item) => text(item, field, maxLength)),
    ),
  ];
}

/** 只接收无时区歧义的 ISO 时间；输出总是 UTC ISO。 */
export function timestamp(value: unknown, field: string): string {
  const raw = text(value, field, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw)) {
    throw new WorkbenchError(
      "invalid_input",
      `${field} 必须是以 Z 结尾的 ISO UTC 时间`,
    );
  }
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime()))
    throw new WorkbenchError("invalid_input", `${field} 不是有效时间`);
  const day = raw.slice(0, 10);
  if (date.toISOString().slice(0, 10) !== day) {
    throw new WorkbenchError("invalid_input", `${field} 包含不存在的日期`);
  }
  return date.toISOString();
}

/** 源码路径使用仓库相对路径；它永远不会交给文件系统执行。 */
export function sourcePath(value: unknown, field = "path"): string {
  const path = text(value, field, 1000).replaceAll("\\", "/");
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").includes("..")
  ) {
    throw new WorkbenchError("invalid_input", `${field} 必须是仓库内相对路径`);
  }
  return path.replace(/^\.\//, "");
}

/** glob 只支持 *、**、?；不执行用户正则，也不会出现指数回溯。 */
export function globMatches(pattern: string, candidate: string): boolean {
  const width = candidate.length;
  let previous = new Uint8Array(width + 1);
  previous[0] = 1;
  for (let index = 0; index < pattern.length; index += 1) {
    const token = pattern[index]!;
    const next = new Uint8Array(width + 1);
    const deep = token === "*" && pattern[index + 1] === "*";
    if (deep && pattern[index + 2] === "/") {
      // **/ 可以是零级目录，也可以是以 / 结尾的任意深度前缀。
      // 这样 **/*.test.ts 能覆盖根目录中的 api.test.ts。
      next[0] = previous[0]!;
      let reachable = previous[0] === 1;
      for (let offset = 1; offset <= width; offset += 1) {
        reachable = reachable || previous[offset - 1] === 1;
        next[offset] =
          previous[offset] || (reachable && candidate[offset - 1] === "/")
            ? 1
            : 0;
      }
      index += 2;
    } else if (token === "*") {
      next[0] = previous[0]!;
      for (let offset = 1; offset <= width; offset += 1) {
        next[offset] =
          previous[offset] ||
          ((deep || candidate[offset - 1] !== "/") && next[offset - 1])
            ? 1
            : 0;
      }
      if (deep) index += 1;
    } else {
      for (let offset = 1; offset <= width; offset += 1) {
        const matches =
          token === "?"
            ? candidate[offset - 1] !== "/"
            : token === candidate[offset - 1];
        next[offset] = matches && previous[offset - 1] ? 1 : 0;
      }
    }
    previous = next;
  }
  return previous[width] === 1;
}

/** 写操作可带 expectedRevision，防止两个人的编辑互相覆盖。 */
export function revision(
  record: { revision: number },
  expected: unknown,
): void {
  if (expected === undefined) return;
  const version = integer(
    expected,
    "expectedRevision",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (record.revision !== version) {
    throw new WorkbenchError(
      "revision_conflict",
      `记录已更新，当前版本为 ${record.revision}`,
      409,
    );
  }
}

/** 找不到对象和没有权限使用相同 404，避免跨仓库枚举 id。 */
export function findRecord<T extends { id: string; repository: string }>(
  items: T[],
  repository: string,
  id: unknown,
): T {
  const key = text(id, "id", 100);
  const record = items.find(
    (item) => item.id === key && item.repository === repository,
  );
  if (!record) throw new WorkbenchError("not_found", "记录不存在", 404);
  return record;
}

/** 对开放元数据做 JSON 边界检查，只保存小型的有限 JSON 值。 */
export function metadata(
  value: unknown,
  field = "result",
): Record<string, unknown> {
  const record = object(value, field);
  const serialized = JSON.stringify(record);
  if (serialized.length > 32_000)
    throw new WorkbenchError("invalid_input", `${field} 超过 32 KB`);
  const walk = (item: unknown, depth: number): void => {
    if (depth > 12)
      throw new WorkbenchError("invalid_input", `${field} 嵌套过深`);
    if (typeof item === "number" && !Number.isFinite(item)) {
      throw new WorkbenchError("invalid_input", `${field} 包含非有限数字`);
    }
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean"
    )
      return;
    if (typeof item !== "object")
      throw new WorkbenchError("invalid_input", `${field} 必须是 JSON 数据`);
    for (const child of Object.values(item)) walk(child, depth + 1);
  };
  walk(record, 0);
  return JSON.parse(serialized) as Record<string, unknown>;
}
