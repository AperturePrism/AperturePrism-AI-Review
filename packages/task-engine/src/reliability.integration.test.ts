/** PostgreSQL 回归：真实事务、幂等批次、范围过滤和失败恢复，不替代并发锁测试。 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../database/src/client.js";
import { cancelTaskBatch, createTaskBatch, getTaskBatch } from "./batch.js";
import { listDeadLetters, retryDeadLetter } from "./dead-letter.js";
import {
  createAnalysisTask,
  claimTask,
  cancelTask,
  resetTaskToQueued,
} from "./index.js";
import {
  getTaskTimeline,
  listQueuePreview,
  operateTasks,
} from "./operations.js";

const databaseUrl = process.env.APERTUREPRISM_INTEGRATION_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("task reliability PostgreSQL operations", () => {
  let client: DatabaseClient;
  const ids: string[] = [];
  const prefix = `reliability:${randomUUID()}`;
  beforeAll(() => {
    if (!databaseUrl) throw new Error("integration database is required");
    client = createDatabaseClient(databaseUrl);
  });
  afterAll(async () => {
    if (!client) return;
    if (ids.length) {
      await client.sql`delete from external_publications where task_id in ${client.sql(ids)}`;
      await client.sql`delete from task_events where task_id in ${client.sql(ids)}`;
      await client.sql`delete from task_attempts where task_id in ${client.sql(ids)}`;
      await client.sql`delete from analysis_tasks where id in ${client.sql(ids)}`;
    }
    await client.close();
  });

  it("creates a batch atomically and detects incompatible idempotent replay", async () => {
    const request = {
      key: `${prefix}:batch`,
      label: "release review",
      items: [
        {
          key: "first",
          task: {
            taskType: "pr_review" as const,
            subjectRevision: "a",
            policyVersion: "v1",
            payload: { number: 1 },
          },
        },
        {
          key: "second",
          task: {
            taskType: "pr_review" as const,
            subjectRevision: "b",
            policyVersion: "v1",
            payload: { number: 2 },
          },
        },
      ],
    };
    const first = await createTaskBatch(client.db, request);
    ids.push(...first.items.map((item) => item.result.task.id));
    expect(first.created).toBe(2);
    const replay = await createTaskBatch(client.db, {
      ...request,
      items: [...request.items].reverse(),
    });
    expect(replay.duplicate).toBe(2);
    expect(new Set(replay.items.map((item) => item.result.task.id))).toEqual(
      new Set(first.items.map((item) => item.result.task.id)),
    );
    await expect(
      createTaskBatch(client.db, {
        ...request,
        items: request.items.slice(0, 1),
      }),
    ).rejects.toThrow("different items");
    expect(await getTaskBatch(client.db, request.key)).toMatchObject({
      total: 2,
      active: 2,
      finished: false,
      completionRatio: 0,
    });
    expect(
      await cancelTaskBatch(client.db, {
        key: request.key,
        reason: "release abandoned",
      }),
    ).toEqual({ total: 2, canceled: 2 });
    expect(await getTaskBatch(client.db, request.key)).toMatchObject({
      canceled: 2,
      active: 0,
      finished: true,
      completionRatio: 1,
    });
    const [members] =
      await client.sql`select count(*)::int as count from task_events where event_type='task.batch_member' and data->>'batchKey'=${request.key}`;
    expect(members?.count).toBe(2);
  });

  it("filters global tasks explicitly and prevents hidden task mutations", async () => {
    const created = await createAnalysisTask(client.db, {
      taskType: "issue_analysis",
      subjectRevision: "visible",
      policyVersion: "v1",
      dedupeKey: `${prefix}:scope`,
      payload: {},
    });
    ids.push(created.task.id);
    const hidden = await listQueuePreview(client.db, { repositoryIds: [] });
    expect(hidden.sampled).toBe(0);
    const global = await listQueuePreview(client.db, {
      repositoryIds: [],
      includeGlobal: true,
      sampleLimit: 50_000,
    });
    expect(
      global.ready.some((entry) => entry.task.id === created.task.id) ||
        global.waiting.some((entry) => entry.task.id === created.task.id),
    ).toBe(true);
    expect(
      await operateTasks(client.db, {
        operation: "cancel",
        ids: [created.task.id],
        repositoryIds: [],
        reason: "hidden",
      }),
    ).toMatchObject({ changed: 0, results: [{ outcome: "not_found" }] });
    expect(
      await getTaskTimeline(client.db, {
        taskId: created.task.id,
        repositoryIds: [],
      }),
    ).toBeNull();
    expect(
      await operateTasks(client.db, {
        operation: "cancel",
        ids: [created.task.id],
        repositoryIds: [],
        includeGlobal: true,
        reason: "visible",
      }),
    ).toMatchObject({ changed: 1 });
  });

  it("restores failed tasks with an optimistic version check and operator audit", async () => {
    const created = await createAnalysisTask(client.db, {
      taskType: "pr_review",
      subjectRevision: "failed",
      policyVersion: "v1",
      dedupeKey: `${prefix}:dead`,
      payload: {},
    });
    ids.push(created.task.id);
    await client.sql`update analysis_tasks set status='failed',attempt_count=3,last_error_category='timeout' where id=${created.task.id}`;
    const failures = await listDeadLetters(client.db, {
      repositoryIds: [],
      includeGlobal: true,
      limit: 500,
    });
    const task = failures.items.find((item) => item.id === created.task.id)!;
    expect(task).toBeDefined();
    expect(
      await retryDeadLetter(client.db, {
        taskId: task.id,
        actor: "operator",
        reason: "network fixed",
        expectedUpdatedAt: new Date(0),
      }),
    ).toBe(false);
    expect(
      await retryDeadLetter(client.db, {
        taskId: task.id,
        actor: "operator",
        reason: "network fixed",
        expectedUpdatedAt: task.updatedAt,
      }),
    ).toBe(true);
    expect(
      await retryDeadLetter(client.db, {
        taskId: task.id,
        actor: "operator",
        reason: "duplicate",
      }),
    ).toBe(false);
    const [persisted] =
      await client.sql`select status,attempt_count from analysis_tasks where id=${task.id}`;
    expect(persisted).toMatchObject({ status: "queued", attempt_count: 0 });
    const [audit] =
      await client.sql`select data from task_events where task_id=${task.id} and event_type='task.dead_letter_restored'`;
    expect(audit?.data).toMatchObject({
      actor: "operator",
      reason: "network fixed",
      priorAttempts: 3,
      priorStatus: "failed",
    });
  });
  it("does not reuse a durable attempt identity after a manual rerun resets its count", async () => {
    const created = await createAnalysisTask(client.db, {
      taskType: "pr_review",
      subjectRevision: "same-head",
      policyVersion: "v1",
      dedupeKey: `${prefix}:permanent-attempt`,
      priority: 2_147_483_600,
      payload: {},
    });
    ids.push(created.task.id);
    const first = await claimTask(client.db, {
      workerId: "attempt-identity-test",
      leaseDurationMs: 60_000,
    });
    expect(first?.id).toBe(created.task.id);
    expect(first?.attemptId).toMatch(/^[a-f0-9-]{36}$/);
    await cancelTask(client.db, {
      taskId: created.task.id,
      reason: "manual rerun",
    });
    expect(
      await resetTaskToQueued(client.db, { taskId: created.task.id }),
    ).toBe(true);
    const second = await claimTask(client.db, {
      workerId: "attempt-identity-test",
      leaseDurationMs: 60_000,
    });
    expect(second?.id).toBe(first?.id);
    expect(second?.attemptNumber).toBe(1);
    expect(second?.attemptId).toBeTruthy();
    expect(second?.attemptId).not.toBe(first?.attemptId);
  });
});
