import { describe, expect, it } from "vitest";
import type { Policy } from "./types.js";
import { makeHarness, sampleFinding } from "./test-fixture.js";

describe("策略版本与质量门禁", () => {
  it("版本保留完整规则，修改和激活不会改写历史", async () => {
    const { call } = await makeHarness();
    const first = await call<Policy>("policies.create", {
      name: "生产门禁",
      rules: { maxNewFindings: 2 },
    });
    const second = await call<Policy>("policies.version", {
      id: first.id,
      name: "收紧门禁",
      rules: { maxNewFindings: 0 },
    });
    expect(second.activeVersion).toBe(2);
    expect(second.versions[0]?.rules.maxNewFindings).toBe(2);
    expect(second.versions[1]?.rules.maxNewFindings).toBe(0);
    const rolledBack = await call<Policy>("policies.activate", {
      id: first.id,
      version: 1,
    });
    expect(rolledBack.name).toBe("生产门禁");
    expect(rolledBack.versions).toHaveLength(2);
  });

  it("比较历史版本只列出真实变化", async () => {
    const { call } = await makeHarness();
    const policy = await call<Policy>("policies.create", { name: "规则" });
    await call("policies.version", {
      id: policy.id,
      rules: { requireBaseline: true },
    });
    const comparison = await call<{ changes: { field: string }[] }>(
      "policies.compare",
      { id: policy.id, from: 1, to: 2 },
    );
    expect(comparison.changes.map((change) => change.field)).toEqual([
      "rules.requireBaseline",
    ]);
  });

  it("乐观锁拒绝覆盖另一个人的修改", async () => {
    const { call } = await makeHarness();
    const policy = await call<Policy>("policies.create", { name: "规则" });
    await call("policies.toggle", {
      id: policy.id,
      enabled: false,
      expectedRevision: 1,
    });
    await expect(
      call("policies.version", {
        id: policy.id,
        name: "过期编辑",
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict", status: 409 });
    const current = await call<Policy>("policies.get", { id: policy.id });
    expect(current.versions).toHaveLength(1);
    expect(current.enabled).toBe(false);
  });

  it("模板列表不会因调用者修改而污染下次创建", async () => {
    const { call } = await makeHarness();
    const templates = await call<{
      items: { id: string; rules: { maxNewFindings: number } }[];
    }>("policies.templates");
    templates.items[0]!.rules.maxNewFindings = 999;
    const policy = await call<Policy>("policies.create", {
      name: "默认",
      template: "balanced",
    });
    expect(policy.versions[0]?.rules.maxNewFindings).toBe(20);
  });

  it("不存在的模板与非法规则被边界拒绝", async () => {
    const { call } = await makeHarness();
    await expect(
      call("policies.create", { name: "规则", template: "unknown" }),
    ).rejects.toMatchObject({ code: "invalid_template" });
    await expect(
      call("policies.create", {
        name: "规则",
        rules: { blockedSeverities: ["urgent"] },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      call("policies.create", {
        name: "规则",
        rules: { includePaths: ["../secret"] },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const policies = await call<{ total: number }>("policies.list");
    expect(policies.total).toBe(0);
  });

  it("空白标题在整理后被拒绝", async () => {
    const { call } = await makeHarness();
    await expect(
      call("policies.create", { name: " \n\t " }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("新增高风险发现阻断门禁，低置信度不干扰策略", async () => {
    const { call } = await makeHarness();
    await call("policies.create", { name: "生产" });
    await call("findings.create", { ...sampleFinding, confidence: 0.2 });
    expect(await call("gate.evaluate")).toMatchObject({
      decision: "pass",
      counts: { new: 0 },
    });
    await call("findings.create", sampleFinding);
    expect(await call("gate.evaluate")).toMatchObject({
      decision: "fail",
      counts: { new: 1 },
    });
  });

  it("人工确认与活动基线要求分别显示", async () => {
    const { call } = await makeHarness();
    await call("policies.create", {
      name: "发布",
      rules: { requireBaseline: true, requireHumanApproval: true },
    });
    await call("findings.create", { ...sampleFinding, severity: "low" });
    const gate = await call<{ checks: { name: string; decision: string }[] }>(
      "gate.evaluate",
    );
    expect(
      gate.checks
        .filter((check) => check.decision === "fail")
        .map((check) => check.name),
    ).toEqual(["baseline", "human_approval"]);
    await call("baselines.create", {
      name: "主分支",
      reference: "main",
      active: true,
    });
    expect(await call("gate.evaluate", { humanApproved: true })).toMatchObject({
      decision: "pass",
    });
  });

  it("路径与标签过滤针对同一完整规则生效", async () => {
    const { call } = await makeHarness();
    await call("policies.create", {
      name: "安全",
      rules: {
        includePaths: ["src/**"],
        excludePaths: ["src/test/**"],
        labels: ["security"],
      },
    });
    await call("findings.create", { ...sampleFinding, tags: ["style"] });
    expect(await call("gate.evaluate")).toMatchObject({ decision: "pass" });
    await call("findings.create", { ...sampleFinding, tags: ["security"] });
    expect(await call("gate.evaluate")).toMatchObject({ decision: "fail" });
  });
});
