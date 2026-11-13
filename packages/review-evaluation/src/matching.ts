/**
 * 发现匹配：规则、文件和行范围共同确定同一问题，重复报告不会多拿分。
 * @example
 * matchReviewFindings(expected, predicted, { lineTolerance: 3, ruleAliases: { "old-rule": "new-rule" } });
 *
 * 使用增广路径取得最大匹配数，避免贪心先占掉一个位置导致另一条真发现被漏算。
 */
import { compareEvaluationText } from "./dataset.js";

import { type ExpectedFinding } from "./dataset.js";
import { type PredictedFinding } from "./prediction.js";

export type FindingMatchOptions = {
  lineTolerance?: number;
  ruleAliases?: Readonly<Record<string, string>>;
  minimumConfidence?: number;
};

export type FindingMatch = {
  expectedId: string;
  predictedId: string;
  lineDistance: number;
  severityCorrect: boolean;
};

export type FindingMatching = {
  matched: FindingMatch[];
  missed: ExpectedFinding[];
  falsePositives: PredictedFinding[];
  knownNegatives: FindingMatch[];
  ignoredLowConfidence: PredictedFinding[];
};

/** 两段行范围相交时距离为 0；整段从第 10 行移到第 12 行时可用容忍值匹配。 */
export function lineRangeDistance(
  left: { startLine: number; endLine: number },
  right: { startLine: number; endLine: number },
): number {
  return Math.max(
    0,
    left.startLine - right.endLine,
    right.startLine - left.endLine,
  );
}

export function resolveRuleAliases(
  aliases: Readonly<Record<string, string>>,
): Map<string, string> {
  if (typeof aliases !== "object" || aliases === null || Array.isArray(aliases))
    throw new RangeError("rule aliases must be an object");
  if (Object.keys(aliases).length > 1_000)
    throw new RangeError("too many rule aliases");
  const result = new Map<string, string>();
  for (const key of Object.keys(aliases)) {
    const visited = new Set<string>();
    let current = key;
    while (Object.hasOwn(aliases, current)) {
      if (visited.has(current))
        throw new RangeError("rule aliases contain a cycle");
      visited.add(current);
      const target = aliases[current];
      if (typeof target !== "string" || !target.trim())
        throw new RangeError("rule alias target must be non-empty text");
      if (target === current) break;
      current = target;
    }
    result.set(key, current);
  }
  return result;
}

/** 已匹配正例后，再识别已知误报标签；已知误报仍计入 falsePositives。 */
export function matchReviewFindings(
  expected: readonly ExpectedFinding[],
  predicted: readonly PredictedFinding[],
  options: FindingMatchOptions = {},
): FindingMatching {
  const tolerance = options.lineTolerance ?? 3;
  const confidence = options.minimumConfidence ?? 0;
  if (!Number.isSafeInteger(tolerance) || tolerance < 0 || tolerance > 10_000)
    throw new RangeError("lineTolerance must be between 0 and 10000");
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    throw new RangeError("minimumConfidence must be between 0 and 1");
  const aliases = resolveRuleAliases(options.ruleAliases ?? {});
  const rule = (id: string) => aliases.get(id) ?? id;
  const positives = expected
    .filter((finding) => finding.label === "positive")
    .sort((left, right) => compareEvaluationText(left.id, right.id));
  const negatives = expected
    .filter((finding) => finding.label === "negative")
    .sort((left, right) => compareEvaluationText(left.id, right.id));
  const eligible = predicted
    .filter((finding) => finding.confidence >= confidence)
    .sort((left, right) => compareEvaluationText(left.id, right.id));
  const compatible = (label: ExpectedFinding, finding: PredictedFinding) =>
    rule(label.ruleId) === rule(finding.ruleId) &&
    label.path === finding.path &&
    lineRangeDistance(label, finding) <= tolerance;
  const connect = (
    labels: readonly ExpectedFinding[],
    findings: readonly PredictedFinding[],
  ): Map<number, number> => {
    const owners = new Map<number, number>();
    const adjacency = labels.map((label) =>
      findings
        .map((finding, index) => ({ finding, index }))
        .filter(({ finding }) => compatible(label, finding))
        .sort(
          (left, right) =>
            lineRangeDistance(label, left.finding) -
              lineRangeDistance(label, right.finding) ||
            Number(right.finding.severity === label.severity) -
              Number(left.finding.severity === label.severity) ||
            compareEvaluationText(left.finding.id, right.finding.id),
        )
        .map(({ index }) => index),
    );
    const findFree = (labelIndex: number, visited: Set<number>): boolean => {
      for (const findingIndex of adjacency[labelIndex]!) {
        if (visited.has(findingIndex)) continue;
        visited.add(findingIndex);
        const owner = owners.get(findingIndex);
        if (owner === undefined || findFree(owner, visited)) {
          owners.set(findingIndex, labelIndex);
          return true;
        }
      }
      return false;
    };
    labels.forEach((_label, index) => {
      findFree(index, new Set());
    });
    return owners;
  };
  const pairs = connect(positives, eligible);
  const matchedExpected = new Set([...pairs.values()]);
  const match = (
    label: ExpectedFinding,
    finding: PredictedFinding,
  ): FindingMatch => ({
    expectedId: label.id,
    predictedId: finding.id,
    lineDistance: lineRangeDistance(label, finding),
    severityCorrect: label.severity === finding.severity,
  });
  const falsePositives = eligible.filter(
    (_finding, index) => !pairs.has(index),
  );
  const knownNegativePairs = connect(negatives, falsePositives);
  return {
    matched: [...pairs]
      .map(([predictionIndex, labelIndex]) =>
        match(positives[labelIndex]!, eligible[predictionIndex]!),
      )
      .sort((left, right) =>
        compareEvaluationText(left.expectedId, right.expectedId),
      ),
    missed: positives.filter((_label, index) => !matchedExpected.has(index)),
    falsePositives,
    knownNegatives: [...knownNegativePairs].map(
      ([predictionIndex, labelIndex]) =>
        match(negatives[labelIndex]!, falsePositives[predictionIndex]!),
    ),
    ignoredLowConfidence: predicted.filter(
      (finding) => finding.confidence < confidence,
    ),
  };
}
