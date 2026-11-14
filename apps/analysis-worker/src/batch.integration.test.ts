/** 真实任务表与磁盘批次之间的派发/结果回流；不进行真实付费模型或GitHub调用。 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../../packages/database/src/client.js";
import { createWorkbench } from "../../../packages/review-workbench/src/index.js";
import type {
  Actor,
  Batch,
  Workbench,
} from "../../../packages/review-workbench/src/types.js";
import {
  createBatchTaskStore,
  createWorkbenchBatchDispatcher,
  workbenchBatchTaskKey,
  type WorkbenchBatchDispatcher,
} from "./batch.js";

const databaseUrl = process.env.APERTUREPRISM_INTEGRATION_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("workbench batch PostgreSQL dispatch", () => {
  let database: DatabaseClient;
  let directory: string;
  let workbench: Workbench;
  let dispatcher: WorkbenchBatchDispatcher;
  const repositoryId = randomUUID();
  const owner = `batch-${randomUUID().slice(0, 8)}`;
  const repository = `${owner}/review`;
  const actor: Actor = {
    userId: "test-operator",
    isAdmin: true,
    canAccessRepository: () => true,
  };
  const sha = "b".repeat(40);
  const execute = <T>(action: string, input: Record<string, unknown>) =>
    workbench.execute(actor, {
      action,
      input: { repository, ...input },
    }) as Promise<T>;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("integration database required");
    database = createDatabaseClient(databaseUrl);
    directory = await mkdtemp(join(tmpdir(), "aperture-batch-pg-"));
    workbench = createWorkbench({ dataDirectory: directory });
    await database.sql`insert into repositories (id,github_id,owner,name,installation_id) values (${repositoryId},${repositoryId},${owner},'review','42')`;
    dispatcher = createWorkbenchBatchDispatcher({
      workbench,
      taskDb: database.db,
      workerId: "postgres-batch-worker",
      githubProvider: {
        get: async () => ({
          getPullRequest: async () => ({
            number: 7,
            title: "review",
            body: "",
            state: "open",
            headSha: sha,
            headRef: "main",
            changedFiles: 1,
            additions: 1,
            deletions: 0,
          }),
          getIssue: async () => {
            throw new Error("unexpected issue request");
          },
        }),
      },
    });
  });
  afterAll(async () => {
    await dispatcher?.stop();
    if (database) {
      await database.sql`delete from task_events where task_id in (select id from analysis_tasks where repository_id=${repositoryId})`;
      await database.sql`delete from task_attempts where task_id in (select id from analysis_tasks where repository_id=${repositoryId})`;
      await database.sql`delete from analysis_tasks where repository_id=${repositoryId}`;
      await database.sql`delete from repositories where id=${repositoryId}`;
      await database.close();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("persists a genuine task then completes the batch from the task's terminal state", async () => {
    const batch = await execute<Batch>("batches.create", {
      name: "PG review",
      items: [{ id: "pr", subject: "pr#7", reference: "current" }],
    });
    await execute("batches.start", { id: batch.id });
    expect((await dispatcher.tick()).dispatched).toBe(1);
    const store = createBatchTaskStore(database.db);
    const task = await store.find(
      workbenchBatchTaskKey(batch, batch.items[0]!),
    );
    expect(task).toMatchObject({
      repositoryId,
      status: "queued",
      subjectRevision: sha,
      payload: {
        sourceEvent: "workbench_batch",
        repositoryFullName: repository,
        subjectNumber: 7,
      },
    });
    await dispatcher.tick();
    const [count] =
      await database.sql`select count(*)::int as count from analysis_tasks where repository_id=${repositoryId}`;
    expect(count?.count).toBe(1);
    await database.sql`update analysis_tasks set status='completed' where id=${task!.id}`;
    expect((await dispatcher.tick()).completed).toBe(1);
    const completed = await execute<Batch>("batches.get", { id: batch.id });
    expect(completed.status).toBe("completed");
    expect(completed.items[0]).toMatchObject({
      status: "completed",
      result: { taskId: task!.id, taskStatus: "completed", revision: sha },
    });
  });
});
