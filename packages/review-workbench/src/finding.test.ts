import { describe, expect, it } from "vitest";
import type { Finding, Baseline } from "./types.js";
import { findingFingerprint } from "./finding.js";
import { makeHarness, sampleFinding } from "./test-fixture.js";

describe("发现处置与基线", () => {
  it("指纹不随行号移动，同一发现合并而不是产生重复", async () => {
    const { call } = await makeHarness();
    const first = await call<Finding>("findings.create", sampleFinding);
    const moved = await call<Finding>("findings.create", {
      ...sampleFinding,
      line: 100,
    });
    expect(moved.id).toBe(first.id);
    expect(moved.fingerprint).toBe(first.fingerprint);
    expect(moved.line).toBe(100);
    expect(moved.occurrences).toBe(2);
    expect(await call("findings.list")).toMatchObject({ total: 1 });
  });

  it("标题空白与大小写被指纹归一化，路径大小写仍保留", () => {
    expect(findingFingerprint("auth", "a.ts", " Missing   check ")).toBe(
      findingFingerprint("AUTH", "a.ts", "missing check"),
    );
    expect(findingFingerprint("auth", "a.ts", "check")).not.toBe(
      findingFingerprint("auth", "A.ts", "check"),
    );
  });

  it("已修复发现再次出现自动重开，但接受风险不被后台覆盖", async () => {
    const { call } = await makeHarness();
    const finding = await call<Finding>("findings.create", sampleFinding);
    await call("findings.transition", {
      id: finding.id,
      status: "fixed",
      reason: "已补鉴权",
    });
    expect(await call("findings.create", sampleFinding)).toMatchObject({
      status: "open",
    });
    await call("findings.transition", {
      id: finding.id,
      status: "accepted_risk",
      reason: "本季度兼容旧入口",
    });
    expect(await call("findings.create", sampleFinding)).toMatchObject({
      status: "accepted_risk",
    });
  });

  it("关闭必须留原因，关闭后先重开才能重新分类", async () => {
    const { call } = await makeHarness();
    const finding = await call<Finding>("findings.create", sampleFinding);
    await expect(
      call("findings.transition", {
        id: finding.id,
        status: "fixed",
        reason: " ",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await call("findings.transition", {
      id: finding.id,
      status: "false_positive",
      reason: "上游已经校验",
    });
    await expect(
      call("findings.transition", {
        id: finding.id,
        status: "fixed",
        reason: "重新判断",
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    const reopened = await call<Finding>("findings.transition", {
      id: finding.id,
      status: "open",
      reason: "发现另一条调用路径",
    });
    expect(reopened.history.at(-1)).toMatchObject({
      from: "false_positive",
      to: "open",
      actor: "reviewer",
    });
  });

  it("指派与取消指派都有历史，支持按负责人筛选", async () => {
    const { call } = await makeHarness();
    const finding = await call<Finding>("findings.create", sampleFinding);
    await call("findings.assign", { id: finding.id, assignee: " alice " });
    expect(await call("findings.list", { assignee: "alice" })).toMatchObject({
      total: 1,
    });
    const unassigned = await call<Finding>("findings.assign", {
      id: finding.id,
      assignee: "",
    });
    expect(unassigned.assignee).toBe("");
    expect(unassigned.history.at(-1)).toMatchObject({ from: "alice", to: "" });
  });

  it("导入中一条无效时整个事务回滚，包括审计", async () => {
    const { call } = await makeHarness();
    await expect(
      call("findings.import", {
        findings: [sampleFinding, { ...sampleFinding, path: "../outside.ts" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await call("findings.list")).toMatchObject({ total: 0 });
    expect(await call("audit.list")).toMatchObject({ total: 0 });
  });

  it("批量处置不允许部分成功", async () => {
    const { call } = await makeHarness();
    const finding = await call<Finding>("findings.create", sampleFinding);
    await expect(
      call("findings.bulk_transition", {
        ids: [finding.id, "unknown"],
        status: "fixed",
        reason: "统一修复",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await call("findings.get", { id: finding.id })).toMatchObject({
      status: "open",
    });
  });

  it("一个仓库始终只有一个活动基线，归档不能重新激活", async () => {
    const { call } = await makeHarness();
    const first = await call<Baseline>("baselines.create", {
      name: "旧基线",
      reference: "main-1",
      active: true,
    });
    const second = await call<Baseline>("baselines.create", {
      name: "新基线",
      reference: "main-2",
      active: true,
    });
    expect(await call("baselines.get", { id: first.id })).toMatchObject({
      active: false,
    });
    expect(await call("baselines.get", { id: second.id })).toMatchObject({
      active: true,
    });
    await call("baselines.archive", { id: second.id });
    await expect(
      call("baselines.activate", { id: second.id }),
    ).rejects.toMatchObject({ code: "baseline_archived" });
  });

  it("已知发现不阻断，风险升级会重新阻断", async () => {
    const { call } = await makeHarness();
    await call("findings.create", { ...sampleFinding, severity: "medium" });
    const baseline = await call<Baseline>("baselines.create", {
      name: "主分支",
      reference: "main",
      active: true,
      fromCurrentFindings: true,
    });
    expect(await call("gate.evaluate")).toMatchObject({
      decision: "pass",
      counts: { existing: 1, new: 0 },
    });
    await call("findings.create", { ...sampleFinding, severity: "critical" });
    expect(await call("gate.evaluate")).toMatchObject({
      decision: "fail",
      counts: { existing: 0, new: 1 },
    });
    expect(await call("baselines.compare", { id: baseline.id })).toMatchObject({
      severityChanges: [{ previous: "medium", current: "critical" }],
    });
  });

  it("基线比较同时列出新增、仍在和已解决发现", async () => {
    const { call } = await makeHarness();
    const baseline = await call<Baseline>("baselines.create", {
      name: "基线",
      reference: "main",
      findings: [
        sampleFinding,
        { ...sampleFinding, title: "另一个旧问题", path: "old.ts" },
      ],
    });
    const comparison = await call<{
      added: unknown[];
      existing: unknown[];
      resolved: unknown[];
    }>("baselines.compare", {
      id: baseline.id,
      findings: [
        sampleFinding,
        { ...sampleFinding, title: "新问题", path: "new.ts" },
      ],
    });
    expect(comparison.added).toHaveLength(1);
    expect(comparison.existing).toHaveLength(1);
    expect(comparison.resolved).toHaveLength(1);
  });
});
