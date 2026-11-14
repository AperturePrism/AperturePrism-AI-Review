/**
 * 发现的完整生命周期：导入、去重、指派、处置、再次出现。
 * @example createFinding(context, {ruleId:'auth', title:'缺少权限检查', path:'src/api.ts', line:12, severity:'high'});
 */
import { createHash } from "node:crypto";
import type { Finding, FindingStatus } from "./types.js";
import { audit, identity, touch, type CommandContext } from "./audit.js";
import {
  array,
  choice,
  confidence,
  findRecord,
  integer,
  object,
  optionalText,
  revision,
  severities,
  sourcePath,
  strings,
  text,
  WorkbenchError,
} from "./utils/input.js";

export const findingStatuses: readonly FindingStatus[] = [
  "open",
  "acknowledged",
  "fixed",
  "false_positive",
  "accepted_risk",
];

/** 行号不参与指纹；在文件前插入一行不会把旧问题当作新问题。 */
export function findingFingerprint(
  ruleId: string,
  path: string,
  title: string,
): string {
  const normalizedTitle = title.trim().replace(/\s+/g, " ").toLowerCase();
  return createHash("sha256")
    .update(JSON.stringify([ruleId.toLowerCase(), path, normalizedTitle]))
    .digest("hex");
}

function parseFinding(
  input: Record<string, unknown>,
): Pick<
  Finding,
  | "fingerprint"
  | "ruleId"
  | "title"
  | "description"
  | "path"
  | "line"
  | "endLine"
  | "severity"
  | "confidence"
  | "source"
  | "reference"
  | "tags"
> {
  const title = text(input.title, "title", 500);
  const ruleId = text(input.ruleId, "ruleId", 200);
  const path = sourcePath(input.path);
  const line = integer(input.line, "line", 1, 100_000_000, 1);
  return {
    fingerprint:
      input.fingerprint === undefined
        ? findingFingerprint(ruleId, path, title)
        : text(input.fingerprint, "fingerprint", 200),
    ruleId,
    title,
    description: optionalText(input.description, "description", 20_000),
    path,
    line,
    endLine: integer(input.endLine, "endLine", line, 100_000_000, line),
    severity: choice(input.severity, "severity", severities, "medium"),
    confidence: confidence(input.confidence),
    source: optionalText(input.source, "source", 200),
    reference: optionalText(input.reference, "reference", 500),
    tags: strings(input.tags, "tags", 50, 100),
  };
}

/** 再次导入同一指纹只更新证据；已修复的问题再次出现会自动重开。 */
export function createFinding(
  context: CommandContext,
  input: Record<string, unknown>,
): Finding {
  const parsed = parseFinding(input);
  const existing = context.data.findings.find(
    (item) =>
      item.repository === context.repository &&
      item.fingerprint === parsed.fingerprint,
  );
  if (existing) {
    Object.assign(existing, parsed);
    existing.occurrences += 1;
    existing.lastSeenAt = context.now;
    if (existing.status === "fixed") {
      existing.history.push({
        at: context.now,
        actor: context.actor.userId,
        action: "reappeared",
        from: "fixed",
        to: "open",
        reason: "后续审查再次发现同一问题",
      });
      existing.status = "open";
    }
    touch(context, existing);
    audit(context, "finding.seen", existing.id, {
      occurrences: existing.occurrences,
      status: existing.status,
    });
    return existing;
  }
  const finding: Finding = {
    ...identity(context),
    ...parsed,
    status: "open",
    assignee: "",
    occurrences: 1,
    lastSeenAt: context.now,
    history: [
      {
        at: context.now,
        actor: context.actor.userId,
        action: "created",
        from: "",
        to: "open",
        reason: "",
      },
    ],
  };
  context.data.findings.push(finding);
  audit(context, "finding.created", finding.id, {
    severity: finding.severity,
    ruleId: finding.ruleId,
    path: finding.path,
  });
  return finding;
}

