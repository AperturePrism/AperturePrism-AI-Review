/**
 * 质量门禁：只依赖已核对、未抑制的问题与覆盖数据，输出可解释的通过/阻止原因。
 * 调用：evaluateReviewGate({ findings, baseline, coverage, policy });
 * 门禁不做 GitHub 写操作；发布方自行决定采用 COMMENT 或 REQUEST_CHANGES。
 */
import type { BaselineComparison } from "./baseline.js";
import type { ReviewCoverage } from "./coverage.js";
import type { ReviewPolicy } from "./policy.js";
import type { Finding, FindingSeverity } from "./types.js";
import { findingFingerprint } from "./baseline.js";

export type GateReason = {
  code: "new_critical" | "new_high" | "new_medium" | "incomplete_coverage";
  message: string;
  actual: number;
  limit: number;
};
export type ReviewGate = {
  status: "passed" | "failed" | "incomplete";
  reasons: readonly GateReason[];
  warnings: readonly string[];
  counts: Readonly<Record<FindingSeverity, number>>;
  newCounts: Readonly<Record<FindingSeverity, number>>;
};

/** 新旧问题按出现次数匹配，避免一个旧指纹把多处新增问题全部免除。 */
export function evaluateReviewGate(input: {
  findings: readonly Finding[];
  baseline: BaselineComparison;
  coverage: ReviewCoverage;
  policy: ReviewPolicy;
}): ReviewGate {
  const counts: Record<FindingSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  const newCounts: Record<FindingSeverity, number> = { ...counts };
  const available = new Map<
    string,
    (typeof input.baseline.current)[number][]
  >();
  for (const entry of input.baseline.current) {
    const group = available.get(entry.fingerprint) ?? [];
    group.push(entry);
    available.set(entry.fingerprint, group);
  }
  for (const finding of input.findings) {
    counts[finding.severity] += 1;
    const entry = available.get(findingFingerprint(finding))?.shift();
    const escalated =
      entry?.state === "changed" &&
      entry.previous &&
      severityImpact(finding.severity) >
        severityImpact(entry.previous.severity);
    if (!entry || entry.state === "new" || escalated)
      newCounts[finding.severity] += 1;
  }
  const reasons: GateReason[] = [];
  if (newCounts.critical > input.policy.maxNewCritical)
    reasons.push({
      code: "new_critical",
      message: "新增 critical 问题超过允许数量",
      actual: newCounts.critical,
      limit: input.policy.maxNewCritical,
    });
  if (newCounts.high > input.policy.maxNewHigh)
    reasons.push({
      code: "new_high",
      message: "新增 high 问题超过允许数量",
      actual: newCounts.high,
      limit: input.policy.maxNewHigh,
    });
  if (newCounts.medium > input.policy.maxNewMedium)
    reasons.push({
      code: "new_medium",
      message: "新增 medium 问题超过允许数量",
      actual: newCounts.medium,
      limit: input.policy.maxNewMedium,
    });
  const incomplete =
    input.coverage.changedLineRatio < input.policy.minimumCoverage;
  if (incomplete && input.policy.failOnIncompleteCoverage)
    reasons.push({
      code: "incomplete_coverage",
      message: "本次进入模型的变更覆盖比例低于策略要求",
      actual: input.coverage.changedLineRatio,
      limit: input.policy.minimumCoverage,
    });
  const warnings = incomplete
    ? ["输入上下文覆盖不足；没有问题不等于全部变更已检查"]
    : [];
  if (input.coverage.binaryFiles) warnings.push("二进制变更需要另行检查");
  const failed = reasons.some(
    (reason) => reason.code !== "incomplete_coverage",
  );
  return {
    status: failed ? "failed" : incomplete ? "incomplete" : "passed",
    reasons,
    warnings,
    counts,
    newCounts,
  };
}

/** 这里只服务升级比较，完整等级顺序由策略的 severityRank 对外提供。 */
function severityImpact(severity: FindingSeverity): number {
  return ["info", "low", "medium", "high", "critical"].indexOf(severity);
}
