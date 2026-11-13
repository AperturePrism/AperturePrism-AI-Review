/**
 * 回归门禁：把质量、漏报、成本和不确定性转成可解释的通过/失败条件。
 * @example
 * evaluateReviewGate(result, { minF1: 0.8, minCriticalRecall: 1, maxF1Regression: 0.01 }, { dataset, comparison });
 *
 * 没有对应数据时明确失败；不能把未定义精确率或未知成本当作达到门槛。
 */
import {
  inspectDatasetLeakage,
  inputObject,
  rejectUnknownFields,
  type ReviewDataset,
} from "./dataset.js";
import { type ReviewComparison } from "./comparison.js";
import { type ReviewEvaluation } from "./score.js";

export type ReviewGatePolicy = {
  minCases?: number;
  minPrecision?: number;
  minRecall?: number;
  minF1?: number;
  minWeightedF1?: number;
  minCriticalRecall?: number;
  maxFalsePositives?: number;
  maxMissingCases?: number;
  maxFailedCases?: number;
  maxCostMicros?: number;
  maxP95Ms?: number;
  requireCleanSplits?: boolean;
  maxF1Regression?: number;
  /** 使用成对 Bootstrap 的下界评估回归，避免单次点估计刚好越线。 */
  maxConfidenceRegression?: number;
};

export type GateCheck = {
  id: string;
  passed: boolean;
  actual: number | boolean | null;
  threshold: number | boolean;
  reason: string;
};

export type ReviewGateResult = {
  passed: boolean;
  runId: string;
  datasetHash: string;
  checks: GateCheck[];
  blockers: string[];
};

const POLICY_FIELDS = [
  "minCases",
  "minPrecision",
  "minRecall",
  "minF1",
  "minWeightedF1",
  "minCriticalRecall",
  "maxFalsePositives",
  "maxMissingCases",
  "maxFailedCases",
  "maxCostMicros",
  "maxP95Ms",
  "requireCleanSplits",
  "maxF1Regression",
  "maxConfidenceRegression",
] as const;

/** CLI 与 API 共用同一个配置边界，不能因为字段拼错就悄悄跳过门禁。 */
export function parseReviewGatePolicy(value: unknown): ReviewGatePolicy {
  const object = inputObject(value);
  rejectUnknownFields(object, POLICY_FIELDS);
  for (const [key, item] of Object.entries(object)) {
    if (key === "requireCleanSplits") {
      if (typeof item !== "boolean")
        throw new RangeError("requireCleanSplits must be boolean");
      continue;
    }
    if (typeof item !== "number" || !Number.isFinite(item) || item < 0)
      throw new RangeError(`${key} must be finite and non-negative`);
    if (
      [
        "minPrecision",
        "minRecall",
        "minF1",
        "minWeightedF1",
        "minCriticalRecall",
        "maxF1Regression",
        "maxConfidenceRegression",
      ].includes(key) &&
      item > 1
    )
      throw new RangeError(`${key} must be between 0 and 1`);
    if (
      [
        "minCases",
        "maxFalsePositives",
        "maxMissingCases",
        "maxFailedCases",
        "maxCostMicros",
      ].includes(key) &&
      !Number.isSafeInteger(item)
    )
      throw new RangeError(`${key} must be a safe integer`);
  }
  return { ...object } as ReviewGatePolicy;
}

export function evaluateReviewGate(
  result: ReviewEvaluation,
  policy: ReviewGatePolicy = {},
  context: { dataset?: ReviewDataset; comparison?: ReviewComparison } = {},
): ReviewGateResult {
  const checked = parseReviewGatePolicy(policy);
  const checks: GateCheck[] = [];
  const minimum = (
    id: string,
    actual: number | null,
    threshold: number | undefined,
  ) => {
    if (threshold === undefined) return;
    checks.push({
      id,
      passed: actual !== null && actual >= threshold,
      actual,
      threshold,
      reason:
        actual === null
          ? "metric_is_undefined"
          : actual >= threshold
            ? "minimum_met"
            : "below_minimum",
    });
  };
  const maximum = (
    id: string,
    actual: number | null,
    threshold: number | undefined,
  ) => {
    if (threshold === undefined) return;
    checks.push({
      id,
      passed: actual !== null && actual <= threshold,
      actual,
      threshold,
      reason:
        actual === null
          ? "metric_is_unknown"
          : actual <= threshold
            ? "maximum_met"
            : "above_maximum",
    });
  };
  minimum("case_count", result.caseCount, checked.minCases ?? 1);
  minimum("precision", result.metrics.precision, checked.minPrecision);
  minimum("recall", result.metrics.recall, checked.minRecall);
  minimum("f1", result.metrics.f1, checked.minF1);
  minimum("weighted_f1", result.weighted.f1, checked.minWeightedF1);
  minimum(
    "critical_recall",
    result.bySeverity.critical.recall,
    checked.minCriticalRecall,
  );
  maximum(
    "false_positives",
    result.metrics.falsePositive,
    checked.maxFalsePositives,
  );
  maximum("missing_cases", result.missingCases, checked.maxMissingCases ?? 0);
  maximum("failed_cases", result.failedCases, checked.maxFailedCases ?? 0);
  maximum("cost_micros", result.performance.costMicros, checked.maxCostMicros);
  maximum("p95_ms", result.performance.p95Ms, checked.maxP95Ms);
  if (checked.requireCleanSplits ?? true) {
    const clean =
      context.dataset && context.dataset.hash === result.datasetHash
        ? inspectDatasetLeakage(context.dataset).clean
        : null;
    checks.push({
      id: "clean_splits",
      passed: clean === true,
      actual: clean,
      threshold: true,
      reason:
        clean === null
          ? "matching_dataset_is_required"
          : clean
            ? "no_cross_split_duplicates"
            : "cross_split_data_leakage",
    });
  }
  const comparison = context.comparison;
  if (
    comparison &&
    (comparison.datasetHash !== result.datasetHash ||
      comparison.candidateRunId !== result.runId)
  )
    throw new RangeError("comparison does not describe this candidate result");
  if (checked.maxF1Regression !== undefined)
    minimum(
      "f1_regression",
      comparison?.delta.f1 ?? null,
      -checked.maxF1Regression,
    );
  if (checked.maxConfidenceRegression !== undefined)
    minimum(
      "confidence_regression",
      comparison?.intervals.f1.low ?? null,
      -checked.maxConfidenceRegression,
    );
  return {
    passed: checks.every((check) => check.passed),
    runId: result.runId,
    datasetHash: result.datasetHash,
    checks,
    blockers: checks.filter((check) => !check.passed).map((check) => check.id),
  };
}
