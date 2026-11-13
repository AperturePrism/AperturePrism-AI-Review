import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it, vi } from "vitest";
import * as schema from "../../../packages/database/src/schema.js";
import { recoverExpiredLeases, resetTaskToQueued } from "./index.js";
import type {
  ClaimTaskInput,
  CreateTaskInput,
  AnalysisTask,
  HeartbeatTaskInput,
} from "../../../packages/domain/src/index.js";
import {
  taskCreatedEventType,
  taskCanceledEventType,
  taskCompletedEventType,
  taskFailedEventType,
  taskHeartbeatEventType,
  taskLeaseRecoveredEventType,
  taskLeasedEventType,
  taskPublishingEventType,
  taskRetryReadyEventType,
  taskRetryScheduledEventType,
  taskStartedEventType,
} from "../../../packages/domain/src/index.js";

function queryDatabase(returningRows: unknown[][][] = []) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const proxy = drizzle(
    async (query, params) => {
      queries.push({ sql: query.replace(/\s+/g, " "), params });
      return {
        rows:
          query.startsWith('update "analysis_tasks"') &&
          query.includes("returning")
            ? (returningRows.shift() ?? [])
            : [],
      };
    },
    { schema },
  );
  // Exercise real Drizzle SQL generation without a PostgreSQL connection.
  // pg-proxy has no transaction support, so only its transaction boundary is stubbed.
  vi.spyOn(proxy, "transaction").mockImplementation(async (callback) =>
    callback(proxy as unknown as Parameters<typeof callback>[0]),
  );
  return {
    db: proxy as unknown as Parameters<typeof recoverExpiredLeases>[0],
    queries,
  };
}

describe("expired lease recovery queries", () => {
  const now = new Date("2026-11-13T12:00:00.000Z");

  it("atomically checks the attempt budget and excludes fresh or inactive leases", async () => {
    const { db, queries } = queryDatabase();

    expect(await recoverExpiredLeases(db, now)).toBe(0);
    expect(queries).toHaveLength(1);
    const query = queries[0]!;
    expect(query.sql).toContain(
      '"status" = case when "analysis_tasks"."attempt_count" >= "analysis_tasks"."max_attempts" then \'failed\'::task_status else \'queued\'::task_status end',
    );
    expect(query.sql).toContain(
      'where "analysis_tasks"."status" in (\'leased\', \'running\', \'publishing\') and "analysis_tasks"."lease_expires_at" <=',
    );
    expect(query.params.at(-1)).toBe(now.toISOString());
    expect(query.sql).not.toContain('"payload" =');
    expect(query.sql).not.toContain('"pending_payload" =');
  });

  it.each([3, 4])(
    "fails an expired exhausted attempt %s once and closes its open attempt",
    async (attemptNumber) => {
      const { db, queries } = queryDatabase([
        [["task-exhausted", "failed", attemptNumber]],
        [],
      ]);

      expect(await recoverExpiredLeases(db, now)).toBe(1);
      expect(await recoverExpiredLeases(db, now)).toBe(0);
      expect(queries[0]?.sql).toContain(
        '"last_error_category" = case when "analysis_tasks"."attempt_count" >= "analysis_tasks"."max_attempts" then \'lease_expired\' else "analysis_tasks"."last_error_category" end',
      );
      expect(queries[1]?.sql).toContain('update "task_attempts"');
      expect(queries[1]?.sql).toContain(
        '"task_attempts"."finished_at" is null',
      );
      expect(queries[1]?.params).toEqual([
        now.toISOString(),
        "lease_expired",
        "task-exhausted",
      ]);
      const events = queries.filter((query) =>
        query.sql.startsWith('insert into "task_events"'),
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.params).toEqual([
        "task-exhausted",
        taskFailedEventType,
        JSON.stringify({
          taskId: "task-exhausted",
          recoveredAt: now.toISOString(),
          errorCategory: "lease_expired",
          attemptNumber,
        }),
      ]);
    },
  );

  it("preserves immediate queuing and the existing recovery event below budget", async () => {
    const { db, queries } = queryDatabase([[["task-retry", "queued", 2]]]);

    expect(await recoverExpiredLeases(db, now)).toBe(1);
    expect(queries[0]?.sql).toContain(
      '"next_attempt_at" = case when "analysis_tasks"."attempt_count" >= "analysis_tasks"."max_attempts" then "analysis_tasks"."next_attempt_at" else',
    );
    expect(queries[0]?.params).toEqual([
      null,
      null,
      null,
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
    ]);
    expect(queries[2]?.params).toEqual([
      "task-retry",
      taskLeaseRecoveredEventType,
      JSON.stringify({ taskId: "task-retry", recoveredAt: now.toISOString() }),
    ]);
  });
});

