/**
 * 审查评分：逐案例匹配、严重度加权、成本与延迟统计从同一结果推导。
 * @example
 * const result = evaluateReviewRun(dataset, run, { split: "test", lineTolerance: 3 });
 * console.log(result.metrics.f1, result.weighted.f1, result.performance.p95Ms);
 */
import { compareEvaluationText } from "./dataset.js";

import {
  EVALUATION_SEVERITIES,
  EvaluationInputError,
  type DatasetSplit,
  type EvaluationSeverity,
  type ReviewDataset,
} from "./dataset.js";
import {
  matchReviewFindings,
  resolveRuleAliases,
  type FindingMatching,
  type FindingMatchOptions,
} from "./matching.js";
import { type PredictionRun } from "./prediction.js";

export type ReviewMetrics = {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
};

export type EvaluationPrice = {
  currency: string;
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
};

export type CaseScore = FindingMatching & {
  caseId: string;
  repository: string;
  split: DatasetSplit;
  missingPrediction: boolean;
  errorCategory: string | null;
  metrics: ReviewMetrics;
  weighted: ReviewMetrics;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  costMicros: number | null;
  perfect: boolean;
};

export type ReviewEvaluation = {
  version: 1;
  datasetId: string;
  datasetHash: string;
  runId: string;
  runHash: string;
  model: string;
  policyVersion: string;
  split: DatasetSplit | "all";
  options: {
    lineTolerance: number;
    minimumConfidence: number;
    ruleAliases: Readonly<Record<string, string>>;
    severityWeights: Record<EvaluationSeverity, number>;
  };
  metrics: ReviewMetrics;
  weighted: ReviewMetrics;
  macroF1: number | null;
  perfectCases: number;
  caseCount: number;
  missingCases: number;
  failedCases: number;
  knownNegativeHits: number;
  severityAccuracy: number | null;
  bySeverity: Record<EvaluationSeverity, ReviewMetrics>;
  byRule: Record<string, ReviewMetrics>;
  severityConfusion: Record<
    EvaluationSeverity,
    Record<EvaluationSeverity, number>
  >;
  performance: {
    completedCases: number;
    inputTokens: number;
    outputTokens: number;
    costMicros: number | null;
    knownCostMicros: number;
    currency: string | null;
    totalDurationMs: number;
    averageDurationMs: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
  };
  cases: CaseScore[];
};

export type EvaluationOptions = FindingMatchOptions & {
  split?: DatasetSplit | "all";
  severityWeights?: Partial<Record<EvaluationSeverity, number>>;
  price?: EvaluationPrice;
  currency?: string;
};

export const DEFAULT_SEVERITY_WEIGHTS: Record<EvaluationSeverity, number> = {
  critical: 16,
  high: 8,
  medium: 4,
  low: 2,
  info: 1,
};

/** 没有正例也没有预测时，指标未定义，返回 null，不能制造一个虚高的 100%。 */
export function reviewMetrics(
  truePositive: number,
  falsePositive: number,
  falseNegative: number,
): ReviewMetrics {
  const precision =
    truePositive + falsePositive > 0
      ? truePositive / (truePositive + falsePositive)
      : null;
  const recall =
    truePositive + falseNegative > 0
      ? truePositive / (truePositive + falseNegative)
      : null;
  const denominator = 2 * truePositive + falsePositive + falseNegative;
  return {
    truePositive,
    falsePositive,
    falseNegative,
    precision,
    recall,
    f1: denominator > 0 ? (2 * truePositive) / denominator : null,
  };
}

/** 最近秩分位数：小数据集不会凭插值编出从没出现过的延迟。 */
export function evaluationPercentile(
  values: readonly number[],
  percentile: number,
): number | null {
  if (!Number.isFinite(percentile) || percentile < 0 || percentile > 1)
    throw new RangeError("percentile must be between 0 and 1");
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)]!;
}

function addSafe(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value))
    throw new RangeError("evaluation count exceeds safe integer range");
  return value;
}

function priceCost(
  input: number,
  output: number,
  price: EvaluationPrice,
): number {
  const numerator =
    BigInt(input) * BigInt(price.inputMicrosPerMillion) +
    BigInt(output) * BigInt(price.outputMicrosPerMillion);
  const amount = (numerator + 999_999n) / 1_000_000n;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError("evaluation cost exceeds safe integer range");
  return Number(amount);
}

