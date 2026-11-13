import { describe, expect, it } from "vitest";
import type { Batch, BatchItem } from "./types.js";
import { makeHarness } from "./test-fixture.js";

describe("批次执行计划与租约", () => {
  it("循环与缺失依赖在创建前被拒绝", async () => {
    const { call } = await makeHarness();
    await expect(
      call("batches.create", {
        name: "环",
        items: [
          { id: "a", subject: "pr:1", reference: "sha", dependencies: ["b"] },
          { id: "b", subject: "pr:2", reference: "sha", dependencies: ["a"] },
        ],
      }),
    ).rejects.toMatchObject({ code: "dependency_cycle" });
    await expect(
      call("batches.create", {
        name: "缺依赖",
        items: [
          { subject: "pr:1", reference: "sha", dependencies: ["unknown"] },
        ],
      }),
    ).rejects.toMatchObject({ code: "missing_dependency" });
    expect(await call("batches.list")).toMatchObject({ total: 0 });
  });

  it("空批次与重复id不会落盘", async () => {
    const { call } = await makeHarness();
    await expect(
      call("batches.create", { name: "空", items: [] }),
    ).rejects.toMatchObject({ code: "empty_batch" });
    await expect(
      call("batches.create", {
        name: "重复",
        items: [
          { id: "a", subject: "pr:1", reference: "sha" },
          { id: "a", subject: "pr:2", reference: "sha" },
        ],
      }),
    ).rejects.toMatchObject({ code: "duplicate_item" });
  });

  it("只有依赖成功后才领取下游，并遵守并发限制", async () => {
    const { call } = await makeHarness();
    const batch = await call<Batch>("batches.create", {
      name: "计划",
      concurrency: 1,
      items: [
        { id: "a", subject: "pr:1", reference: "sha" },
        { id: "b", subject: "pr:2", reference: "sha", dependencies: ["a"] },
      ],
    });
    expect(
      await call("batches.claim", { id: batch.id, worker: "worker" }),
    ).toMatchObject({ item: null });
    await call("batches.start", { id: batch.id });
    const first = await call<{ item: BatchItem }>("batches.claim", {
      id: batch.id,
      worker: "worker",
    });
    expect(first.item.id).toBe("a");
    expect(
      await call("batches.claim", { id: batch.id, worker: "other" }),
    ).toMatchObject({ item: null });
    await call("batches.complete", {
      id: batch.id,
      itemId: "a",
      worker: "worker",
    });
    expect(
      await call("batches.claim", { id: batch.id, worker: "other" }),
    ).toMatchObject({ item: { id: "b" } });
    expect(
      await call("batches.complete", {
        id: batch.id,
        itemId: "b",
        worker: "other",
      }),
    ).toMatchObject({ status: "completed" });
  });

  it("并行领取不会让两个调用得到同一项", async () => {
    const { call } = await makeHarness();
    const batch = await call<Batch>("batches.create", {
      name: "并发",
      concurrency: 2,
      items: [
        { subject: "pr:1", reference: "sha" },
        { subject: "pr:2", reference: "sha" },
      ],
    });
    await call("batches.start", { id: batch.id });
    const claims = await Promise.all([
      call<{ item: BatchItem }>("batches.claim", {
        id: batch.id,
        worker: "one",
      }),
      call<{ item: BatchItem }>("batches.claim", {
        id: batch.id,
        worker: "two",
      }),
    ]);
    expect(new Set(claims.map((claim) => claim.item.id)).size).toBe(2);
  });

  it("暂停不发新任务，已有任务可完成；恢复后继续派发", async () => {
    const { call } = await makeHarness();
    const batch = await call<Batch>("batches.create", {
      name: "暂停",
      concurrency: 2,
      items: [
        { subject: "pr:1", reference: "sha" },
        { subject: "pr:2", reference: "sha" },
      ],
    });
    await call("batches.start", { id: batch.id });
    const claim = await call<{ item: BatchItem }>("batches.claim", {
      id: batch.id,
      worker: "one",
    });
    await call("batches.pause", { id: batch.id });
    expect(
      await call("batches.claim", { id: batch.id, worker: "two" }),
    ).toMatchObject({ item: null });
    await call("batches.heartbeat", {
      id: batch.id,
      itemId: claim.item.id,
      worker: "one",
    });
    await call("batches.complete", {
      id: batch.id,
      itemId: claim.item.id,
      worker: "one",
    });
    expect(await call("batches.get", { id: batch.id })).toMatchObject({
      status: "paused",
    });
    await call("batches.resume", { id: batch.id });
    expect(
      await call("batches.claim", { id: batch.id, worker: "two" }),
    ).toMatchObject({ item: { id: "item-2" } });
  });

  it("过期持有者不能提交，恢复后增加尝试次数", async () => {
    const { call, setTime } = await makeHarness();
    const batch = await call<Batch>("batches.create", {
      name: "恢复",
      items: [{ subject: "pr:1", reference: "sha" }],
    });
    await call("batches.start", { id: batch.id });
    await call("batches.claim", { id: batch.id, worker: "old", leaseMs: 1000 });
    setTime("2026-11-13T00:00:02Z");
    await expect(
      call("batches.complete", {
        id: batch.id,
        itemId: "item-1",
        worker: "old",
      }),
    ).rejects.toMatchObject({ code: "lease_lost" });
    expect(
      await call("batches.claim", { id: batch.id, worker: "new" }),
    ).toMatchObject({ recovered: 1, item: { worker: "new", attempts: 2 } });
    await expect(
      call("batches.heartbeat", {
        id: batch.id,
        itemId: "item-1",
        worker: "old",
      }),
    ).rejects.toMatchObject({ code: "lease_lost" });
  });

  it("最终失败传播到依赖项，显式重试可恢复整条链", async () => {
    const { call } = await makeHarness();
    const batch = await call<Batch>("batches.create", {
      name: "失败",
      items: [
        { id: "a", subject: "pr:1", reference: "sha", maxAttempts: 1 },
        { id: "b", subject: "pr:2", reference: "sha", dependencies: ["a"] },
        { id: "c", subject: "pr:3", reference: "sha", dependencies: ["b"] },
      ],
    });
    await call("batches.start", { id: batch.id });
    await call("batches.claim", { id: batch.id, worker: "worker" });
    const failed = await call<Batch>("batches.complete", {
      id: batch.id,
      itemId: "a",
      worker: "worker",
      outcome: "failed",
      error: "模型不可用",
    });
    expect(failed.status).toBe("completed");
    expect(failed.items.map((item) => item.status)).toEqual([
      "failed",
      "canceled",
      "canceled",
    ]);
    const retried = await call<Batch>("batches.retry", { id: batch.id });
    expect(retried.status).toBe("queued");
    expect(retried.items.map((item) => item.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("关联执行任务可幂等重试，但不能覆盖另一个任务id", async () => {
    const { call } = await makeHarness();
    const batch = await call<Batch>("batches.create", {
      name: "关联",
      items: [{ subject: "pr:1", reference: "sha" }],
    });
    await call("batches.start", { id: batch.id });
    await call("batches.claim", { id: batch.id, worker: "worker" });
    const linked = await call("batches.link", {
      id: batch.id,
      itemId: "item-1",
      worker: "worker",
      result: { taskId: "task-42" },
    });
    expect(linked).toMatchObject({
      result: { taskId: "task-42" },
      status: "running",
    });
    expect(
      await call("batches.link", {
        id: batch.id,
        itemId: "item-1",
        worker: "worker",
        result: { taskId: "task-42" },
      }),
    ).toEqual(linked);
    await expect(
      call("batches.link", {
        id: batch.id,
        itemId: "item-1",
        worker: "worker",
        result: { taskId: "task-other" },
      }),
    ).rejects.toMatchObject({ code: "item_already_linked" });
  });

  it("取消后令牌失效，不再接受外部任务的迟到结果", async () => {
    const { call } = await makeHarness();
    const batch = await call<Batch>("batches.create", {
      name: "取消",
      items: [{ subject: "pr:1", reference: "sha" }],
    });
    await call("batches.start", { id: batch.id });
    await call("batches.claim", { id: batch.id, worker: "worker" });
    await call("batches.cancel", { id: batch.id });
    await expect(
      call("batches.complete", {
        id: batch.id,
        itemId: "item-1",
        worker: "worker",
      }),
    ).rejects.toMatchObject({ code: "lease_lost" });
    await expect(call("batches.retry", { id: batch.id })).rejects.toMatchObject(
      { code: "invalid_transition" },
    );
  });
});