/** 导入整个审查结果；任意一条无效都会回滚这次导入。 */
export function importFindings(
  context: CommandContext,
  input: Record<string, unknown>,
): { items: Finding[]; imported: number } {
  const items = array(input.findings, "findings", 10_000).map((value) =>
    object(value, "finding"),
  );
  const findings = items.map((item) => createFinding(context, item));
  audit(context, "finding.imported", context.repository, {
    count: findings.length,
  });
  return { items: findings, imported: findings.length };
}

/** 关闭、误报和风险接受必须留理由；关闭的记录只能先重开再重新分类。 */
export function transitionFinding(
  context: CommandContext,
  input: Record<string, unknown>,
): Finding {
  const finding = findRecord(
    context.data.findings,
    context.repository,
    input.id,
  );
  revision(finding, input.expectedRevision);
  const status = choice(input.status, "status", findingStatuses);
  const reason = text(input.reason, "reason", 3000);
  if (status === finding.status) return finding;
  const closed = ["fixed", "false_positive", "accepted_risk"].includes(
    finding.status,
  );
  if (closed && status !== "open") {
    throw new WorkbenchError(
      "invalid_transition",
      "已关闭发现必须先重新打开",
      409,
    );
  }
  const previous = finding.status;
  finding.status = status;
  finding.history.push({
    at: context.now,
    actor: context.actor.userId,
    action: "status",
    from: previous,
    to: status,
    reason,
  });
  touch(context, finding);
  audit(context, "finding.transitioned", finding.id, {
    from: previous,
    to: status,
  });
  return finding;
}

export function assignFinding(
  context: CommandContext,
  input: Record<string, unknown>,
): Finding {
  const finding = findRecord(
    context.data.findings,
    context.repository,
    input.id,
  );
  revision(finding, input.expectedRevision);
  const assignee = optionalText(input.assignee, "assignee", 200);
  const reason = optionalText(input.reason, "reason", 3000);
  const previous = finding.assignee;
  finding.assignee = assignee;
  finding.history.push({
    at: context.now,
    actor: context.actor.userId,
    action: "assignment",
    from: previous,
    to: assignee,
    reason,
  });
  touch(context, finding);
  audit(context, "finding.assigned", finding.id, { assignee });
  return finding;
}

/** 一次批量状态操作仍使用相同单条业务规则，发生冲突整体回滚。 */
export function bulkTransitionFindings(
  context: CommandContext,
  input: Record<string, unknown>,
): { items: Finding[] } {
  const ids = strings(input.ids, "ids", 500, 100);
  if (!ids.length)
    throw new WorkbenchError("invalid_input", "请至少选择一个发现");
  const items = ids.map((id) =>
    transitionFinding(context, {
      id,
      status: input.status,
      reason: input.reason,
    }),
  );
  return { items };
}

/** 默认按风险、最近出现时间排序；过滤不修改源数据。 */
export function listFindings(
  context: CommandContext,
  input: Record<string, unknown>,
): { items: Finding[]; total: number } {
  const status =
    input.status === undefined || input.status === ""
      ? null
      : choice(input.status, "status", findingStatuses);
  const severity =
    input.severity === undefined || input.severity === ""
      ? null
      : choice(input.severity, "severity", severities);
  const assignee = optionalText(input.assignee, "assignee", 200);
  const query = optionalText(input.query, "query", 300).toLowerCase();
  const limit = integer(input.limit, "limit", 1, 1000, 100);
  const offset = integer(input.offset, "offset", 0, 1_000_000, 0);
  const items = context.data.findings
    .filter((item) => item.repository === context.repository)
    .filter((item) => !status || item.status === status)
    .filter((item) => !severity || item.severity === severity)
    .filter((item) => !assignee || item.assignee === assignee)
    .filter(
      (item) =>
        !query ||
        `${item.title}\n${item.path}\n${item.ruleId}`
          .toLowerCase()
          .includes(query),
    )
    .sort(
      (left, right) =>
        severities.indexOf(left.severity) -
          severities.indexOf(right.severity) ||
        right.lastSeenAt.localeCompare(left.lastSeenAt) ||
        left.id.localeCompare(right.id),
    );
  return { items: items.slice(offset, offset + limit), total: items.length };
}
