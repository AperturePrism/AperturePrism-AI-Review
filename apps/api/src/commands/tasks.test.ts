import { describe, expect, it, vi } from "vitest";
vi.mock("../runtime.js", () => ({
  database: { db: {} },
  logger: { warn: vi.fn() },
  config: {},
}));
vi.mock("../github.js", () => ({ githubClientPromise: Promise.resolve(null) }));
import {
  executeTaskBatch,
  parseTaskBatch,
  parseTaskIds,
  parseTaskList,
  encodeTaskCursor,
  type BatchTask,
  type TaskBatchServices,
} from "./tasks.js";

const ONE = "00000000-0000-0000-0000-000000000001";
const TWO = "00000000-0000-0000-0000-000000000002";
const THREE = "00000000-0000-0000-0000-000000000003";
function services(rows: readonly BatchTask[]): TaskBatchServices {
  return {
    list: vi.fn(async () => rows),
    canManage: vi.fn(async () => true),
    retry: vi.fn(async () => true),
    cancel: vi.fn(async () => true),
    priority: vi.fn(async () => true),
  };
}

describe("bounded task batch input", () => {
  it("normalizes and deduplicates UUIDs before any writes", () => {
    expect(parseTaskIds([" " + ONE + " ", ONE, TWO])).toEqual([ONE, TWO]);
  });
  it.each([
    null,
    [],
    ["bad"],
    [ONE, 42],
    Array.from({ length: 201 }, () => ONE),
  ])("rejects malformed or excessive task IDs", (ids) => {
    expect(() => parseTaskIds(ids)).toThrow();
  });
  it("defaults cancel metadata without losing a supplied false dryRun", () => {
    expect(
      parseTaskBatch({ taskIds: [ONE], action: "cancel", dryRun: false }),
    ).toEqual({
      taskIds: [ONE],
      action: "cancel",
      dryRun: false,
      reason: "manual_batch_cancel",
    });
  });
  it("requires a numeric integer priority in the documented range", () => {
    for (const priority of [-101, 101, 1.5, "4", NaN, undefined]) {
      expect(() =>
        parseTaskBatch({ taskIds: [ONE], action: "priority", priority }),
      ).toThrow();
    }
    expect(
      parseTaskBatch({ taskIds: [ONE], action: "priority", priority: -100 })
        .priority,
    ).toBe(-100);
  });
  it.each(["yes", 1, null])(
    "does not accept a truthy dryRun instead of a boolean",
    (dryRun) => {
      expect(() =>
        parseTaskBatch({ taskIds: [ONE], action: "retry", dryRun }),
      ).toThrow();
    },
  );
  it("does not accept an unrecognized operation", () => {
    expect(() => parseTaskBatch({ taskIds: [ONE], action: "delete" })).toThrow(
      "action",
    );
  });
  it("bounds and trims a cancellation reason", () => {
    expect(
      parseTaskBatch({
        taskIds: [ONE],
        action: "cancel",
        reason: "  stop obsolete review  ",
      }).reason,
    ).toBe("stop obsolete review");
    expect(() =>
      parseTaskBatch({
        taskIds: [ONE],
        action: "cancel",
        reason: "x".repeat(501),
      }),
    ).toThrow();
  });
});

