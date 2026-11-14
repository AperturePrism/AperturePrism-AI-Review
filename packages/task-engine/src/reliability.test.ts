import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it, vi } from "vitest";
import * as schema from "../../database/src/schema.js";
import {
  BatchConflictError,
  createTaskBatch,
  parseBatchRequest,
} from "./batch.js";
import {
  diagnoseDeadLetter,
  listDeadLetters,
  summarizeDeadLetters,
  type DeadLetterTask,
} from "./dead-letter.js";
import { claimTask, failTask, recordAttemptUsage } from "./index.js";
import {
  getTaskTimeline,
  listQueuePreview,
  operateTasks,
} from "./operations.js";

type Query = { sql: string; params: unknown[] };
function queryDatabase(rowsFor: (query: Query) => unknown[] = () => []) {
  const queries: Query[] = [];
  const proxy = drizzle(
    async (query, params) => {
      const captured = { sql: query.replace(/\s+/g, " ").trim(), params };
      queries.push(captured);
      return { rows: rowsFor(captured) as unknown[][] };
    },
    { schema },
  );
  vi.spyOn(proxy, "transaction").mockImplementation(async (callback) =>
    callback(proxy as unknown as Parameters<typeof callback>[0]),
  );
  return { db: proxy as unknown as Parameters<typeof claimTask>[0], queries };
}
const now = new Date("2026-11-13T12:00:00Z");

