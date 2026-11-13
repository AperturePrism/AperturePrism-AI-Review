import { describe, expect, it } from "vitest";
import type { Finding, GateResult, WorkbenchSummary } from "./types.js";
import { createWorkbench } from "./index.js";
import {
  administrator,
  makeHarness,
  observer,
  reviewer,
  sampleFinding,
} from "./test-fixture.js";

describe("工作台授权和真实审查同步", () => {
  it("只读用户能查看但不能创建，越权id统一404", async () => {
    const { call } = await makeHarness();
    await expect(
      call("policies.create", { name: "禁止" }, observer),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(await call("summary", {}, observer)).toMatchObject({
      repository: "acme/app",
      findings: 0,
    });
    const other = await call<Finding>(
      "findings.create",
      { ...sampleFinding, repository: "other/private" },
      administrator,
    );
    await expect(call("findings.get", { id: other.id })).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    await expect(
      call("findings.transition", {
        id: other.id,
        status: "fixed",
        reason: "越权",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await call("findings.list")).toMatchObject({ total: 0 });
  });

  it("仓库规范化后再检查权限，恶意仓库格式在边界拒绝", async () => {
    const { call } = await makeHarness();
    expect(await call("summary", { repository: " ACME/APP " })).toMatchObject({
      repository: "acme/app",
    });
    await expect(
      call("summary", { repository: "../../etc" }),
    ).rejects.toMatchObject({ code: "invalid_repository" });
    await expect(
      call("summary", { repository: "acme/.." }),
    ).rejects.toMatchObject({ code: "invalid_repository" });
    await expect(
      call("summary", { repository: "other/repo" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("真实审查导入和门禁在一个事务，重放不增加发现次数或审计", async () => {
    const { call, directory } = await makeHarness();
    const command = {
      source: "pr:42",
      reference: "head-sha",
      deliveryKey: "task-42:1",
      findings: [sampleFinding],
    };
    const first = await call<{
      items: Finding[];
      gate: GateResult;
      replayed: boolean;
    }>("review.sync", command);
    expect(first.replayed).toBe(false);
    expect(first.gate.decision).toBe("fail");
    await call("findings.transition", {
      id: first.items[0]!.id,
      status: "fixed",
      reason: "人工修复",
    });
    const audit = await call<{ total: number }>("audit.list");
    const fresh = createWorkbench({ dataDirectory: directory });
    const replay = (await fresh.execute(reviewer, {
      action: "review.sync",
      input: { repository: "acme/app", ...command },
    })) as { items: Finding[]; replayed: boolean };
    expect(replay.replayed).toBe(true);
    expect(replay.items[0]).toMatchObject({ status: "fixed", occurrences: 1 });
    expect(await call("audit.list")).toMatchObject({ total: audit.total });
  });

  it("相同交付键不能换结果，新任务可在同一SHA重新审查", async () => {
    const { call } = await makeHarness();
    const command = {
      source: "pr:1",
      reference: "same-sha",
      deliveryKey: "task:1",
      findings: [sampleFinding],
    };
    await call("review.sync", command);
    await expect(
      call("review.sync", { ...command, findings: [] }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    const rerun = await call<{ replayed: boolean; items: Finding[] }>(
      "review.sync",
      {
        ...command,
        deliveryKey: "task:2",
        findings: [{ ...sampleFinding, severity: "critical" }],
      },
    );
    expect(rerun.replayed).toBe(false);
    expect(rerun.items[0]?.severity).toBe("critical");
  });

  it("默认不解决未报告发现，只有完整审查显式声明才解决同来源旧发现", async () => {
    const { call } = await makeHarness();
    const first = await call<{ items: Finding[] }>("review.sync", {
      source: "pr:1",
      reference: "old",
      findings: [sampleFinding],
    });
    const other = await call<{ items: Finding[] }>("review.sync", {
      source: "pr:2",
      reference: "other",
      findings: [{ ...sampleFinding, path: "other.ts" }],
    });
    await call("review.sync", {
      source: "pr:1",
      reference: "truncated",
      findings: [],
    });
    expect(
      await call("findings.get", { id: first.items[0]!.id }),
    ).toMatchObject({ status: "open" });
    await call("review.sync", {
      source: "pr:1",
      reference: "complete",
      findings: [],
      resolveMissing: true,
    });
    expect(
      await call("findings.get", { id: first.items[0]!.id }),
    ).toMatchObject({ status: "fixed" });
    expect(
      await call("findings.get", { id: other.items[0]!.id }),
    ).toMatchObject({ status: "open" });
  });

  it("无效同步整体回滚，不留下幂等键阻挡修正后的重新交付", async () => {
    const { call } = await makeHarness();
    await expect(
      call("review.sync", {
        source: "pr:1",
        reference: "sha",
        deliveryKey: "task",
        findings: [sampleFinding, { ...sampleFinding, confidence: 2 }],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await call("findings.list")).toMatchObject({ total: 0 });
    expect(
      await call("review.sync", {
        source: "pr:1",
        reference: "sha",
        deliveryKey: "task",
        findings: [sampleFinding],
      }),
    ).toMatchObject({ imported: 1, replayed: false });
  });

  it("审计链能验证并检测磁盘数据的意外改写", async () => {
    const { call } = await makeHarness();
    await call("policies.create", { name: "规则" });
    await call("findings.create", sampleFinding);
    expect(await call("audit.verify")).toEqual({
      valid: true,
      checked: 2,
      brokenRecordId: null,
    });
    const result = await call<{
      items: { details: Record<string, unknown> }[];
    }>("audit.list");
    result.items[0]!.details.changed = true;
    expect(await call("audit.verify")).toMatchObject({ valid: true });
  });

  it("仪表盘现场汇总，不受分页的影响", async () => {
    const { call } = await makeHarness();
    await call("findings.import", {
      findings: [
        sampleFinding,
        { ...sampleFinding, path: "other.ts", severity: "low" },
      ],
    });
    expect(await call("findings.list", { limit: 1 })).toMatchObject({
      total: 2,
      items: [expect.any(Object)],
    });
    const summary = await call<WorkbenchSummary>("summary");
    expect(summary.findings).toBe(2);
    expect(summary.severity.high).toBe(1);
    expect(summary.severity.low).toBe(1);
  });

  it("新head先完成时，旧head晚到不能导入、解决发现或改变最新门禁", async () => {
    const { call, directory } = await makeHarness();
    await call("review.sync", {
      source: "pr:1",
      reference: "new-head",
      sourceSequence: "9007199254740993000002",
      deliveryKey: "new-task",
      findings: [sampleFinding],
    });
    const auditBefore = await call<{ total: number }>("audit.list");
    const fresh = createWorkbench({ dataDirectory: directory });
    const old = await fresh.execute(reviewer, {
      action: "review.sync",
      input: {
        repository: "acme/app",
        source: "pr:1",
        reference: "old-head",
        sourceSequence: "9007199254740993000001",
        deliveryKey: "old-task",
        findings: [],
        resolveMissing: true,
      },
    });
    expect(old).toMatchObject({
      ignored: true,
      imported: 0,
      resolved: 0,
      gate: { decision: "fail" },
    });
    expect(await call("findings.list")).toMatchObject({
      total: 1,
      items: [{ status: "open", reference: "new-head", occurrences: 1 }],
    });
    expect(await call("audit.list")).toMatchObject({
      total: auditBefore.total,
    });
  });

  it("序列按整数比较且按来源隔离，手工无序列操作保持原语义", async () => {
    const { call } = await makeHarness();
    await call("review.sync", {
      source: "pr:1",
      reference: "v1",
      sourceSequence: "9",
      findings: [sampleFinding],
    });
    expect(
      await call("review.sync", {
        source: "pr:1",
        reference: "v2",
        sourceSequence: "10",
        findings: [],
        resolveMissing: true,
      }),
    ).toMatchObject({ resolved: 1 });
    expect(
      await call("review.sync", {
        source: "pr:2",
        reference: "another",
        sourceSequence: "1",
        findings: [{ ...sampleFinding, path: "other.ts" }],
      }),
    ).toMatchObject({ imported: 1, replayed: false });
    expect(
      await call("review.sync", {
        source: "pr:1",
        reference: "manual",
        findings: [sampleFinding],
      }),
    ).toMatchObject({ imported: 1 });
    await expect(
      call("review.sync", {
        source: "pr:1",
        reference: "bad",
        sourceSequence: "1.5",
        findings: [],
      }),
    ).rejects.toMatchObject({ code: "invalid_sequence" });
    await expect(
      call("review.sync", {
        source: "pr:1",
        reference: "bad",
        sourceSequence: "0",
        findings: [],
      }),
    ).rejects.toMatchObject({ code: "invalid_sequence" });
  });
});
