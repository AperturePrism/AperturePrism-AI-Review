/**
 * 离线评估只比较预期标签与观察标签，不调用付费模型，也不运行用例中的代码。
 * @example createEvaluation(context,{name:'模型对照',model:'local',reference:'run-1',cases:[{name:'鉴权',expected:['auth'],observed:['auth'],weight:1}]});
 */
import type { Evaluation, EvaluationCase, EvaluationResult } from "./types.js";
import { audit, identity, type CommandContext } from "./audit.js";
import {
  array,
  findRecord,
  object,
  optionalText,
  strings,
  text,
  WorkbenchError,
} from "./utils/input.js";

function parseCases(value: unknown): EvaluationCase[] {
  const cases = array(value, "cases", 5000).map((raw, index) => {
    const input = object(raw, "case");
    const weight = input.weight ?? 1;
    if (
      typeof weight !== "number" ||
      !Number.isFinite(weight) ||
      weight <= 0 ||
      weight > 1000
    )
      throw new WorkbenchError(
        "invalid_input",
        "weight 必须大于 0 且不超过 1000",
      );
    return {
      id:
        input.id === undefined
          ? `case-${index + 1}`
          : text(input.id, "case.id", 100),
      name: text(input.name, "case.name", 300),
      expected: strings(input.expected, "expected", 1000, 300),
      observed: strings(input.observed, "observed", 1000, 300),
      weight,
    };
  });
  if (!cases.length)
    throw new WorkbenchError("empty_evaluation", "评估至少需要一个用例");
  if (new Set(cases.map((item) => item.id)).size !== cases.length)
    throw new WorkbenchError("duplicate_case", "用例 id 不能重复");
  return cases;
}

export function createEvaluation(
  context: CommandContext,
  input: Record<string, unknown>,
): Evaluation {
  const evaluation: Evaluation = {
    ...identity(context),
    name: text(input.name, "name", 200),
    model: text(input.model, "model", 300),
    reference: optionalText(input.reference, "reference", 500),
    cases: parseCases(input.cases),
    note: optionalText(input.note, "note", 3000),
  };
  context.data.evaluations.push(evaluation);
  audit(context, "evaluation.created", evaluation.id, {
    cases: evaluation.cases.length,
    model: evaluation.model,
  });
  return evaluation;
}

function metrics(
  truePositive: number,
  falsePositive: number,
  falseNegative: number,
): { precision: number; recall: number; f1: number } {
  if (truePositive === 0 && falsePositive === 0 && falseNegative === 0)
    return { precision: 1, recall: 1, f1: 1 };
  const precision =
    truePositive + falsePositive
      ? truePositive / (truePositive + falsePositive)
      : 0;
  const recall =
    truePositive + falseNegative
      ? truePositive / (truePositive + falseNegative)
      : 0;
  return {
    precision,
    recall,
    f1:
      precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
  };
}

/** 微平均衡量总体发现，权重分数单独衡量业务关键用例。 */
export function evaluateCases(evaluation: Evaluation): EvaluationResult {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let weighted = 0;
  let totalWeight = 0;
  const cases = evaluation.cases.map((item) => {
    const expected = new Set(item.expected);
    const observed = new Set(item.observed);
    const matched = [...observed].filter((label) => expected.has(label));
    const extra = [...observed].filter((label) => !expected.has(label));
    const missed = [...expected].filter((label) => !observed.has(label));
    truePositive += matched.length;
    falsePositive += extra.length;
    falseNegative += missed.length;
    weighted +=
      metrics(matched.length, extra.length, missed.length).f1 * item.weight;
    totalWeight += item.weight;
    return {
      id: item.id,
      matched,
      extra,
      missed,
      passed: extra.length === 0 && missed.length === 0,
    };
  });
  return {
    evaluationId: evaluation.id,
    truePositive,
    falsePositive,
    falseNegative,
    ...metrics(truePositive, falsePositive, falseNegative),
    passedCases: cases.filter((item) => item.passed).length,
    totalCases: cases.length,
    weightedScore: weighted / totalWeight,
    cases,
  };
}

export function evaluationResult(
  context: CommandContext,
  input: Record<string, unknown>,
): EvaluationResult {
  return evaluateCases(
    findRecord(context.data.evaluations, context.repository, input.id),
  );
}

/** 对照模型只能比较同一套 expected；标签发生变化时明确拒绝误导性的对比。 */
export function compareEvaluations(
  context: CommandContext,
  input: Record<string, unknown>,
): {
  before: EvaluationResult;
  after: EvaluationResult;
  delta: {
    precision: number;
    recall: number;
    f1: number;
    weightedScore: number;
  };
  regressions: string[];
  improvements: string[];
} {
  const before = findRecord(
    context.data.evaluations,
    context.repository,
    input.id,
  );
  const after = findRecord(
    context.data.evaluations,
    context.repository,
    input.otherId,
  );
  const oldCases = new Map(before.cases.map((item) => [item.id, item]));
  if (
    before.cases.length !== after.cases.length ||
    after.cases.some((item) => {
      const old = oldCases.get(item.id);
      return (
        !old ||
        JSON.stringify([...old.expected].sort()) !==
          JSON.stringify([...item.expected].sort()) ||
        old.weight !== item.weight
      );
    })
  )
    throw new WorkbenchError(
      "evaluation_mismatch",
      "只可对比同一套预期标签和权重的评估",
      409,
    );
  const previous = evaluateCases(before);
  const current = evaluateCases(after);
  const passed = new Map(previous.cases.map((item) => [item.id, item.passed]));
  return {
    before: previous,
    after: current,
    delta: {
      precision: current.precision - previous.precision,
      recall: current.recall - previous.recall,
      f1: current.f1 - previous.f1,
      weightedScore: current.weightedScore - previous.weightedScore,
    },
    regressions: current.cases
      .filter((item) => passed.get(item.id) && !item.passed)
      .map((item) => item.id),
    improvements: current.cases
      .filter((item) => !passed.get(item.id) && item.passed)
      .map((item) => item.id),
  };
}
