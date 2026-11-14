import { describe, expect, it } from "vitest";
import type { Finding, WorkbenchTrends } from "./types.js";
import { administrator, makeHarness, sampleFinding } from "./test-fixture.js";

describe("真实审查趋势", () => {
  it("固定UTC时间桶，空日期为零，账本重放不增加曲线", async () => {
    const { call, setTime } = await makeHarness();
    const review = {
      source: "pr:1",
      reference: "sha1",
      findings: [sampleFinding],
    };
    setTime("2026-11-11T23:59:00Z");
    await call("review.sync", review);
    await call("review.sync", review);
    setTime("2026-11-13T08:00:00Z");
    const trends = await call<WorkbenchTrends>("trends", { days: 3 });
    expect(trends.daily.map((day) => [day.date, day.reviews])).toEqual([
      ["2026-11-11", 1],
      ["2026-11-12", 0],
      ["2026-11-13", 0],
    ]);
    expect(trends.totals.reviews).toBe(1);
    expect(trends.daily[0]?.gateFail).toBe(1);
  });

  it("统计范围之外的历史审查不混入当前区间", async () => {
    const { call, setTime } = await makeHarness();
    setTime("2026-10-01T00:00:00Z");
    await call("review.sync", {
      source: "pr:1",
      reference: "old",
      findings: [sampleFinding],
    });
    setTime("2026-11-13T00:00:00Z");
    expect(await call("trends", { days: 7 })).toMatchObject({
      totals: { reviews: 0, imported: 0, failRate: 0 },
    });
  });

  it("当前风险按真实负责人和账龄聚合，关闭后不再计入积压", async () => {
    const { call, setTime } = await makeHarness();
    setTime("2026-08-01T00:00:00Z");
    const old = await call<Finding>("findings.create", {
      ...sampleFinding,
      severity: "critical",
    });
    await call("findings.assign", { id: old.id, assignee: "alice" });
    setTime("2026-11-12T00:00:00Z");
    const fresh = await call<Finding>("findings.create", {
      ...sampleFinding,
      path: "other.ts",
    });
    setTime("2026-11-13T00:00:00Z");
    const trends = await call<WorkbenchTrends>("trends");
    expect(trends.aging).toEqual({
      under7Days: 1,
      days7To30: 0,
      days30To90: 0,
      over90Days: 1,
    });
    expect(trends.owners[0]).toMatchObject({ assignee: "alice", critical: 1 });
    await call("findings.transition", {
      id: old.id,
      status: "fixed",
      reason: "修复",
    });
    const after = await call<WorkbenchTrends>("trends");
    expect(after.aging.over90Days).toBe(0);
    expect(after.totals.fixedFindings).toBe(1);
    expect(after.owners.map((owner) => owner.assignee)).not.toContain("alice");
    expect(fresh.id).not.toBe(old.id);
  });

  it("修复时长用真实历史中位数，人工反馈按规则统计", async () => {
    const { call, setTime } = await makeHarness();
    const first = await call<Finding>("findings.create", sampleFinding);
    const second = await call<Finding>("findings.create", {
      ...sampleFinding,
      path: "other.ts",
    });
    setTime("2026-11-13T02:00:00Z");
    await call("findings.transition", {
      id: first.id,
      status: "fixed",
      reason: "修复",
    });
    setTime("2026-11-13T06:00:00Z");
    await call("findings.transition", {
      id: second.id,
      status: "fixed",
      reason: "修复",
    });
    await call("feedback.create", {
      findingId: first.id,
      verdict: "useful",
      comment: "真实风险",
    });
    const trends = await call<WorkbenchTrends>("trends");
    expect(trends.rules[0]).toMatchObject({
      medianFixHours: 4,
      usefulFeedback: 1,
      feedback: 1,
      fixed: 2,
    });
  });

  it("跨仓库数据隔离，日期范围超界在边界拒绝", async () => {
    const { call } = await makeHarness();
    await call(
      "review.sync",
      {
        repository: "private/secret",
        source: "pr:1",
        reference: "sha",
        findings: [sampleFinding],
      },
      administrator,
    );
    expect(await call("trends")).toMatchObject({
      totals: { reviews: 0 },
      rules: [],
      owners: [],
    });
    await expect(call("trends", { days: 0 })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(call("trends", { days: 366 })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});
