import { describe, expect, it } from "vitest";
import {
  activeQueueUsage,
  effectiveQueuePriority,
  parseQueuePolicy,
  previewQueue,
  summarizeQueue,
  type QueueTask,
} from "./queue.js";

const now = new Date("2026-11-13T12:00:00Z");
function task(id: string, values: Partial<QueueTask> = {}): QueueTask {
  return {
    id,
    repositoryId: "repo-a",
    taskType: "pr_review",
    status: "queued",
    priority: 0,
    createdAt: new Date(now.getTime() - 1_000),
    nextAttemptAt: now,
    attemptCount: 0,
    maxAttempts: 3,
    ...values,
  };
}

describe("fair queue preview", () => {
  it("preserves static priority and stable time ordering by default", () => {
    const items = [
      task("b"),
      task("a"),
      task("urgent", { priority: 10 }),
      task("old", { createdAt: new Date(now.getTime() - 10_000) }),
    ];
    expect(
      previewQueue(items, { now }).ready.map((item) => item.task.id),
    ).toEqual(["urgent", "old", "a", "b"]);
  });

  it("lets old low-priority tasks eventually pass a steady stream of new work", () => {
    const old = task("old", {
      priority: 0,
      createdAt: new Date(now.getTime() - 600_000),
    });
    const fresh = task("new", { priority: 5, createdAt: now });
    const result = previewQueue([fresh, old], {
      now,
      policy: { agingIntervalMs: 60_000 },
    });
    expect(result.ready.map((item) => item.task.id)).toEqual(["old", "new"]);
    expect(result.ready[0]?.effectivePriority).toBe(10);
    expect(old.priority).toBe(0);
  });

  it("caps the age boost and clamps future creation timestamps", () => {
    const policy = parseQueuePolicy({
      agingIntervalMs: 1_000,
      maxAgingBoost: 3,
    });
    expect(
      effectiveQueuePriority(
        task("old", { priority: 2, createdAt: new Date(0) }),
        now,
        policy,
      ),
    ).toBe(5);
    expect(
      effectiveQueuePriority(
        task("future", {
          priority: 2,
          createdAt: new Date(now.getTime() + 100_000),
        }),
        now,
        policy,
      ),
    ).toBe(2);
  });

  it("round robins repositories instead of letting one repository fill the batch", () => {
    const result = previewQueue(
      [
        task("a1", { priority: 9 }),
        task("a2", { priority: 8 }),
        task("b1", { repositoryId: "repo-b", priority: 2 }),
        task("b2", { repositoryId: "repo-b", priority: 1 }),
        task("global", { repositoryId: null }),
      ],
      { now, policy: { roundRobin: true } },
    );
    expect(result.ready.map((item) => item.task.id)).toEqual([
      "a1",
      "b1",
      "global",
      "a2",
      "b2",
    ]);
  });

  it("counts reservations selected earlier in the same preview toward the repository limit", () => {
    const items = [
      task("a1"),
      task("a2"),
      task("b1", { repositoryId: "repo-b" }),
    ];
    const result = previewQueue(items, {
      now,
      policy: { maxActivePerRepository: 1 },
    });
    expect(result.ready.map((item) => item.task.id)).toEqual(["a1", "b1"]);
    expect(result.blocked).toContainEqual({
      task: items[1],
      reason: "repository_limit",
    });
    expect(result.activeByRepository).toEqual({});
  });

  it("considers only active unexpired leases as quota occupancy", () => {
    const items = [
      task("expired", {
        status: "running",
        leaseExpiresAt: new Date(now.getTime() - 1),
      }),
      task("active", {
        repositoryId: "repo-b",
        status: "publishing",
        leaseExpiresAt: new Date(now.getTime() + 10_000),
      }),
      task("a-next"),
      task("b-next", { repositoryId: "repo-b" }),
    ];
    expect([...activeQueueUsage(items, now)]).toEqual([["repo-b", 1]]);
    const result = previewQueue(items, {
      now,
      policy: { maxActivePerRepository: 1 },
    });
    expect(result.ready.map((item) => item.task.id)).toEqual(["a-next"]);
    expect(result.activeTotal).toBe(1);
    expect(result.activeByRepository).toEqual({ "repo-b": 1 });
  });

  it("enforces a global concurrency limit after existing workers", () => {
    const result = previewQueue(
      [
        task("active", {
          status: "leased",
          leaseExpiresAt: new Date(now.getTime() + 10_000),
        }),
        task("next", { repositoryId: "repo-b", priority: 1 }),
        task("later", { repositoryId: "repo-c" }),
      ],
      { now, policy: { maxActiveTotal: 2 } },
    );
    expect(result.ready.map((item) => item.task.id)).toEqual(["next"]);
    expect(result.blocked).toContainEqual(
      expect.objectContaining({
        reason: "global_limit",
        task: expect.objectContaining({ id: "later" }),
      }),
    );
  });

  it("explains every ineligible task without mutating the snapshot", () => {
    const items = [
      task("completed", { status: "completed" }),
      task("future", { nextAttemptAt: new Date(now.getTime() + 1) }),
      task("exhausted", { attemptCount: 3 }),
      task("type", { taskType: "repository_index" }),
    ];
    const original = structuredClone(items);
    const result = previewQueue(items, {
      now,
      policy: { allowedTaskTypes: ["pr_review"] },
    });
    expect(result.ready).toEqual([]);
    expect(result.blocked.map((item) => item.reason)).toEqual([
      "not_queued",
      "not_due",
      "attempts_exhausted",
      "task_type",
    ]);
    expect(items).toEqual(original);
  });

  it("keeps candidates beyond the requested batch as waiting", () => {
    const result = previewQueue([task("a"), task("b"), task("c")], {
      now,
      limit: 1,
    });
    expect(result.ready).toHaveLength(1);
    expect(result.waiting.map((item) => item.position)).toEqual([2, 3]);
  });

  it.each([
    { limit: 0 },
    { limit: 1_001 },
    { limit: 1.5 },
    { now: new Date("bad") },
  ])("rejects invalid queue requests %o", (values) => {
    expect(() => previewQueue([], { now, ...values })).toThrow();
  });
  it.each([
    { agingIntervalMs: -1 },
    { maxActiveTotal: 0.5 },
    { maxAgingBoost: NaN },
    { allowedTaskTypes: [] },
  ])("rejects invalid queue policy %o", (policy) => {
    expect(() => parseQueuePolicy(policy)).toThrow();
  });
});

describe("queue summaries", () => {
  it("derives status and repository totals from one task snapshot", () => {
    const result = summarizeQueue(
      [
        task("queued"),
        task("scheduled", { nextAttemptAt: new Date(now.getTime() + 5_000) }),
        task("running", { status: "running", repositoryId: "repo-b" }),
        task("failed", { status: "failed", repositoryId: "repo-b" }),
        task("exhausted", { attemptCount: 3 }),
      ],
      now,
    );
    expect(result).toMatchObject({
      total: 5,
      due: 1,
      scheduled: 2,
      active: 1,
      exhausted: 1,
      oldestWaitMs: 1_000,
    });
    expect(result.byRepository).toEqual([
      { repositoryId: "repo-a", queued: 3, active: 0, failed: 0 },
      { repositoryId: "repo-b", queued: 0, active: 1, failed: 1 },
    ]);
  });
  it("represents an empty queue without invalid dates", () => {
    expect(summarizeQueue([], now)).toMatchObject({
      total: 0,
      oldestQueuedAt: null,
      oldestWaitMs: 0,
      byRepository: [],
    });
  });
});