describe("manual rerun Check Run acknowledgement", () => {
  it("resets only Check Run acknowledgements after locking a terminal task", async () => {
    const { db, queries } = queryDatabase([[["task-rerun"]]]);

    expect(await resetTaskToQueued(db, { taskId: "task-rerun" })).toBe(true);
    expect(queries[0]?.sql).toContain('update "analysis_tasks"');
    expect(queries[0]?.sql).toContain("in ('failed', 'canceled')");
    expect(queries[1]?.sql).toBe(
      'update "external_publications" set "check_run_completed_at" = $1 where "external_publications"."task_id" = $2 and "external_publications"."channel" = \'check_run\'',
    );
    expect(queries[1]?.params).toEqual([null, "task-rerun"]);
    expect(queries[2]?.sql).toContain('delete from "task_attempts"');
    expect(queries[3]?.params[1]).toBe(taskRetryReadyEventType);
  });

  it("leaves acknowledgements untouched when the task cannot be rerun", async () => {
    const { db, queries } = queryDatabase();

    expect(await resetTaskToQueued(db, { taskId: "task-active" })).toBe(false);
    expect(queries).toHaveLength(1);
  });
});

describe("task creation contract", () => {
  it("accepts an issue task without provider-specific payload requirements", () => {
    const input: CreateTaskInput = {
      taskType: "issue_analysis",
      subjectRevision: "content-revision-1",
      policyVersion: "policy-v1",
      dedupeKey: "issue-analysis:repository:7:content-revision-1:policy-v1",
      payload: { issueNumber: 7 },
    };

    expect(input.taskType).toBe("issue_analysis");
    expect(input.payload).toEqual({ issueNumber: 7 });
  });

  it("keeps the persisted result contract minimal", () => {
    const task: AnalysisTask = {
      id: "task-1",
      taskType: "pr_review",
      status: "queued",
      dedupeKey: "pr-review:repository:8:head-sha:policy-v1",
    };

    expect({ outcome: "created", task }).toEqual({
      outcome: "created",
      task,
    });
    expect(taskCreatedEventType).toBe("task.created");
  });
});

describe("task lease contract", () => {
  it("requires an explicit worker and lease duration", () => {
    const claim: ClaimTaskInput = {
      workerId: "worker-a",
      leaseDurationMs: 30_000,
    };
    const heartbeat: HeartbeatTaskInput = {
      taskId: "task-1",
      workerId: "worker-a",
      leaseDurationMs: 30_000,
    };

    expect(claim.workerId).toBe("worker-a");
    expect(heartbeat.taskId).toBe("task-1");
  });

  it("uses stable event names for lease state changes", () => {
    expect([
      taskLeasedEventType,
      taskHeartbeatEventType,
      taskLeaseRecoveredEventType,
    ]).toEqual(["task.leased", "task.heartbeat", "task.lease_recovered"]);
  });
});

describe("task execution contract", () => {
  it("uses stable event names for execution and retry transitions", () => {
    expect([
      taskStartedEventType,
      taskPublishingEventType,
      taskCompletedEventType,
      taskRetryScheduledEventType,
      taskRetryReadyEventType,
      taskFailedEventType,
      taskCanceledEventType,
    ]).toEqual([
      "task.started",
      "task.publishing",
      "task.completed",
      "task.retry_scheduled",
      "task.retry_ready",
      "task.failed",
      "task.canceled",
    ]);
  });
});
