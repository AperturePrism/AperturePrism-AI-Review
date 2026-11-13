/**
 * 审查评估：一条主线完成证据核对、策略、基线、抑制、门禁与报告所需的数据。
 * 调用：const assessment = assessReview(review, context, { policy: { minimumCoverage: 0.9 } });
 * 原始模型契约不变；评估附在 outcome.assessment，便于渐进启用和回滚。
 */
import type { PrReviewContract, Finding } from "./types.js";
import type { RenderedPrContext } from "./context.js";
import {
  compareReviewBaseline,
  findingFingerprint,
  type ReviewBaseline,
  type BaselineComparison,
} from "./baseline.js";
import { measureReviewCoverage, type ReviewCoverage } from "./coverage.js";
import { reviewEvidence, type EvidenceCheck } from "./evidence.js";
import { evaluateReviewGate, type ReviewGate } from "./gate.js";
import { buildReviewPlan, type ReviewPlan } from "./plan.js";
import {
  parseReviewPolicy,
  severityRank,
  type ReviewPolicy,
} from "./policy.js";
import { analyzeChangeRisk, type ChangeRisk } from "./risk.js";
import {
  suppressFindings,
  type FindingSuppression,
  type SuppressionResult,
} from "./suppression.js";
import {
  assignReviewOwners,
  parseCodeOwners,
  type OwnerAssignment,
} from "./owners.js";
import {
  runReviewChecks,
  type ReviewChecksResult,
  type ReviewChecksOptions,
} from "./checks.js";
import {
  analyzeChangeIntelligence,
  type ChangeIntelligence,
  type ChangeIntelligenceOptions,
} from "./intelligence.js";
import { matchPath, normalizeReviewPath } from "./utils/path.js";

export type FindingExclusion = {
  fingerprint: string;
  finding: Finding;
  reason:
    | "excluded_path"
    | "disabled_rule"
    | "low_confidence"
    | "low_severity"
    | "unverified_evidence"
    | "unchanged_line"
    | "existing_finding"
    | "finding_limit";
};
export type ReviewAssessment = {
  version: "review-assessment/v1";
  createdAt: string;
  policy: ReviewPolicy;
  review: PrReviewContract;
  findings: readonly Finding[];
  excluded: readonly FindingExclusion[];
  baseline: BaselineComparison;
  suppressions: SuppressionResult;
  coverage: ReviewCoverage;
  risk: ChangeRisk;
  gate: ReviewGate;
  evidence: readonly EvidenceCheck[];
  plan: ReviewPlan;
  owners: readonly OwnerAssignment[];
  intelligence: ChangeIntelligence;
  checks: ReviewChecksResult;
  warnings: readonly string[];
};
export type ReviewAssessmentOptions = {
  /** 外部配置在入口由 parseReviewPolicy 检查，允许只填需要覆盖的字段。 */
  policy?: unknown;
  baseline?: ReviewBaseline;
  suppressions?: readonly FindingSuppression[];
  codeOwners?: string;
  intelligence?: ChangeIntelligenceOptions;
  checks?: ReviewChecksResult;
  checkOptions?: Omit<ReviewChecksOptions, "sources">;
  now?: Date;
};