/** 数据集哈希不相等就拒绝评分，避免用旧标签评价新上下文。 */
export function evaluateReviewRun(
  dataset: ReviewDataset,
  run: PredictionRun,
  options: EvaluationOptions = {},
): ReviewEvaluation {
  if (run.datasetHash !== dataset.hash)
    throw new EvaluationInputError(
      "prediction dataset hash does not match this dataset version",
    );
  const split = options.split ?? "all";
  const currency = options.currency ?? options.price?.currency ?? null;
  if (currency !== null && !/^[A-Z]{3}$/.test(currency))
    throw new RangeError("currency must be uppercase ISO style code");
  if (
    options.currency &&
    options.price &&
    options.currency !== options.price.currency
  )
    throw new RangeError("price and report currencies must match");
  if (!["all", "train", "validation", "test"].includes(split))
    throw new RangeError("unknown evaluation split");
  const weights = { ...DEFAULT_SEVERITY_WEIGHTS, ...options.severityWeights };
  for (const weight of Object.values(weights))
    if (!Number.isSafeInteger(weight) || weight < 1 || weight > 1_000)
      throw new RangeError(
        "severity weights must be integers between 1 and 1000",
      );
  if (options.price) {
    if (!/^[A-Z]{3}$/.test(options.price.currency))
      throw new RangeError("price currency must be uppercase ISO style code");
    for (const value of [
      options.price.inputMicrosPerMillion,
      options.price.outputMicrosPerMillion,
    ])
      if (!Number.isSafeInteger(value) || value < 0)
        throw new RangeError("prices must be non-negative safe integer micros");
  }
  const datasetIds = new Set(dataset.cases.map((item) => item.id));
  const unknown = run.records.find((record) => !datasetIds.has(record.caseId));
  if (unknown)
    throw new EvaluationInputError(
      `prediction references unknown case ${unknown.caseId}`,
    );
  const records = new Map(run.records.map((record) => [record.caseId, record]));
  const ruleNames = resolveRuleAliases(options.ruleAliases ?? {});
  const selected = dataset.cases.filter(
    (item) => split === "all" || item.split === split,
  );
  if (!selected.length)
    throw new EvaluationInputError("selected dataset split is empty");
  const selectedIds = new Set(selected.map((item) => item.id));
  const counts = () => ({
    truePositive: 0,
    falsePositive: 0,
    falseNegative: 0,
  });
  const total = counts();
  const weightedTotal = counts();
  const severityCounts = Object.fromEntries(
    EVALUATION_SEVERITIES.map((severity) => [severity, counts()]),
  ) as Record<EvaluationSeverity, ReturnType<typeof counts>>;
  const ruleCounts = new Map<string, ReturnType<typeof counts>>();
  const severityConfusion = Object.fromEntries(
    EVALUATION_SEVERITIES.map((severity) => [
      severity,
      Object.fromEntries(
        EVALUATION_SEVERITIES.map((predicted) => [predicted, 0]),
      ),
    ]),
  ) as Record<EvaluationSeverity, Record<EvaluationSeverity, number>>;
  let matchedSeverity = 0;
  const cases = selected.map((item): CaseScore => {
    const record = records.get(item.id);
    const matching = matchReviewFindings(
      item.expected,
      record?.findings ?? [],
      options,
    );
    const expectedById = new Map(
      item.expected.map((finding) => [finding.id, finding]),
    );
    const predictedById = new Map(
      (record?.findings ?? []).map((finding) => [finding.id, finding]),
    );
    const weighted = counts();
    const ruleCount = (id: string) => {
      const canonical = ruleNames.get(id) ?? id;
      const current = ruleCounts.get(canonical) ?? counts();
      ruleCounts.set(canonical, current);
      return current;
    };
    for (const match of matching.matched) {
      const expected = expectedById.get(match.expectedId)!;
      const predicted = predictedById.get(match.predictedId)!;
      weighted.truePositive += weights[expected.severity];
      severityCounts[expected.severity].truePositive += 1;
      ruleCount(expected.ruleId).truePositive += 1;
      severityConfusion[expected.severity][predicted.severity] += 1;
      if (match.severityCorrect) matchedSeverity += 1;
    }
    for (const missed of matching.missed) {
      weighted.falseNegative += weights[missed.severity];
      severityCounts[missed.severity].falseNegative += 1;
      ruleCount(missed.ruleId).falseNegative += 1;
    }
    for (const extra of matching.falsePositives) {
      weighted.falsePositive += weights[extra.severity];
      severityCounts[extra.severity].falsePositive += 1;
      ruleCount(extra.ruleId).falsePositive += 1;
    }
    total.truePositive += matching.matched.length;
    total.falseNegative += matching.missed.length;
    total.falsePositive += matching.falsePositives.length;
    weightedTotal.truePositive += weighted.truePositive;
    weightedTotal.falseNegative += weighted.falseNegative;
    weightedTotal.falsePositive += weighted.falsePositive;
    return {
      ...matching,
      caseId: item.id,
      repository: item.repository,
      split: item.split,
      missingPrediction: !record,
      errorCategory: record?.errorCategory ?? null,
      metrics: reviewMetrics(
        matching.matched.length,
        matching.falsePositives.length,
        matching.missed.length,
      ),
      weighted: reviewMetrics(
        weighted.truePositive,
        weighted.falsePositive,
        weighted.falseNegative,
      ),
      durationMs: record?.durationMs ?? null,
      inputTokens: record?.inputTokens ?? 0,
      outputTokens: record?.outputTokens ?? 0,
      costMicros:
        record?.costMicros ??
        (record && options.price
          ? priceCost(record.inputTokens, record.outputTokens, options.price)
          : null),
      perfect: Boolean(
        record &&
        !record.errorCategory &&
        matching.missed.length === 0 &&
        matching.falsePositives.length === 0,
      ),
    };
  });
  const latencies = cases
    .filter((item) => item.durationMs !== null)
    .map((item) => item.durationMs!);
  const totalDurationMs = latencies.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(totalDurationMs))
    throw new RangeError("total duration overflow");
  const knownCostMicros = cases.reduce(
    (sum, item) => addSafe(sum, item.costMicros ?? 0),
    0,
  );
  const macro = cases
    .map((item) => item.metrics.f1)
    .filter((value): value is number => value !== null);
  return {
    version: 1,
    datasetId: dataset.id,
    datasetHash: dataset.hash,
    runId: run.id,
    runHash: run.hash,
    model: run.model,
    policyVersion: run.policyVersion,
    split,
    options: {
      lineTolerance: options.lineTolerance ?? 3,
      minimumConfidence: options.minimumConfidence ?? 0,
      ruleAliases: { ...(options.ruleAliases ?? {}) },
      severityWeights: weights,
    },
    metrics: reviewMetrics(
      total.truePositive,
      total.falsePositive,
      total.falseNegative,
    ),
    weighted: reviewMetrics(
      weightedTotal.truePositive,
      weightedTotal.falsePositive,
      weightedTotal.falseNegative,
    ),
    macroF1: macro.length
      ? macro.reduce((sum, value) => sum + value, 0) / macro.length
      : null,
    perfectCases: cases.filter((item) => item.perfect).length,
    caseCount: cases.length,
    missingCases: cases.filter((item) => item.missingPrediction).length,
    failedCases: cases.filter((item) => item.errorCategory !== null).length,
    knownNegativeHits: cases.reduce(
      (sum, item) => sum + item.knownNegatives.length,
      0,
    ),
    severityAccuracy: total.truePositive
      ? matchedSeverity / total.truePositive
      : null,
    bySeverity: Object.fromEntries(
      EVALUATION_SEVERITIES.map((severity) => {
        const item = severityCounts[severity];
        return [
          severity,
          reviewMetrics(
            item.truePositive,
            item.falsePositive,
            item.falseNegative,
          ),
        ];
      }),
    ) as Record<EvaluationSeverity, ReviewMetrics>,
    byRule: Object.fromEntries(
      [...ruleCounts]
        .sort(([left], [right]) => compareEvaluationText(left, right))
        .map(([rule, count]) => [
          rule,
          reviewMetrics(
            count.truePositive,
            count.falsePositive,
            count.falseNegative,
          ),
        ]),
    ),
    severityConfusion,
    performance: {
      completedCases: run.records.filter(
        (record) => selectedIds.has(record.caseId) && !record.errorCategory,
      ).length,
      inputTokens: cases.reduce(
        (sum, item) => addSafe(sum, item.inputTokens),
        0,
      ),
      outputTokens: cases.reduce(
        (sum, item) => addSafe(sum, item.outputTokens),
        0,
      ),
      costMicros: cases.every((item) => item.costMicros !== null)
        ? knownCostMicros
        : null,
      knownCostMicros,
      currency,
      totalDurationMs,
      averageDurationMs: latencies.length
        ? totalDurationMs / latencies.length
        : null,
      p50Ms: evaluationPercentile(latencies, 0.5),
      p95Ms: evaluationPercentile(latencies, 0.95),
      p99Ms: evaluationPercentile(latencies, 0.99),
    },
    cases,
  };
}
