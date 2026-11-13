/**
 * 已接受的问题：按指纹或规则/路径暂时隐藏发现，并保留理由、责任人与到期时间。
 * 调用：const rules = parseSuppressions([{ id: "SEC-1", rule: "x", path: "src/**", reason: "...", owner: "@team", expiresAt: "2027-01-01T00:00:00Z" }]);
 *       const result = suppressFindings(findings, rules, new Date());
 * 抑制不会删除原始发现，报告仍可展示抑制记录以供审计。
 */
import { z } from "zod";
import { findingFingerprint } from "./baseline.js";
import type { Finding, FindingSeverity } from "./types.js";
import { findingSeverityLevels } from "./types.js";
import { matchPath, normalizeReviewPath } from "./utils/path.js";

export const suppressionSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    rule: z.string().trim().min(1).max(120).optional(),
    path: z.string().trim().min(1).max(500).optional(),
    severities: z.array(z.enum(findingSeverityLevels)).min(1).max(5).optional(),
    reason: z.string().trim().min(5).max(2_000),
    owner: z.string().trim().min(1).max(200),
    createdAt: z.string().datetime({ offset: true }).optional(),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine(
    (value) =>
      value.fingerprint !== undefined ||
      (value.rule !== undefined && value.path !== undefined),
    {
      message: "抑制规则必须指定发现指纹，或同时指定规则和路径",
    },
  );

export type FindingSuppression = z.infer<typeof suppressionSchema>;
export type SuppressedFinding = {
  finding: Finding;
  fingerprint: string;
  suppression: FindingSuppression;
};
export type SuppressionResult = {
  active: readonly Finding[];
  suppressed: readonly SuppressedFinding[];
  expired: readonly FindingSuppression[];
  unused: readonly FindingSuppression[];
};

/** 检查外部抑制配置，重复 ID 会让审计含糊，因此直接拒绝。 */
export function parseSuppressions(
  value: unknown,
): readonly FindingSuppression[] {
  const parsed = z.array(suppressionSchema).max(2_000).safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `发现抑制配置无效：${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("；")}`,
    );
  }
  const ids = new Set<string>();
  for (const item of parsed.data) {
    if (ids.has(item.id)) throw new Error(`抑制规则 ID 重复：${item.id}`);
    ids.add(item.id);
    if (
      item.createdAt &&
      Date.parse(item.createdAt) >= Date.parse(item.expiresAt)
    ) {
      throw new Error(`抑制规则 ${item.id} 的到期时间必须晚于创建时间`);
    }
  }
  return parsed.data;
}

/** 准确指纹优先；宽泛规则只能在其声明的严重度和路径范围内生效。 */
export function matchesSuppression(
  finding: Finding,
  rule: FindingSuppression,
): boolean {
  if (rule.fingerprint && findingFingerprint(finding) !== rule.fingerprint)
    return false;
  if (rule.rule && rule.rule !== finding.rule) return false;
  if (rule.path && !matchPath(rule.path, normalizeReviewPath(finding.file)))
    return false;
  if (rule.severities && !rule.severities.includes(finding.severity))
    return false;
  return true;
}

/** 分离仍需处理的问题、有效抑制和过期配置，不修改输入数组。 */
export function suppressFindings(
  findings: readonly Finding[],
  rules: readonly FindingSuppression[],
  now = new Date(),
): SuppressionResult {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("抑制检查时间无效");
  const expired = rules.filter((rule) => Date.parse(rule.expiresAt) <= nowMs);
  const activeRules = rules
    .filter((rule) => Date.parse(rule.expiresAt) > nowMs)
    .sort(
      (left, right) =>
        Number(Boolean(right.fingerprint)) - Number(Boolean(left.fingerprint)),
    );
  const used = new Set<string>();
  const active: Finding[] = [];
  const suppressed: SuppressedFinding[] = [];
  for (const finding of findings) {
    const rule = activeRules.find((candidate) =>
      matchesSuppression(finding, candidate),
    );
    if (!rule) {
      active.push(finding);
      continue;
    }
    used.add(rule.id);
    suppressed.push({
      finding,
      fingerprint: findingFingerprint(finding),
      suppression: rule,
    });
  }
  return {
    active,
    suppressed,
    expired,
    unused: activeRules.filter((rule) => !used.has(rule.id)),
  };
}

/** 给运营界面展示即将到期的抑制；时间窗口以毫秒比较，避免跨时区日期偏差。 */
export function expiringSuppressions(
  rules: readonly FindingSuppression[],
  now = new Date(),
  withinDays = 7,
): readonly FindingSuppression[] {
  if (!Number.isFinite(withinDays) || withinDays < 0 || withinDays > 3_650)
    throw new Error("到期提醒天数必须在 0 到 3650 之间");
  const earliest = now.getTime();
  const latest = earliest + withinDays * 86_400_000;
  return rules
    .filter((rule) => {
      const expiry = Date.parse(rule.expiresAt);
      return expiry > earliest && expiry <= latest;
    })
    .sort(
      (left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt),
    );
}

/** 把按严重度的抑制数量提供给报告，不把已接受的问题算成已修复。 */
export function suppressionCounts(
  result: SuppressionResult,
): Readonly<Record<FindingSeverity, number>> {
  const counts: Record<FindingSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const item of result.suppressed) counts[item.finding.severity] += 1;
  return counts;
}
