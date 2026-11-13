import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../../packages/database/src/client.js";
import {
  analysisTasks,
  externalPublications,
  repositories,
  taskAttempts,
  taskEvents,
} from "../../../packages/database/src/schema.js";
import type { DatabaseClient } from "../../../packages/database/src/client.js";
import {
  beginPublishing,
  cancelSubjectTasks,
  cancelTask,
  claimTask,
  completeTask,
  createAnalysisTask,
  failTask,
  recordAttemptUsage,
  recoverExpiredLeases,
  resetTaskToQueued,
  startTask,
} from "./index.js";

const databaseUrl = process.env.APERTUREPRISM_INTEGRATION_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration("task state PostgreSQL integration", () => {
  const prefix = `m3-state:${randomUUID()}`;
  let client: DatabaseClient;

  beforeAll(() => {
    if (!databaseUrl) throw new Error("integration database URL is required");
    client = createDatabaseClient(databaseUrl);
  });

  afterAll(async () => {
    if (!client) return;
    await client.sql.begin(async (sql) => {
      await sql`delete from external_publications where task_id in (
        select id from analysis_tasks where dedupe_key like ${`${prefix}%`}
      )`;
      await sql`delete from task_events where task_id in (
        select id from analysis_tasks where dedupe_key like ${`${prefix}%`}
      )`;
      await sql`delete from task_attempts where task_id in (
        select id from analysis_tasks where dedupe_key like ${`${prefix}%`}
      )`;
      await sql`delete from analysis_tasks where dedupe_key like ${`${prefix}%`}`;
      await sql`delete from repositories where github_id like ${`${prefix}%`}`;
    });
    await client.close();
  });

  it("requires publishing before completion and closes the attempt", async () => {
    const created = await createAnalysisTask(client.db, {
      taskType: "issue_analysis",
      subjectRevision: "revision-complete",
      policyVersion: "policy-v1",
      dedupeKey: `${prefix}:complete`,
      payload: {},
      priority: 1_000_000,
    });
    const leased = await claimTask(client.db, {
      workerId: "worker-complete",
      leaseDurationMs: 60_000,
    });

    expect(leased?.id).toBe(created.task.id);
    expect(
      await startTask(client.db, {
        taskId: created.task.id,
        workerId: "worker-complete",
      }),
    ).toBe(true);
    await recordAttemptUsage(client.db, {
      taskId: created.task.id,
      workerId: "worker-complete",
      attemptNumber: 1,
      inputTokens: 120,
      outputTokens: 45,
      durationMs: 250,
      provider: "provider-a",
      model: "model-a",
    });
    expect(
      await completeTask(client.db, {
        taskId: created.task.id,
        workerId: "worker-complete",
      }),
    ).toBe(false);
    expect(
      await beginPublishing(client.db, {
        taskId: created.task.id,
        workerId: "worker-complete",
      }),
    ).toBe(true);
    expect(
      await completeTask(client.db, {
        taskId: created.task.id,
        workerId: "worker-complete",
      }),
    ).toBe(true);

    const [task] = await client.db
      .select({ status: analysisTasks.status })
      .from(analysisTasks)
      .where(sql`${analysisTasks.id} = ${created.task.id}`);
    const [attempt] = await client.db
      .select({ finishedAt: taskAttempts.finishedAt })
      .from(taskAttempts)
      .where(sql`${taskAttempts.taskId} = ${created.task.id}`);
    const events = await client.db
      .select({ eventType: taskEvents.eventType })
      .from(taskEvents)
      .where(sql`${taskEvents.taskId} = ${created.task.id}`);

    expect(task?.status).toBe("completed");
    expect(attempt?.finishedAt).toBeInstanceOf(Date);
    expect(events.map(({ eventType }) => eventType)).toEqual([
      "task.created",
      "task.leased",
      "task.started",
      "task.analysis_usage",
      "task.publishing",
      "task.completed",
    ]);
    const usageEvents = await client.db
      .select({ data: taskEvents.data })
      .from(taskEvents)
      .where(
        sql`${taskEvents.taskId} = ${created.task.id}
          and ${taskEvents.eventType} = 'task.analysis_usage'`,
      );
    expect(usageEvents).toEqual([
      {
        data: expect.objectContaining({
          attemptNumber: 1,
          inputTokens: 120,
          outputTokens: 45,
          durationMs: 250,
          provider: "provider-a",
          model: "model-a",
        }),
      },
    ]);
    expect(
      await cancelTask(client.db, {
        taskId: created.task.id,
        reason: "terminal task must remain completed",
      }),
    ).toBe(false);
  });

  it("cancels queued and running tasks exactly once", async () => {
    const queued = await createAnalysisTask(client.db, {
      taskType: "issue_analysis",
      subjectRevision: "revision-queued",
      policyVersion: "policy-v1",
      dedupeKey: `${prefix}:queued`,
      payload: {},
      priority: 1_000_000,
    });
    expect(
      await cancelTask(client.db, {
        taskId: queued.task.id,
        reason: "superseded",
      }),
    ).toBe(true);
    expect(
      await cancelTask(client.db, {
        taskId: queued.task.id,
        reason: "duplicate cancellation",
      }),
    ).toBe(false);

    const running = await createAnalysisTask(client.db, {
      taskType: "pr_review",
      subjectRevision: "revision-running",
      policyVersion: "policy-v1",
      dedupeKey: `${prefix}:running`,
      payload: {},
      priority: 1_000_000,
    });
    const leased = await claimTask(client.db, {
      workerId: "worker-cancel",
      leaseDurationMs: 60_000,
    });
    expect(leased?.id).toBe(running.task.id);
    expect(
      await startTask(client.db, {
        taskId: running.task.id,
        workerId: "worker-cancel",
      }),
    ).toBe(true);
    expect(
      await cancelTask(client.db, {
        taskId: running.task.id,
        reason: "user requested cancellation",
      }),
    ).toBe(true);

    const [task] = await client.db
      .select({ status: analysisTasks.status })
      .from(analysisTasks)
      .where(sql`${analysisTasks.id} = ${running.task.id}`);
    const [attempt] = await client.db
      .select({
        finishedAt: taskAttempts.finishedAt,
        errorCategory: taskAttempts.errorCategory,
      })
      .from(taskAttempts)
      .where(sql`${taskAttempts.taskId} = ${running.task.id}`);
    const cancellationEvents = await client.db
      .select({ data: taskEvents.data })
      .from(taskEvents)
      .where(
        sql`${taskEvents.taskId} = ${running.task.id}
          and ${taskEvents.eventType} = 'task.canceled'`,
      );

    expect(task?.status).toBe("canceled");
    expect(attempt?.finishedAt).toBeInstanceOf(Date);
    expect(attempt?.errorCategory).toBe("canceled");
    expect(cancellationEvents).toEqual([
      {
        data: expect.objectContaining({
          reason: "user requested cancellation",
        }),
      },
    ]);
  });

  it("does not cancel a failed task", async () => {
    const created = await createAnalysisTask(client.db, {
      taskType: "repository_index",
      subjectRevision: "revision-failed",
      policyVersion: "policy-v1",
      dedupeKey: `${prefix}:failed`,
      payload: {},
      priority: 1_000_000,
      maxAttempts: 1,
    });
    const leased = await claimTask(client.db, {
      workerId: "worker-failed",
      leaseDurationMs: 60_000,
    });
    expect(leased?.id).toBe(created.task.id);
    expect(
      await startTask(client.db, {
        taskId: created.task.id,
        workerId: "worker-failed",
      }),
    ).toBe(true);
    expect(
      await failTask(client.db, {
        taskId: created.task.id,
        workerId: "worker-failed",
        errorCategory: "invalid_output",
        retryDelayMs: 0,
      }),
    ).toEqual({ status: "failed", nextAttemptAt: null });
    expect(
      await cancelTask(client.db, {
        taskId: created.task.id,
        reason: "terminal task must remain failed",
      }),
    ).toBe(false);
  });

  it.each(
    (["leased", "running", "publishing"] as const).flatMap((status) =>
      [1, 3, 4].map((attemptCount) => ({ status, attemptCount })),
    ),
  )(
    "recovers expired $status attempt $attemptCount according to its budget exactly once",
    async ({ status, attemptCount }) => {
      const now = new Date("2000-01-01T12:00:00.000Z");
      const previousAttemptAt = new Date(now.getTime() - 120_000);
      const expiredAt = new Date(now.getTime() - 60_000);
      const payload = { revision: "current" };
      const pendingPayload = { revision: "pending" };
      const exhausted = attemptCount >= 3;
      const [created] = await client.db
        .insert(analysisTasks)
        .values({
          taskType: "pr_review",
          subjectRevision: "revision-lease-recovery",
          policyVersion: "policy-v1",
          dedupeKey: `${prefix}:recovery:${status}:${attemptCount}`,
          status,
          payload,
          pendingPayload,
          attemptCount,
          maxAttempts: 3,
          leaseOwner: "worker-expired",
          leaseExpiresAt: expiredAt,
          heartbeatAt: previousAttemptAt,
          nextAttemptAt: previousAttemptAt,
          lastErrorCategory: "previous_failure",
        })
        .returning({ id: analysisTasks.id });
      const taskId = created!.id;
      await client.db.insert(taskAttempts).values({
        taskId,
        attemptNumber: attemptCount,
        workerId: "worker-expired",
        startedAt: previousAttemptAt,
      });

      expect(await recoverExpiredLeases(client.db, now)).toBeGreaterThanOrEqual(
        1,
      );
      expect(await recoverExpiredLeases(client.db, now)).toBe(0);
      const [task] = await client.db
        .select()
        .from(analysisTasks)
        .where(eq(analysisTasks.id, taskId));
      const [attempt] = await client.db
        .select()
        .from(taskAttempts)
        .where(eq(taskAttempts.taskId, taskId));
      const events = await client.db
        .select({ eventType: taskEvents.eventType, data: taskEvents.data })
        .from(taskEvents)
        .where(eq(taskEvents.taskId, taskId));

      expect(task).toMatchObject({
        status: exhausted ? "failed" : "queued",
        attemptCount,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        nextAttemptAt: exhausted ? previousAttemptAt : now,
        lastErrorCategory: exhausted ? "lease_expired" : "previous_failure",
        payload,
        pendingPayload,
        updatedAt: now,
      });
      expect(attempt).toMatchObject({
        finishedAt: now,
        errorCategory: "lease_expired",
      });
      expect(events).toEqual([
        {
          eventType: exhausted ? "task.failed" : "task.lease_recovered",
          data: {
            taskId,
            recoveredAt: now.toISOString(),
            ...(exhausted
              ? { errorCategory: "lease_expired", attemptNumber: attemptCount }
              : {}),
          },
        },
      ]);
    },
  );

  it("does not recover fresh active leases, inactive tasks, or missing leases", async () => {
    const now = new Date("2000-01-01T12:00:00.000Z");
    const freshAt = new Date(now.getTime() + 60_000);
    const expiredAt = new Date(now.getTime() - 60_000);
    const tasks = await client.db
      .insert(analysisTasks)
      .values(
        (
          [
            { status: "leased", leaseExpiresAt: freshAt },
            { status: "running", leaseExpiresAt: freshAt },
            { status: "publishing", leaseExpiresAt: freshAt },
            { status: "running", leaseExpiresAt: null },
            { status: "queued", leaseExpiresAt: expiredAt },
            { status: "retry_wait", leaseExpiresAt: expiredAt },
            { status: "completed", leaseExpiresAt: expiredAt },
            { status: "failed", leaseExpiresAt: expiredAt },
            { status: "canceled", leaseExpiresAt: expiredAt },
          ] as const
        ).map((entry, index) => ({
          ...entry,
          taskType: "pr_review",
          subjectRevision: "revision-unchanged",
          policyVersion: "policy-v1",
          dedupeKey: `${prefix}:recovery-unchanged:${index}`,
          payload: {},
          attemptCount: 3,
          maxAttempts: 3,
        })),
      )
      .returning();

    expect(await recoverExpiredLeases(client.db, now)).toBe(0);
    for (const expected of tasks) {
      const [task] = await client.db
        .select()
        .from(analysisTasks)
        .where(eq(analysisTasks.id, expected.id));
      const events = await client.db
        .select()
        .from(taskEvents)
        .where(eq(taskEvents.taskId, expected.id));
      expect(task).toEqual(expected);
      expect(events).toEqual([]);
    }
  });

  it("atomically clears only Check Run completion acknowledgement when rerunning", async () => {
    const created = await createAnalysisTask(client.db, {
      taskType: "pr_review",
      subjectRevision: "revision-rerun",
      policyVersion: "policy-v1",
      dedupeKey: `${prefix}:rerun-ack`,
      payload: {},
    });
    const taskId = created.task.id;
    const now = new Date();
    await cancelTask(client.db, { taskId, reason: "test rerun", now });
    const publications = await client.db
      .insert(externalPublications)
      .values(
        ["check_run", "review", "comment"].map((channel) => ({
          taskId,
          channel,
          idempotencyKey: `${prefix}:rerun:${channel}`,
          externalObjectId: `external-${channel}`,
          checkRunCompletedAt: now,
        })),
      )
      .returning();

    expect(await resetTaskToQueued(client.db, { taskId, now })).toBe(true);
    for (const publication of publications) {
      const [updated] = await client.db
        .select()
        .from(externalPublications)
        .where(eq(externalPublications.id, publication.id));
      expect(updated).toEqual({
        ...publication,
        checkRunCompletedAt: publication.channel === "check_run" ? null : now,
      });
    }
  });

  it("cancelSubjectTasks cancels a subject's active tasks but leaves others", async () => {
    const repo = await client.db
      .insert(repositories)
      .values({
        githubId: `${prefix}-repo-subject`,
        owner: "acme",
        name: "widget",
        installationId: "inst-1",
      })
      .returning({ id: repositories.id });
    const repositoryId = repo[0]!.id;

    // 先建 running（claim + start），再建 queued，避免 claim 顺序歧义。
    const running = await createAnalysisTask(client.db, {
      taskType: "issue_analysis",
      repositoryId,
      subjectNumber: 555,
      subjectRevision: "revision-running",
      policyVersion: "policy-v1",
      dedupeKey: `${prefix}:subject:running`,
      payload: {},
      priority: 1_000_000,
    });
    const leased = await claimTask(client.db, {
      workerId: "worker-subject",
      leaseDurationMs: 60_000,
    });
    expect(leased?.id).toBe(running.task.id);
    expect(
      await startTask(client.db, {
        taskId: running.task.id,
        workerId: "worker-subject",
      }),
    ).toBe(true);

    const queued = await createAnalysisTask(client.db, {
      taskType: "issue_analysis",
      repositoryId,
      subjectNumber: 555,
      subjectRevision: "revision-queued",
      policyVersion: "policy-v1",
      dedupeKey: `${prefix}:subject:queued`,
      payload: {},
      priority: 1_000_000,
    });
    const otherSubject = await createAnalysisTask(client.db, {
      taskType: "issue_analysis",
      repositoryId,
      subjectNumber: 999,
      subjectRevision: "revision-other",
      policyVersion: "policy-v1",
      dedupeKey: `${prefix}:subject:other`,
      payload: {},
      priority: 1_000_000,
    });
    const otherType = await createAnalysisTask(client.db, {
      taskType: "pr_review",
      repositoryId,
      subjectNumber: 555,
      subjectRevision: "revision-pr",
      policyVersion: "policy-v1",
      dedupeKey: `${prefix}:subject:pr`,
      payload: {},
      priority: 1_000_000,
    });

    const canceledCount = await cancelSubjectTasks(client.db, {
      taskType: "issue_analysis",
      repositoryId,
      subjectNumber: 555,
      reason: "issue_closed",
    });
    expect(canceledCount).toBe(2);

    const statuses = new Map(
      (
        await client.db
          .select({ id: analysisTasks.id, status: analysisTasks.status })
          .from(analysisTasks)
          .where(eq(analysisTasks.repositoryId, repositoryId))
      ).map((row) => [row.id, row.status]),
    );
    expect(statuses.get(running.task.id)).toBe("canceled");
    expect(statuses.get(queued.task.id)).toBe("canceled");
    expect(statuses.get(otherSubject.task.id)).toBe("queued");
    expect(statuses.get(otherType.task.id)).toBe("queued");

    // 幂等：再次取消同一 subject 不再命中。
    expect(
      await cancelSubjectTasks(client.db, {
        taskType: "issue_analysis",
        repositoryId,
        subjectNumber: 555,
        reason: "issue_closed",
      }),
    ).toBe(0);
  });
});
