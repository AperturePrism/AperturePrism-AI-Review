import { describe, expect, it } from "vitest";
import type { Evaluation, EvaluationResult } from "./types.js";
import { makeHarness } from "./test-fixture.js";

describe("离线模型评估", () => {
  it("计算微平均精确率、召回率和F1，同时保留逐例错漏", async () => {
    const { call } = await makeHarness();
    const evaluation = await call<Evaluation>("evaluations.create", {
      name: "基准",
      model: "local",
      reference: "run-1",
      cases: [
        {
          name: "混合",
          expected: ["auth", "injection"],
          observed: ["auth", "style"],
          weight: 1,
        },
      ],
    });
    const result = await call<EvaluationResult>("evaluations.result", {
      id: evaluation.id,
    });
    expect(result).toMatchObject({
      truePositive: 1,
      falsePositive: 1,
      falseNegative: 1,
      precision: 0.5,
      recall: 0.5,
      f1: 0.5,
      passedCases: 0,
    });
    expect(result.cases[0]).toMatchObject({
      matched: ["auth"],
      extra: ["style"],
      missed: ["injection"],
    });
  });

  it("干净用例的空输出记为通过，漏报不因无输出被视为完美", async () => {
    const { call } = await makeHarness();
    const clean = await call<Evaluation>("evaluations.create", {
      name: "干净",
      model: "local",
      reference: "run",
      cases: [{ name: "干净", expected: [], observed: [] }],
    });
    expect(await call("evaluations.result", { id: clean.id })).toMatchObject({
      f1: 1,
      passedCases: 1,
    });
    const missed = await call<Evaluation>("evaluations.create", {
      name: "漏报",
      model: "local",
      reference: "run",
      cases: [{ name: "有问题", expected: ["auth"], observed: [] }],
    });
    expect(await call("evaluations.result", { id: missed.id })).toMatchObject({
      f1: 0,
      recall: 0,
      falseNegative: 1,
    });
  });

  it("用例权重单独计算，不通过重复标签刷分", async () => {
    const { call } = await makeHarness();
    const evaluation = await call<Evaluation>("evaluations.create", {
      name: "权重",
      model: "local",
      reference: "run",
      cases: [
        {
          name: "重要",
          expected: ["auth", "auth"],
          observed: ["auth", "auth"],
          weight: 3,
        },
        { name: "普通", expected: ["style"], observed: [], weight: 1 },
      ],
    });
    const result = await call<EvaluationResult>("evaluations.result", {
      id: evaluation.id,
    });
    expect(result.weightedScore).toBe(0.75);
    expect(result.truePositive).toBe(1);
  });

  it("对照同一数据集时列出改进和回退", async () => {
    const { call } = await makeHarness();
    const cases = [
      { id: "one", name: "一", expected: ["auth"], observed: ["auth"] },
      { id: "two", name: "二", expected: ["sql"], observed: [] },
    ];
    const before = await call<Evaluation>("evaluations.create", {
      name: "旧版",
      model: "old",
      reference: "old",
      cases,
    });
    const after = await call<Evaluation>("evaluations.create", {
      name: "新版",
      model: "new",
      reference: "new",
      cases: [
        { ...cases[0], observed: [] },
        { ...cases[1], observed: ["sql"] },
      ],
    });
    expect(
      await call("evaluations.compare", { id: before.id, otherId: after.id }),
    ).toMatchObject({
      regressions: ["one"],
      improvements: ["two"],
      delta: { f1: 0 },
    });
  });

  it("预期标签或权重不同的数据集不能做误导性对比", async () => {
    const { call } = await makeHarness();
    const before = await call<Evaluation>("evaluations.create", {
      name: "旧",
      model: "old",
      reference: "old",
      cases: [{ name: "一", expected: ["a"], observed: [] }],
    });
    const after = await call<Evaluation>("evaluations.create", {
      name: "新",
      model: "new",
      reference: "new",
      cases: [{ name: "一", expected: ["b"], observed: [] }],
    });
    await expect(
      call("evaluations.compare", { id: before.id, otherId: after.id }),
    ).rejects.toMatchObject({ code: "evaluation_mismatch" });
  });

  it("空数据集、重复id、零权重均不保存", async () => {
    const { call } = await makeHarness();
    const base = { name: "无效", model: "local", reference: "run" };
    await expect(
      call("evaluations.create", { ...base, cases: [] }),
    ).rejects.toMatchObject({ code: "empty_evaluation" });
    await expect(
      call("evaluations.create", {
        ...base,
        cases: [
          { id: "same", name: "一", weight: 1 },
          { id: "same", name: "二", weight: 1 },
        ],
      }),
    ).rejects.toMatchObject({ code: "duplicate_case" });
    await expect(
      call("evaluations.create", {
        ...base,
        cases: [{ name: "一", weight: 0 }],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
