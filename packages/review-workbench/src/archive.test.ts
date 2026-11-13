import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ArchivePreview,
  Batch,
  Budget,
  Finding,
  Policy,
  WorkbenchArchive,
} from "./types.js";
import { canonicalJson } from "./utils/json.js";
import {
  administrator,
  budgetLimits,
  budgetPeriod,
  makeHarness,
  observer,
  sampleFinding,
} from "./test-fixture.js";

function rehash(archive: WorkbenchArchive): WorkbenchArchive {
  const { checksum: _checksum, ...body } = archive;
  return {
    ...body,
    checksum: createHash("sha256").update(canonicalJson(body)).digest("hex"),
  };
}

describe("仓库级归档与恢复", () => {
  it("归档仅包含本仓库数据，校验与JSON字段顺序无关", async () => {
    const { call } = await makeHarness();
    await call("findings.create", sampleFinding);
    await call(
      "findings.create",
      { ...sampleFinding, repository: "private/secret", title: "私密发现" },
      administrator,
    );
    const archive = await call<WorkbenchArchive>("archive.export");
    expect(archive.data.findings).toHaveLength(1);
    expect(JSON.stringify(archive)).not.toContain("私密发现");
    expect(archive.checksum).toMatch(/^[a-f0-9]{64}$/);
    const reordered = Object.fromEntries(Object.entries(archive).reverse());
    expect(await call("archive.preview", { archive: reordered })).toMatchObject(
      { checksum: archive.checksum, counts: { findings: 1 } },
    );
  });

  it("改动内容、混入未知字段与修改仓库名均被拒绝", async () => {
    const { call } = await makeHarness();
    await call("findings.create", sampleFinding);
    const archive = await call<WorkbenchArchive>("archive.export");
    const tampered = structuredClone(archive);
    tampered.data.findings[0]!.title = "篡改";
    await expect(
      call("archive.preview", { archive: tampered }),
    ).rejects.toMatchObject({ code: "archive_checksum" });
    await expect(
      call("archive.preview", { archive: { ...archive, unknown: true } }),
    ).rejects.toMatchObject({ code: "invalid_archive" });
    await expect(
      call("archive.preview", {
        archive: { ...archive, repository: "private/secret" },
      }),
    ).rejects.toMatchObject({ code: "archive_repository" });
  });

  it("恢复需要管理员身份和具体预览校验值", async () => {
    const { call } = await makeHarness();
    const archive = await call<WorkbenchArchive>("archive.export");
    const preview = await call<ArchivePreview>(
      "archive.preview",
      { archive },
      observer,
    );
    expect(preview.canRestore).toBe(false);
    await expect(
      call("archive.restore", { archive, confirmChecksum: archive.checksum }),
    ).rejects.toMatchObject({ code: "admin_required" });
    await expect(
      call(
        "archive.restore",
        { archive, confirmChecksum: "0".repeat(64) },
        administrator,
      ),
    ).rejects.toMatchObject({ code: "archive_confirmation" });
  });

  it("完整恢复业务引用，清空运行租约并释放未结算预留", async () => {
    const source = await makeHarness();
    const finding = await source.call<Finding>(
      "findings.create",
      sampleFinding,
    );
    await source.call("policies.create", { name: "策略" });
    await source.call("baselines.create", {
      name: "主分支",
      reference: "main",
      active: true,
      fromCurrentFindings: true,
    });
    await source.call("feedback.create", {
      findingId: finding.id,
      verdict: "useful",
      comment: "确认",
    });
    await source.call("suppressions.create", {
      name: "临时",
      reason: "等待补丁",
      ruleId: sampleFinding.ruleId,
    });
    const budget = await source.call<Budget>("budgets.create", {
      name: "预算",
      ...budgetPeriod,
      limits: budgetLimits,
    });
    await source.call("budgets.reserve", {
      id: budget.id,
      key: "pending",
      estimate: { amountMicros: 100 },
    });
    const batch = await source.call<Batch>("batches.create", {
      name: "批次",
      items: [{ subject: "pr:1", reference: "sha" }],
    });
    await source.call("batches.start", { id: batch.id });
    await source.call("batches.claim", { id: batch.id, worker: "old-process" });
    const archive = await source.call<WorkbenchArchive>("archive.export");
    const target = await makeHarness();
    const preview = await target.call<ArchivePreview>(
      "archive.preview",
      { archive },
      administrator,
    );
    expect(preview.warnings.join(" ")).toContain("运行项");
    expect(preview.warnings.join(" ")).toContain("预算预留");
    await target.call(
      "archive.restore",
      { archive, confirmChecksum: archive.checksum },
      administrator,
    );
    expect(await target.call("findings.get", { id: finding.id })).toMatchObject(
      { title: sampleFinding.title },
    );
    expect(await target.call("batches.get", { id: batch.id })).toMatchObject({
      status: "queued",
      items: [{ status: "pending", worker: "", leaseUntil: null, attempts: 0 }],
    });
    expect(
      await target.call("budgets.availability", { id: budget.id }),
    ).toMatchObject({
      occupied: { amountMicros: 0 },
      reservations: [{ status: "released" }],
    });
    expect(await target.call("audit.list")).toMatchObject({
      total: 1,
      items: [{ action: "archive.restored", actor: "admin" }],
    });
    expect(await target.call("audit.verify")).toMatchObject({ valid: true });
  });

  it("恢复只替换目标仓库，已有记录版本提高使旧编辑失效", async () => {
    const { call } = await makeHarness();
    const policy = await call<Policy>("policies.create", { name: "旧名称" });
    const archive = await call<WorkbenchArchive>("archive.export");
    await call("policies.version", { id: policy.id, name: "后来名称" });
    const other = await call<Policy>(
      "policies.create",
      { name: "另一个仓库", repository: "private/secret" },
      administrator,
    );
    await call(
      "archive.restore",
      { archive, confirmChecksum: archive.checksum },
      administrator,
    );
    const restored = await call<Policy>("policies.get", { id: policy.id });
    expect(restored.name).toBe("旧名称");
    expect(restored.revision).toBeGreaterThan(2);
    expect(
      await call(
        "policies.get",
        { repository: "private/secret", id: other.id },
        administrator,
      ),
    ).toMatchObject({ name: "另一个仓库" });
    await expect(
      call("policies.toggle", {
        id: policy.id,
        enabled: false,
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });

  it("有效校验值也不能让外键缺失或重复指纹进入数据", async () => {
    const { call } = await makeHarness();
    const finding = await call<Finding>("findings.create", sampleFinding);
    await call("feedback.create", {
      findingId: finding.id,
      verdict: "useful",
      comment: "确认",
    });
    const archive = await call<WorkbenchArchive>("archive.export");
    const missing = structuredClone(archive);
    missing.data.findings = [];
    await expect(
      call("archive.preview", { archive: rehash(missing) }),
    ).rejects.toMatchObject({ code: "archive_reference" });
    const duplicated = structuredClone(archive);
    duplicated.data.findings.push({
      ...duplicated.data.findings[0]!,
      id: "different-id",
    });
    await expect(
      call("archive.preview", { archive: rehash(duplicated) }),
    ).rejects.toMatchObject({ code: "archive_duplicate" });
  });

  it("与其它仓库的id碰撞不会部分恢复", async () => {
    const { call } = await makeHarness();
    const own = await call<Finding>("findings.create", sampleFinding);
    const other = await call<Finding>(
      "findings.create",
      { ...sampleFinding, repository: "private/secret" },
      administrator,
    );
    const archive = await call<WorkbenchArchive>("archive.export");
    archive.data.findings[0]!.id = other.id;
    const collision = rehash(archive);
    await expect(
      call(
        "archive.restore",
        { archive: collision, confirmChecksum: collision.checksum },
        administrator,
      ),
    ).rejects.toMatchObject({ code: "archive_collision" });
    expect(await call("findings.get", { id: own.id })).toMatchObject({
      id: own.id,
    });
  });

  it("不接受过深JSON或带函数的非JSON归档对象", async () => {
    const { call } = await makeHarness();
    await expect(
      call("archive.preview", { archive: { run: () => undefined } }),
    ).rejects.toMatchObject({ code: "invalid_json" });
    let nested: unknown = "leaf";
    for (let index = 0; index < 42; index += 1) nested = { nested };
    await expect(
      call("archive.preview", { archive: nested }),
    ).rejects.toMatchObject({ code: "json_too_deep" });
  });
});
