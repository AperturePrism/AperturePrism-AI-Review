/**
 * 把离线评估变成工作台 evaluations.create 可接受的输入，不改其已有标签格式。
 * @example
 * const input = workbenchEvaluationInput(result, "候选模型离线回放");
 * // node scripts/review-workbench.mjs --repository owner/repo --action evaluations.create --input input.json
 *
 * 工作台使用案例级标签指标；这里额外加入执行完成标签，因此其分数不等同发现 F1。
 * 精确发现指标仍以离线 JSON 报告为准，差异原因直接写入 note。
 */
import { type ReviewEvaluation } from "./score.js";
import { evaluationHash } from "./dataset.js";

export type WorkbenchEvaluationInput = {
  name: string;
  model: string;
  reference: string;
  note: string;
  cases: {
    id: string;
    name: string;
    expected: string[];
    observed: string[];
    weight: number;
  }[];
};

export function workbenchEvaluationInput(
  result: ReviewEvaluation,
  name = result.runId,
): WorkbenchEvaluationInput {
  if (!name.trim() || name.length > 200)
    throw new RangeError(
      "workbench evaluation name must contain 1 to 200 characters",
    );
  if (result.cases.length > 5_000)
    throw new RangeError(
      "workbench import supports at most 5000 cases; filter the dataset first",
    );
  return {
    name: name.trim(),
    model: result.model,
    reference: `dataset:${result.datasetHash};run:${result.runHash}`,
    note: `离线发现 F1=${result.metrics.f1 ?? "undefined"};严重度加权 F1=${result.weighted.f1 ?? "undefined"}。工作台标签还包含 execution:completed，案例权重均为1；其标签分数与发现指标不同，精确结果见对应离线报告。`,
    cases: result.cases.map((item) => {
      const expected = [
        "execution:completed",
        ...item.matched.map((match) => `finding:${match.expectedId}`),
        ...item.missed.map((finding) => `finding:${finding.id}`),
      ].sort();
      const observed = [
        ...(!item.missingPrediction && !item.errorCategory
          ? ["execution:completed"]
          : []),
        ...item.matched.map((match) => `finding:${match.expectedId}`),
        ...item.falsePositives.map((finding) => `extra:${finding.id}`),
      ].sort();
      return {
        id:
          item.caseId.length <= 100
            ? item.caseId
            : `case-${evaluationHash(item.caseId).slice(0, 40)}`,
        name: `${item.caseId} (${item.repository})`.slice(0, 300),
        expected,
        observed,
        weight: 1,
      };
    }),
  };
}
