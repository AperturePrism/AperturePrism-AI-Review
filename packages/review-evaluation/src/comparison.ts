/**
 * 候选对比：同一批案例做成对 Bootstrap，案例内多个发现始终一起抽样。
 * @example
 * const comparison = compareReviewEvaluations(baseline, candidate, { seed: 4632, samples: 2000 });
 *
 * 区间只描述这份人工数据集的抽样不确定性，不保证换仓库后的效果。
 */
import { compareEvaluationText } from "./dataset.js";

import { canonicalJson } from "./dataset.js";
import {
  reviewMetrics,
  type CaseScore,
  type ReviewEvaluation,
  type ReviewMetrics,
} from "./score.js";

export type ConfidenceInterval = {
  low: number | null;
  high: number | null;
  confidence: number;
  validSamples: number;
  samples: number;
  seed: number;
};

export type ComparisonOptions = {
  samples?: number;
  seed?: number;
  confidence?: number;
};
export type ReviewComparison = {
  version: 1;
  datasetHash: string;
  baselineRunId: string;
  candidateRunId: string;
  pairedCases: number;
  delta: {
    precision: number | null;
    recall: number | null;
    f1: number | null;
    weightedF1: number | null;
    macroF1: number | null;
    costMicros: number | null;
    p95Ms: number | null;
    failedCases: number;
    missingCases: number;
  };
  intervals: {
    f1: ConfidenceInterval;
    weightedF1: ConfidenceInterval;
    precision: ConfidenceInterval;
    recall: ConfidenceInterval;
  };
  changedCases: {
    caseId: string;
    baselineF1: number | null;
    candidateF1: number | null;
    deltaF1: number | null;
    baselineFalsePositives: number;
    candidateFalsePositives: number;
    baselineFalseNegatives: number;
    candidateFalseNegatives: number;
  }[];
  outcome: "improvement" | "regression" | "inconclusive";
  warnings: string[];
};

/** 小型固定 seed 随机源，结果不依赖系统随机性或并发顺序。 */
export function seededEvaluationRandom(seed: number): () => number {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff)
    throw new RangeError("seed must be an unsigned 32-bit integer");
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function delta(
  candidate: number | null,
  baseline: number | null,
): number | null {
  return candidate === null || baseline === null ? null : candidate - baseline;
}

function quantile(
  sorted: readonly number[],
  proportion: number,
): number | null {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * proportion;
  const below = Math.floor(position);
  const above = Math.ceil(position);
  return (
    sorted[below]! + (sorted[above]! - sorted[below]!) * (position - below)
  );
}

function aggregate(
  cases: readonly CaseScore[],
  indices: readonly number[],
  weighted = false,
): ReviewMetrics {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (const index of indices) {
    const metrics = weighted ? cases[index]!.weighted : cases[index]!.metrics;
    truePositive += metrics.truePositive;
    falsePositive += metrics.falsePositive;
    falseNegative += metrics.falseNegative;
  }
  return reviewMetrics(truePositive, falsePositive, falseNegative);
}