/** 应用用户配置时保留每条被排除的发现和具体原因，不静默吞掉模型输出。 */
export function assessReview(
  review: PrReviewContract,
  context: RenderedPrContext,
  options: ReviewAssessmentOptions = {},
): ReviewAssessment {
  const policy = parseReviewPolicy(options.policy);
  const now = options.now ?? new Date();
  const coverage = measureReviewCoverage(context);
  const risk = analyzeChangeRisk(context.diff, policy);
  const plan = buildReviewPlan(context.diff, policy);
  const evidence = reviewEvidence(context, review.findings);
  const comparison = compareReviewBaseline(review.findings, options.baseline);
  const excluded: FindingExclusion[] = [];
  const candidates: Finding[] = [];
  const baselineEntries = comparison.current.slice();
  for (let index = 0; index < review.findings.length; index += 1) {
    const original = review.findings[index]!;
    const finding = {
      ...original,
      severity: policy.severityOverrides[original.rule] ?? original.severity,
    };
    const check = evidence.checks[index]!;
    const path = normalizeReviewPath(finding.file);
    const state = baselineEntries[index]!.state;
    const reason =
      policy.exclude.some((pattern) => matchPath(pattern, path)) ||
      (policy.include.length > 0 &&
        !policy.include.some((pattern) => matchPath(pattern, path)))
        ? "excluded_path"
        : policy.disabledRules.includes(finding.rule)
          ? "disabled_rule"
          : finding.confidence < policy.minimumConfidence
            ? "low_confidence"
            : finding.rule !== "meaningless-change" &&
                severityRank(finding.severity) <
                  severityRank(policy.minimumSeverity)
              ? "low_severity"
              : policy.requireEvidence && !check.verified
                ? "unverified_evidence"
                : policy.requireChangedLine && !check.changedLine
                  ? "unchanged_line"
                  : policy.onlyNewFindings && state === "existing"
                    ? "existing_finding"
                    : null;
    if (reason)
      excluded.push({
        fingerprint: findingFingerprint(finding),
        finding,
        reason,
      });
    else candidates.push(finding);
  }
  const suppressed = suppressFindings(
    candidates,
    options.suppressions ?? [],
    now,
  );
  const sorted = [...suppressed.active].sort(
    (left, right) =>
      severityRank(right.severity) - severityRank(left.severity) ||
      right.confidence - left.confidence ||
      left.file.localeCompare(right.file) ||
      left.afterLine - right.afterLine,
  );
  const findings = sorted.slice(0, policy.maxFindings);
  for (const finding of sorted.slice(policy.maxFindings))
    excluded.push({
      fingerprint: findingFingerprint(finding),
      finding,
      reason: "finding_limit",
    });
  const gate = evaluateReviewGate({
    findings: suppressed.active,
    baseline: comparison,
    coverage,
    policy,
  });
  const ownersConfig = parseCodeOwners(options.codeOwners ?? "");
  const owners = assignReviewOwners(ownersConfig, risk.files);
  const intelligence = analyzeChangeIntelligence(context.diff, {
    ...options.intelligence,
    sources: options.intelligence?.sources ?? context.preloadedFiles ?? [],
  });
  const checks =
    options.checks ??
    ({
      status: "not_run",
      executed: [],
      observations: [],
      filesWithSource: 0,
      filesFromDiffOnly: 0,
      warnings: ["确定性配置检查尚未执行"],
    } as ReviewChecksResult);
  const warnings = [
    ...checks.warnings,
    ...gate.warnings,
    ...intelligence.warnings,
    ...plan.warnings,
    ...ownersConfig.warnings.map(
      (warning) => `CODEOWNERS:${warning.line} ${warning.message}`,
    ),
  ];
  if (suppressed.expired.length)
    warnings.push(`${suppressed.expired.length} 条发现抑制已经到期`);
  if (excluded.some((entry) => entry.reason === "finding_limit"))
    warnings.push("部分发现因报告数量上限未展示，但仍计入质量门禁");
  return {
    version: "review-assessment/v1",
    createdAt: now.toISOString(),
    policy,
    review: structuredClone(review),
    findings,
    excluded,
    baseline: comparison,
    suppressions: suppressed,
    coverage,
    risk,
    gate,
    evidence: evidence.checks,
    plan,
    owners,
    intelligence,
    checks,
    warnings: [...new Set(warnings)],
  };
}

/** 生成发布用契约。原始结果仍留在 assessment.review 中，审计不会丢失。 */
export function assessedReview(assessment: ReviewAssessment): PrReviewContract {
  const tone =
    assessment.gate.status === "failed"
      ? "changes_requested"
      : assessment.gate.status === "incomplete" &&
          assessment.review.overallTone === "approve"
        ? "comment"
        : assessment.review.findings.length > 0 &&
            assessment.findings.length === 0 &&
            assessment.review.overallTone === "changes_requested"
          ? "comment"
          : assessment.review.overallTone;
  return {
    ...assessment.review,
    overallTone: tone,
    findings: [...assessment.findings],
  };
}

/** 异步入口会自动发现并实际执行配置检查；同步入口保留兼容并明确标注未执行。 */
export async function assessReviewWithChecks(
  review: PrReviewContract,
  context: RenderedPrContext,
  options: ReviewAssessmentOptions = {},
): Promise<ReviewAssessment> {
  const checks =
    options.checks ??
    (await runReviewChecks(context.diff, {
      ...options.checkOptions,
      sources: options.intelligence?.sources ?? context.preloadedFiles ?? [],
    }));
  return assessReview(review, context, { ...options, checks });
}