describe("task batch transitions and warehouse permissions", () => {
  it("keeps input order and reports a missing item independently", async () => {
    const dependencies = services([
      { id: TWO, repositoryId: "repo", status: "failed" },
      { id: ONE, repositoryId: "repo", status: "canceled" },
    ]);
    const result = await executeTaskBatch(
      parseTaskBatch({ taskIds: [ONE, THREE, TWO], action: "retry" }),
      dependencies,
    );
    expect(result.map((row) => [row.taskId, row.outcome])).toEqual([
      [ONE, "updated"],
      [THREE, "not_found"],
      [TWO, "updated"],
    ]);
    expect(dependencies.retry).toHaveBeenCalledTimes(2);
  });
  it("does not reveal the status or invoke a write for an inaccessible task", async () => {
    const dependencies = services([
      { id: ONE, repositoryId: "other", status: "failed" },
    ]);
    vi.mocked(dependencies.canManage).mockResolvedValue(false);
    expect(
      await executeTaskBatch(
        parseTaskBatch({ taskIds: [ONE], action: "retry" }),
        dependencies,
      ),
    ).toEqual([{ taskId: ONE, outcome: "forbidden" }]);
    expect(dependencies.retry).not.toHaveBeenCalled();
  });
  it("dry-run reports transitions without calling any state mutation", async () => {
    const dependencies = services([
      { id: ONE, repositoryId: "repo", status: "failed" },
    ]);
    const result = await executeTaskBatch(
      parseTaskBatch({ taskIds: [ONE], action: "retry", dryRun: true }),
      dependencies,
    );
    expect(result).toEqual([
      {
        taskId: ONE,
        outcome: "would_update",
        previousStatus: "failed",
        status: "queued",
      },
    ]);
    expect(dependencies.retry).not.toHaveBeenCalled();
    expect(dependencies.cancel).not.toHaveBeenCalled();
    expect(dependencies.priority).not.toHaveBeenCalled();
  });
  it.each([
    "queued",
    "leased",
    "running",
    "publishing",
    "completed",
    "retry_wait",
  ])("does not retry a %s task", async (status) => {
    const dependencies = services([{ id: ONE, repositoryId: "repo", status }]);
    const result = await executeTaskBatch(
      parseTaskBatch({ taskIds: [ONE], action: "retry" }),
      dependencies,
    );
    expect(result[0]?.outcome).toBe("skipped");
    expect(dependencies.retry).not.toHaveBeenCalled();
  });
  it.each(["failed", "completed", "canceled"])(
    "does not cancel a terminal %s task",
    async (status) => {
      const dependencies = services([
        { id: ONE, repositoryId: "repo", status },
      ]);
      await executeTaskBatch(
        parseTaskBatch({ taskIds: [ONE], action: "cancel" }),
        dependencies,
      );
      expect(dependencies.cancel).not.toHaveBeenCalled();
    },
  );
  it.each(["queued", "leased", "running", "publishing", "retry_wait"])(
    "cancels an active %s task using the caller's reason",
    async (status) => {
      const dependencies = services([
        { id: ONE, repositoryId: "repo", status },
      ]);
      await executeTaskBatch(
        parseTaskBatch({
          taskIds: [ONE],
          action: "cancel",
          reason: "obsolete",
        }),
        dependencies,
      );
      expect(dependencies.cancel).toHaveBeenCalledWith(ONE, "obsolete");
    },
  );
  it("never changes the priority of work that already owns a running lease", async () => {
    const dependencies = services([
      { id: ONE, repositoryId: "repo", status: "running" },
    ]);
    const result = await executeTaskBatch(
      parseTaskBatch({ taskIds: [ONE], action: "priority", priority: 20 }),
      dependencies,
    );
    expect(result[0]?.outcome).toBe("skipped");
    expect(dependencies.priority).not.toHaveBeenCalled();
  });
  it("updates queued priority through a conditional mutation", async () => {
    const dependencies = services([
      { id: ONE, repositoryId: "repo", status: "queued" },
    ]);
    const result = await executeTaskBatch(
      parseTaskBatch({ taskIds: [ONE], action: "priority", priority: 20 }),
      dependencies,
    );
    expect(result[0]?.outcome).toBe("updated");
    expect(dependencies.priority).toHaveBeenCalledWith(ONE, 20);
  });
  it("reports a lost transition race as skipped, never a successful retry", async () => {
    const dependencies = services([
      { id: ONE, repositoryId: "repo", status: "failed" },
    ]);
    vi.mocked(dependencies.retry).mockResolvedValue(false);
    const result = await executeTaskBatch(
      parseTaskBatch({ taskIds: [ONE], action: "retry" }),
      dependencies,
    );
    expect(result[0]?.outcome).toBe("skipped");
  });
  it("surfaces a storage failure to the API error boundary", async () => {
    const dependencies = services([
      { id: ONE, repositoryId: "repo", status: "failed" },
    ]);
    vi.mocked(dependencies.retry).mockRejectedValue(
      new Error("storage offline"),
    );
    await expect(
      executeTaskBatch(
        parseTaskBatch({ taskIds: [ONE], action: "retry" }),
        dependencies,
      ),
    ).rejects.toThrow("storage offline");
  });
});

describe("task list cursor and filters", () => {
  it("uses the intended 50-row default when limit is absent", () => {
    expect(parseTaskList(new URL("http://localhost/tasks"))).toMatchObject({
      limit: 50,
      offset: 0,
      statuses: [],
      cursor: null,
    });
  });
  it("reads repeated and comma-separated statuses as one unique filter", () => {
    const query = parseTaskList(
      new URL(
        "http://localhost/tasks?status=failed,queued&status=failed&taskType=pr_review",
      ),
    );
    expect(query.statuses).toEqual(["failed", "queued"]);
    expect(query.taskType).toBe("pr_review");
  });
  it("round-trips a UUID and millisecond timestamp without losing either", () => {
    const row = { id: ONE, createdAt: new Date("2026-11-13T10:11:12.345Z") };
    const query = parseTaskList(
      new URL("http://localhost/tasks?cursor=" + encodeTaskCursor(row)),
    );
    expect(query.cursor).toEqual(row);
  });
  it("distinguishes two tasks that share the same creation timestamp", () => {
    const createdAt = new Date("2026-11-13T10:11:12.345Z");
    expect(encodeTaskCursor({ id: ONE, createdAt })).not.toBe(
      encodeTaskCursor({ id: TWO, createdAt }),
    );
  });
  it("preserves the legacy offset query", () => {
    expect(
      parseTaskList(new URL("http://localhost/tasks?offset=50&limit=25")),
    ).toMatchObject({ offset: 50, limit: 25 });
  });
  it.each([
    "limit=0",
    "limit=201",
    "limit=1.5",
    "offset=-1",
    "status=deleted",
    "taskType=else",
    "repositoryId=wrong",
    "from=not-date",
    "from=2026-11-14&to=2026-11-13",
    "cursor=invalid",
  ])("rejects malformed list parameters %s", (query) => {
    expect(() =>
      parseTaskList(new URL("http://localhost/tasks?" + query)),
    ).toThrow();
  });
  it("does not mix stable cursors with offset skipping", () => {
    const cursor = encodeTaskCursor({
      id: ONE,
      createdAt: new Date("2026-11-13"),
    });
    expect(() =>
      parseTaskList(
        new URL(`http://localhost/tasks?cursor=${cursor}&offset=2`),
      ),
    ).toThrow("cursor");
  });
  it("bounds textual searches and normalizes surrounding spaces", () => {
    expect(
      parseTaskList(new URL("http://localhost/tasks?q=%20abc%20")).search,
    ).toBe("abc");
    expect(() =>
      parseTaskList(new URL("http://localhost/tasks?q=" + "x".repeat(201))),
    ).toThrow("search");
  });
});