/** 不允许不同数据集、不同过滤条件或不同匹配规则的成绩直接相减。 */
export function compareReviewEvaluations(
  baseline: ReviewEvaluation,
  candidate: ReviewEvaluation,
  options: ComparisonOptions = {},
): ReviewComparison {
  if (baseline.datasetHash !== candidate.datasetHash)
    throw new RangeError("cannot compare different dataset versions");
  if (
    baseline.split !== candidate.split ||
    canonicalJson(baseline.options) !== canonicalJson(candidate.options)
  )
    throw new RangeError(
      "comparison requires identical split and scoring options",
    );
  const baselineCases = [...baseline.cases].sort((left, right) =>
    compareEvaluationText(left.caseId, right.caseId),
  );
  const candidateCases = [...candidate.cases].sort((left, right) =>
    compareEvaluationText(left.caseId, right.caseId),
  );
  if (
    !baselineCases.length ||
    canonicalJson(baselineCases.map((item) => item.caseId)) !==
      canonicalJson(candidateCases.map((item) => item.caseId))
  )
    throw new RangeError("comparison requires the same non-empty case set");
  const samples = options.samples ?? 2_000;
  const seed = options.seed ?? 4632;
  const confidence = options.confidence ?? 0.95;
  if (!Number.isSafeInteger(samples) || samples < 100 || samples > 20_000)
    throw new RangeError("bootstrap samples must be between 100 and 20000");
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1)
    throw new RangeError("confidence must be between 0 and 1");
  if (samples * baselineCases.length > 20_000_000)
    throw new RangeError(
      "bootstrap workload exceeds 20000000 sampled cases; reduce samples or dataset size",
    );
  const random = seededEvaluationRandom(seed);
  const distributions = {
    f1: [] as number[],
    weightedF1: [] as number[],
    precision: [] as number[],
    recall: [] as number[],
  };
  for (let sample = 0; sample < samples; sample += 1) {
    const indices = Array.from({ length: baselineCases.length }, () =>
      Math.floor(random() * baselineCases.length),
    );
    const left = aggregate(baselineCases, indices);
    const right = aggregate(candidateCases, indices);
    const leftWeighted = aggregate(baselineCases, indices, true);
    const rightWeighted = aggregate(candidateCases, indices, true);
    for (const metric of ["f1", "precision", "recall"] as const) {
      const difference = delta(right[metric], left[metric]);
      if (difference !== null) distributions[metric].push(difference);
    }
    const weightedDifference = delta(rightWeighted.f1, leftWeighted.f1);
    if (weightedDifference !== null)
      distributions.weightedF1.push(weightedDifference);
  }
  const interval = (values: number[]): ConfidenceInterval => {
    values.sort((left, right) => left - right);
    return {
      low: quantile(values, (1 - confidence) / 2),
      high: quantile(values, 1 - (1 - confidence) / 2),
      confidence,
      validSamples: values.length,
      samples,
      seed,
    };
  };
  const intervals = {
    f1: interval(distributions.f1),
    weightedF1: interval(distributions.weightedF1),
    precision: interval(distributions.precision),
    recall: interval(distributions.recall),
  };
  const warnings: string[] = [];
  if (baselineCases.length < 20) warnings.push("fewer_than_20_cases");
  if (Object.values(intervals).some((value) => value.validSamples < samples))
    warnings.push("some_bootstrap_samples_have_undefined_metrics");
  if (baseline.performance.currency !== candidate.performance.currency)
    warnings.push("cost_currency_mismatch");
  if (
    baseline.performance.currency === null ||
    candidate.performance.currency === null
  )
    warnings.push("cost_currency_is_unknown");
  const changedCases = baselineCases
    .map((left, index) => {
      const right = candidateCases[index]!;
      return {
        caseId: left.caseId,
        baselineF1: left.metrics.f1,
        candidateF1: right.metrics.f1,
        deltaF1: delta(right.metrics.f1, left.metrics.f1),
        baselineFalsePositives: left.metrics.falsePositive,
        candidateFalsePositives: right.metrics.falsePositive,
        baselineFalseNegatives: left.metrics.falseNegative,
        candidateFalseNegatives: right.metrics.falseNegative,
      };
    })
    .filter(
      (item) =>
        (item.deltaF1 !== null && item.deltaF1 !== 0) ||
        item.baselineFalsePositives !== item.candidateFalsePositives ||
        item.baselineFalseNegatives !== item.candidateFalseNegatives,
    );
  return {
    version: 1,
    datasetHash: baseline.datasetHash,
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    pairedCases: baselineCases.length,
    delta: {
      precision: delta(candidate.metrics.precision, baseline.metrics.precision),
      recall: delta(candidate.metrics.recall, baseline.metrics.recall),
      f1: delta(candidate.metrics.f1, baseline.metrics.f1),
      weightedF1: delta(candidate.weighted.f1, baseline.weighted.f1),
      macroF1: delta(candidate.macroF1, baseline.macroF1),
      costMicros:
        baseline.performance.currency !== null &&
        baseline.performance.currency === candidate.performance.currency
          ? delta(
              candidate.performance.costMicros,
              baseline.performance.costMicros,
            )
          : null,
      p95Ms: delta(candidate.performance.p95Ms, baseline.performance.p95Ms),
      failedCases: candidate.failedCases - baseline.failedCases,
      missingCases: candidate.missingCases - baseline.missingCases,
    },
    intervals,
    changedCases,
    outcome:
      intervals.f1.low !== null && intervals.f1.low > 0
        ? "improvement"
        : intervals.f1.high !== null && intervals.f1.high < 0
          ? "regression"
          : "inconclusive",
    warnings,
  };
}
