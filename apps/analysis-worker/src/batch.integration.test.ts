/** 真实任务表与磁盘批次之间的派发/结果回流；不进行真实付费模型或GitHub调用。 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../../packages/database/src/client.js";
import { createWorkbench } from "../../../packages/review-workbench/src/index.js";
import { createWorkbenchHttp } from "../../../packages/review-workbench/src/http.js";
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
  const dispatchers: WorkbenchBatchDispatcher[] = [];
  let now = new Date("2026-11-13T12:00:00Z");
  const githubReads: string[] = [];
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

  async function http<T>(
    path: string,
    method = "GET",
    body?: Record<string, unknown>,
    hostActor: Actor = actor,
  ): Promise<{ status: number; body: T }> {
    const handle = createWorkbenchHttp(workbench);
    const server = createServer((request, response) => {
      void handle(request, response, hostActor).then((handled) => {
        if (!handled) {
          response.writeHead(404);
          response.end();
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const response = await fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workbench/${path}`,
        {
          method,
          ...(body === undefined
            ? {}
            : {
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ repository, ...body }),
              }),
        },
      );
      return { status: response.status, body: (await response.json()) as T };
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }

  function startDispatcher(workerId: string, engine = workbench) {
    const result = createWorkbenchBatchDispatcher({
      workbench: engine,
      taskDb: database.db,
      workerId,
      githubProvider: {
        get: async () => ({
          getPullRequest: async ({ number }) => {
            githubReads.push(`pr#${number}`);
            return {
              number,
              title: "review",
              body: "",
              state: "open",
              headSha: sha,
              headRef: "main",
              changedFiles: 1,
              additions: 1,
              deletions: 0,
            };
          },
          getIssue: async ({ number }) => {
            githubReads.push(`issue#${number}`);
            return {
              number,
              title: "issue",
              body: "",
              state: "open",
              author: "author",
              htmlUrl: `https://github.com/${repository}/issues/${number}`,
              createdAt: "2026-11-12T12:00:00Z",
              updatedAt: "2026-11-13T12:00:00Z",
              labels: [],
            };
          },
        }),
      },
    });
    dispatchers.push(result);
    return result;
  }

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("integration database required");
    database = createDatabaseClient(databaseUrl);
    directory = await mkdtemp(join(tmpdir(), "aperture-batch-pg-"));
    workbench = createWorkbench({ dataDirectory: directory, now: () => now });
    await database.sql`insert into repositories (id,github_id,owner,name,installation_id) values (${repositoryId},${repositoryId},${owner},'review','42')`;
    dispatcher = startDispatcher("postgres-batch-worker");
  });
  afterAll(async () => {
    await Promise.all(dispatchers.map((worker) => worker.stop()));
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

  it("dispatches a mixed HTTP selection in bounded waves and reconnects real tasks after concurrent worker restart", async () => {
    githubReads.length = 0;
    const created = await http<Batch>("batches", "POST", {
      name: "HTTP mixed selection",
      concurrency: 2,
      items: [
        { id: "issue-8", subject: "issue#8", reference: "current" },
        { id: "pr-7", subject: "pr#7", reference: "current" },
        { id: "pr-9", subject: "pr#9", reference: "current" },
      ],
    });
    expect(created.status).toBe(200);
    const batch = created.body;
    expect(batch.status).toBe("draft");
    const taskRows = () =>
      database.sql`select id, task_type, subject_number, subject_revision, dedupe_key, payload from analysis_tasks where repository_id=${repositoryId} and payload->>'workbenchBatchId'=${batch.id} order by subject_number`;
    await dispatcher.tick();
    expect(await taskRows()).toHaveLength(0);
    expect(
      (
        await http<Batch>(`batches/${batch.id}/start`, "POST", {
          expectedRevision: batch.revision,
        })
      ).status,
    ).toBe(200);

    const competitor = startDispatcher(
      "postgres-batch-competitor",
      createWorkbench({ dataDirectory: directory, now: () => now }),
    );
    const first = await Promise.all([dispatcher.tick(), competitor.tick()]);
    expect(first.reduce((sum, tick) => sum + tick.dispatched, 0)).toBe(2);
    const originalTasks = await taskRows();
    expect(originalTasks).toHaveLength(2);
    expect(
      originalTasks.map((task) => [
        task.task_type,
        task.subject_number,
        task.subject_revision,
      ]),
    ).toEqual([
      ["pr_review", 7, sha],
      ["issue_analysis", 8, "2026-11-13T12:00:00Z"],
    ]);
    expect(githubReads.toSorted()).toEqual(["issue#8", "pr#7"]);
    await Promise.all([dispatcher.tick(), competitor.tick()]);
    expect(await taskRows()).toHaveLength(2);

    await Promise.all([dispatcher.stop(), competitor.stop()]);
    now = new Date(now.getTime() + 61_000);
    const replacement = startDispatcher(
      "postgres-restarted-1",
      createWorkbench({ dataDirectory: directory, now: () => now }),
    );
    const replacementTwo = startDispatcher(
      "postgres-restarted-2",
      createWorkbench({ dataDirectory: directory, now: () => now }),
    );
    await Promise.all([replacement.tick(), replacementTwo.tick()]);
    expect((await taskRows()).map((task) => task.id)).toEqual(
      originalTasks.map((task) => task.id),
    );
    expect(githubReads).toHaveLength(2);
    const recovered = await execute<Batch>("batches.get", { id: batch.id });
    expect(
      recovered.items.filter((item) => item.status === "running"),
    ).toHaveLength(2);
    expect(
      recovered.items
        .slice(0, 2)
        .every(
          (item) =>
            item.attempts === 2 &&
            originalTasks.some((task) => task.id === item.result?.taskId),
        ),
    ).toBe(true);

    await database.sql`update analysis_tasks set status='completed' where repository_id=${repositoryId} and payload->>'workbenchBatchId'=${batch.id}`;
    await Promise.all([replacement.tick(), replacementTwo.tick()]);
    const allTasks = await taskRows();
    expect(allTasks).toHaveLength(3);
    expect(allTasks.find((task) => task.subject_number === 9)).toMatchObject({
      task_type: "pr_review",
      subject_revision: sha,
    });
    expect(githubReads.toSorted()).toEqual(["issue#8", "pr#7", "pr#9"]);
    expect(new Set(allTasks.map((task) => task.dedupe_key)).size).toBe(3);
    await database.sql`update analysis_tasks set status='completed' where repository_id=${repositoryId} and payload->>'workbenchBatchId'=${batch.id}`;
    await Promise.all([replacement.tick(), replacementTwo.tick()]);
    const completed = await http<Batch>(
      `batches/${batch.id}?repository=${encodeURIComponent(repository)}`,
    );
    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe("completed");
    expect(
      completed.body.items.every(
        (item) =>
          item.status === "completed" &&
          typeof item.result?.taskId === "string",
      ),
    ).toBe(true);
    await Promise.all([replacement.stop(), replacementTwo.stop()]);
  });

  it("preserves an HTTP-created draft after denied or stale start and starts that same batch on retry", async () => {
    const created = await http<Batch>("batches", "POST", {
      name: "recoverable start",
      items: [{ subject: "issue#10", reference: "current" }],
    });
    expect(created.status).toBe(200);
    const batch = created.body;
    const viewer: Actor = {
      userId: "view-only",
      isAdmin: false,
      canAccessRepository: (requested, write) =>
        requested === repository && !write,
    };
    expect(
      (await http(`batches/${batch.id}/start`, "POST", {}, viewer)).status,
    ).toBe(404);
    expect(
      (
        await http(`batches/${batch.id}/start`, "POST", {
          expectedRevision: batch.revision + 1,
        })
      ).status,
    ).toBe(409);
    expect((await execute<Batch>("batches.get", { id: batch.id })).status).toBe(
      "draft",
    );
    const [count] =
      await database.sql`select count(*)::int as count from analysis_tasks where repository_id=${repositoryId} and payload->>'workbenchBatchId'=${batch.id}`;
    expect(count?.count).toBe(0);
    expect(
      (
        await http<Batch>(`batches/${batch.id}/start`, "POST", {
          expectedRevision: batch.revision,
        })
      ).body,
    ).toMatchObject({ id: batch.id, status: "queued" });
    expect((await http(`batches/${batch.id}/start`, "POST", {})).status).toBe(
      409,
    );
    expect((await http(`batches/${batch.id}/cancel`, "POST", {})).status).toBe(
      200,
    );
  });
});