describe("queue SQL ownership and quotas", () => {
  it("does not accept usage from a canceled, expired or superseded attempt", async () => {
    const { db, queries } = queryDatabase();
    await recordAttemptUsage(db, {
      taskId: "task",
      workerId: "old-worker",
      attemptNumber: 1,
      inputTokens: 100,
      outputTokens: 20,
      durationMs: 1000,
      provider: "provider",
      model: "model",
      now,
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain('"analysis_tasks"."lease_owner" =');
    expect(queries[0]?.sql).toContain('"analysis_tasks"."attempt_count" =');
    expect(queries[0]?.sql).toContain("for update");
    expect(queries.some((query) => query.sql.startsWith("insert"))).toBe(false);
  });

  it("records usage only after locking the exact current attempt", async () => {
    const { db, queries } = queryDatabase((query) =>
      query.sql.startsWith("select") ? [["task"]] : [],
    );
    await recordAttemptUsage(db, {
      taskId: "task",
      workerId: "worker",
      attemptNumber: 2,
      inputTokens: 100,
      outputTokens: 20,
      durationMs: 1000,
      provider: "provider",
      model: "model",
      now,
    });
    expect(queries).toHaveLength(2);
    expect(queries[0]?.params).toEqual([
      "task",
      "worker",
      2,
      now.toISOString(),
      1,
    ]);
    expect(queries[1]?.params).toContain("task.analysis_usage");
  });

  it("keeps SKIP LOCKED ownership and excludes exhausted queued tasks", async () => {
    const { db, queries } = queryDatabase();
    expect(
      await claimTask(db, { workerId: "worker", leaseDurationMs: 60_000, now }),
    ).toBeNull();
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain("for update skip locked limit 1");
    expect(queries[0]?.sql).toContain("attempt_count < max_attempts");
    expect(queries[0]?.sql).toContain("order by priority desc");
  });
  it("takes a transaction lock before checking configured shared limits", async () => {
    const { db, queries } = queryDatabase();
    await claimTask(db, {
      workerId: "worker",
      leaseDurationMs: 60_000,
      now,
      policy: {
        maxActivePerRepository: 2,
        maxActiveTotal: 10,
        roundRobin: true,
        agingIntervalMs: 60_000,
        allowedTaskTypes: ["pr_review"],
      },
    });
    expect(queries[0]?.sql).toContain("pg_advisory_xact_lock");
    const select = queries[1]!;
    expect(select.sql).toContain(
      "repository_id is not distinct from candidate.repository_id",
    );
    expect(select.sql).toContain("lease_expires_at >");
    expect(select.sql).toContain("greatest(0, floor(extract(epoch");
    expect(select.params).toContain("pr_review");
    expect(select.params).toContain(2);
    expect(select.params).toContain(10);
    expect(select.sql).not.toContain("'pr_review'");
  });
  it("rejects invalid lease input before issuing SQL", async () => {
    const { db, queries } = queryDatabase();
    await expect(
      claimTask(db, { workerId: " ", leaseDurationMs: 1 }),
    ).rejects.toThrow();
    await expect(
      claimTask(db, { workerId: "worker", leaseDurationMs: 0 }),
    ).rejects.toThrow();
    expect(queries).toEqual([]);
  });
  it("applies nonretryable failure policy without exhausting a fake numeric budget", async () => {
    const { db, queries } = queryDatabase((query) =>
      query.sql.startsWith("select")
        ? [[1, 3, now.toISOString()]]
        : query.sql.startsWith('update "analysis_tasks"')
          ? [["task-1"]]
          : [],
    );
    const result = await failTask(db, {
      taskId: "task-1",
      workerId: "worker",
      errorCategory: "authentication_failed",
      retryDelayMs: 1_000,
      now,
      retryPolicy: {},
    });
    expect(result).toEqual({ status: "failed", nextAttemptAt: null });
    const event = queries.find((query) =>
      query.sql.startsWith('insert into "task_events"'),
    )!;
    expect(
      event.params.some(
        (value) => typeof value === "string" && value.includes("non_retryable"),
      ),
    ).toBe(true);
    const update = queries.find((query) =>
      query.sql.startsWith('update "analysis_tasks"'),
    )!;
    expect(update.sql).toContain("lease_owner");
    expect(update.sql).toContain("lease_expires_at");
    expect(update.params).toContain("worker");
  });
  it("keeps legacy explicit retry delays without optional policy", async () => {
    const { db } = queryDatabase((query) =>
      query.sql.startsWith("select")
        ? [[1, 3, now.toISOString()]]
        : query.sql.startsWith('update "analysis_tasks"')
          ? [["task-1"]]
          : [],
    );
    const result = await failTask(db, {
      taskId: "task-1",
      workerId: "worker",
      errorCategory: "timeout",
      retryDelayMs: 42,
      now,
    });
    expect(result).toEqual({
      status: "retry_wait",
      nextAttemptAt: new Date(now.getTime() + 42),
    });
  });
});

describe("batch SQL and idempotency", () => {
  const request = {
    key: "release-1",
    items: [
      {
        key: "pr-1",
        task: {
          taskType: "pr_review" as const,
          subjectRevision: "a",
          policyVersion: "v1",
          payload: {},
        },
      },
    ],
  };
  it("locks the batch business key before writing members", async () => {
    const { db, queries } = queryDatabase((query) =>
      query.sql.startsWith('insert into "analysis_tasks"')
        ? [["task-1", "pr_review", "queued", "batch-key"]]
        : [],
    );
    const result = await createTaskBatch(db, request);
    expect(result).toMatchObject({
      key: "release-1",
      created: 1,
      duplicate: 0,
    });
    expect(queries[0]?.sql).toContain(
      "pg_advisory_xact_lock(hashtextextended(",
    );
    expect(queries[0]?.params).toEqual(["task-batch:release-1"]);
    const membership = queries.filter((query) =>
      query.sql.startsWith('insert into "task_events"'),
    );
    expect(membership).toHaveLength(2);
    expect(membership[1]?.params).toContain("task.batch_member");
  });
  it("rejects a changed request before inserting any task", async () => {
    const { db, queries } = queryDatabase((query) =>
      query.sql.startsWith("select")
        ? [[JSON.stringify({ requestHash: "different" })]]
        : [],
    );
    await expect(createTaskBatch(db, request)).rejects.toBeInstanceOf(
      BatchConflictError,
    );
    expect(queries.some((query) => query.sql.startsWith("insert"))).toBe(false);
  });
  it("does not append duplicate membership events on an idempotent replay", async () => {
    const requestHash = parseBatchRequest(request).requestHash;
    const { db, queries } = queryDatabase((query) => {
      if (
        query.sql.startsWith("select") &&
        query.sql.includes('from "task_events"')
      )
        return [[JSON.stringify({ requestHash })]];
      if (
        query.sql.startsWith("select") &&
        query.sql.includes('from "analysis_tasks"')
      )
        return [["task-1", "pr_review", "queued", "batch-key"]];
      return [];
    });
    expect(await createTaskBatch(db, request)).toMatchObject({
      created: 0,
      duplicate: 1,
    });
    expect(
      queries.some((query) =>
        query.sql.startsWith('insert into "task_events"'),
      ),
    ).toBe(false);
  });
});

describe("authorized queue operations", () => {
  it("treats an empty visible repository scope as no data", async () => {
    const { db, queries } = queryDatabase();
    const result = await listQueuePreview(db, { repositoryIds: [], now });
    expect(result.sampled).toBe(0);
    expect(queries[0]?.sql).toContain("where (false and");
  });
  it("does not let a caller's repository ID become SQL syntax", async () => {
    const malicious = "repo' OR true--";
    const { db, queries } = queryDatabase();
    await listDeadLetters(db, { repositoryIds: [malicious], limit: 2 });
    expect(queries[0]?.params).toContain(malicious);
    expect(queries[0]?.sql).not.toContain(malicious);
  });
  it("does not read timeline events for a hidden task", async () => {
    const { db, queries } = queryDatabase();
    expect(
      await getTaskTimeline(db, { taskId: "hidden", repositoryIds: [] }),
    ).toBeNull();
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).not.toContain('from "task_events"');
  });
  it("reports unauthorized or absent task IDs without attempting mutation", async () => {
    const { db, queries } = queryDatabase();
    expect(
      await operateTasks(db, {
        operation: "cancel",
        ids: ["b", "a", "b"],
        repositoryIds: [],
        reason: "closed",
      }),
    ).toEqual({
      changed: 0,
      results: [
        { id: "b", outcome: "not_found" },
        { id: "a", outcome: "not_found" },
      ],
    });
    expect(queries).toHaveLength(2);
    expect(queries.every((query) => query.sql.includes("for update"))).toBe(
      true,
    );
    expect(queries.some((query) => query.sql.startsWith("update"))).toBe(false);
  });
});

describe("failed task explanations", () => {
  const task: DeadLetterTask = {
    id: "task",
    taskType: "pr_review",
    repositoryId: "repo",
    subjectNumber: 1,
    status: "failed",
    attemptCount: 3,
    maxAttempts: 3,
    lastErrorCategory: "authentication_failed",
    createdAt: new Date(now.getTime() - 60_000),
    updatedAt: new Date(now.getTime() - 10_000),
  };
  it("distinguishes configuration changes from transient capacity failures", () => {
    expect(diagnoseDeadLetter(task, now)).toMatchObject({
      kind: "credentials",
      requiresChange: true,
      canRetry: true,
      attemptsExhausted: true,
      ageMs: 10_000,
    });
    expect(
      diagnoseDeadLetter({ ...task, lastErrorCategory: "rate_limited" }, now),
    ).toMatchObject({ kind: "capacity", requiresChange: false });
  });
  it("never offers to retry currently running work", () => {
    expect(
      diagnoseDeadLetter({ ...task, status: "running" }, now).canRetry,
    ).toBe(false);
  });
  it("retains an unknown category without inventing a cause", () => {
    expect(
      diagnoseDeadLetter({ ...task, lastErrorCategory: "custom_failure" }, now),
    ).toMatchObject({
      category: "custom_failure",
      kind: "unknown",
      requiresChange: false,
    });
  });
  it("groups failures by category and gives oldest failure age", () => {
    expect(
      summarizeDeadLetters(
        [task, { ...task, lastErrorCategory: "timeout" }, task],
        now,
      ),
    ).toEqual({
      total: 3,
      oldestAgeMs: 10_000,
      categories: [
        { category: "authentication_failed", count: 2, requiresChange: true },
        { category: "timeout", count: 1, requiresChange: false },
      ],
    });
  });
});
