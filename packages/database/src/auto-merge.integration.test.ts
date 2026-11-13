import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "./client.js";
import {
  queuePullRequestAutoMerge,
  type QueuePullRequestAutoMergeInput,
} from "./auto-merge.js";

const databaseUrl = process.env.APERTUREPRISM_INTEGRATION_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration("automatic merge PostgreSQL intent queue", () => {
  let client: DatabaseClient;
  let repositoryId: string;
  const owner = `auto-merge-${Math.random().toString(36).slice(2, 10)}`;
  const name = "fixture";
  const installationId = "12345";
  let counter = 0;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("integration database URL is required");
    client = createDatabaseClient(databaseUrl);
    const [repository] = await client.sql<{ id: string }[]>`
      insert into repositories (github_id,owner,name,installation_id)
      values (${owner},${owner},${name},${installationId}) returning id`;
    repositoryId = repository!.id;
  });

  afterAll(async () => {
    if (!client) return;
    await client.sql`delete from outbox_events where topic='review.auto_merge_recovery' and aggregate_id in (select id from analysis_tasks where repository_id=${repositoryId}::uuid)`;
    await client.sql`delete from pull_request_auto_merges where repository_id=${repositoryId}::uuid`;
    await client.sql`delete from analysis_tasks where repository_id=${repositoryId}::uuid`;
    await client.sql`delete from repositories where id=${repositoryId}::uuid`;
    await client.close();
  });

  async function task(
    pullNumber: number,
    headSha: string,
    options: {
      ageMs?: number;
      status?: "publishing" | "completed" | "queued";
    } = {},
  ): Promise<QueuePullRequestAutoMergeInput> {
    const [row] = await client.sql<{ id: string }[]>`
      insert into analysis_tasks (task_type,repository_id,subject_number,subject_revision,policy_version,dedupe_key,status,payload,created_at)
      values ('pr_review',${repositoryId}::uuid,${pullNumber},${headSha},'auto-merge-test',${`${owner}-${counter++}`},${options.status ?? "publishing"},'{}'::jsonb,${new Date(Date.now() - (options.ageMs ?? 0)).toISOString()}::timestamptz) returning id`;
    return {
      taskId: row!.id,
      repositoryId,
      installationId,
      repositoryFullName: `${owner}/${name}`,
      pullNumber,
      headSha,
      method: "squash",
    };
  }

  it("persists a pending intent and reuses its identity when the task is retried", async () => {
    const input = await task(1, "a".repeat(40));
    const first = await queuePullRequestAutoMerge(client.db, input);
    expect(first?.status).toBe("pending");
    await client.sql`update pull_request_auto_merges set status='blocked',reason='checks_failed',attempts=7,message='old error' where id=${first!.id}::uuid`;
    const retried = await queuePullRequestAutoMerge(client.db, input);
    expect(retried).toEqual(first);
    const [row] =
      await client.sql`select * from pull_request_auto_merges where task_id=${input.taskId}::uuid`;
    expect(row).toMatchObject({
      status: "pending",
      attempts: 0,
      message: null,
      reason: "awaiting_checks",
    });
  });

  it("never resets an already merged request", async () => {
    const input = await task(2, "b".repeat(40));
    const request = await queuePullRequestAutoMerge(client.db, input);
    await client.sql`update pull_request_auto_merges set status='merged',merge_commit_sha=${"f".repeat(40)},attempts=3 where id=${request!.id}::uuid`;
    expect(
      await queuePullRequestAutoMerge(client.db, { ...input, method: "merge" }),
    ).toEqual({ id: request!.id, status: "merged" });
    const [row] =
      await client.sql`select method,attempts,merge_commit_sha from pull_request_auto_merges where id=${request!.id}::uuid`;
    expect(row).toEqual({
      method: "squash",
      attempts: 3,
      merge_commit_sha: "f".repeat(40),
    });
  });

  it("keeps an uncertain merge binding intact across a later worker retry", async () => {
    const input = await task(8, "8".repeat(40));
    const request = await queuePullRequestAutoMerge(client.db, input);
    await client.sql`update pull_request_auto_merges set status='canceled',reason='merge_outcome_unknown',attempts=2 where id=${request!.id}::uuid`;
    await client.sql`insert into outbox_events (id,topic,aggregate_id,payload) values (${request!.id}::uuid,'review.auto_merge_recovery',${input.taskId}::uuid,${JSON.stringify({ requestId: request!.id, taskId: input.taskId, headSha: input.headSha, repositoryId, repositoryFullName: input.repositoryFullName, installationId, pullNumber: input.pullNumber, method: input.method })}::jsonb)`;
    await client.sql`update analysis_tasks set subject_revision=${"9".repeat(40)} where id=${input.taskId}::uuid`;
    expect(
      await queuePullRequestAutoMerge(client.db, {
        ...input,
        headSha: "9".repeat(40),
        method: "merge",
      }),
    ).toEqual({ id: request!.id, status: "canceled" });
    const [row] =
      await client.sql`select head_sha,method,reason,attempts from pull_request_auto_merges where id=${request!.id}::uuid`;
    expect(row).toEqual({
      head_sha: input.headSha,
      method: "squash",
      reason: "merge_outcome_unknown",
      attempts: 2,
    });
    await client.sql`update outbox_events set published_at=now() where id=${request!.id}::uuid`;
    expect(
      (
        await queuePullRequestAutoMerge(client.db, {
          ...input,
          headSha: "9".repeat(40),
          method: "merge",
        })
      )?.status,
    ).toBe("pending");
  });

  it("cancels an older head when a newer reviewed head is queued", async () => {
    const old = await task(3, "c".repeat(40), { ageMs: 3000 });
    const request = await queuePullRequestAutoMerge(client.db, old);
    await client.sql`update pull_request_auto_merges set status='waiting' where id=${request!.id}::uuid`;
    const next = await task(3, "d".repeat(40));
    expect((await queuePullRequestAutoMerge(client.db, next))?.status).toBe(
      "pending",
    );
    const [row] =
      await client.sql`select status,reason,completed_at from pull_request_auto_merges where id=${request!.id}::uuid`;
    expect(row).toMatchObject({ status: "canceled", reason: "head_changed" });
    expect(row!.completed_at).not.toBeNull();
    expect(Number.isFinite(Date.parse(String(row!.completed_at)))).toBe(true);
  });

  it("rejects late delivery from an old task without canceling its newer head", async () => {
    const old = await task(4, "a".repeat(40), { ageMs: 3000 });
    const next = await task(4, "b".repeat(40));
    const request = await queuePullRequestAutoMerge(client.db, next);
    expect(await queuePullRequestAutoMerge(client.db, old)).toBeNull();
    const [row] =
      await client.sql`select status from pull_request_auto_merges where id=${request!.id}::uuid`;
    expect(row!.status).toBe("pending");
  });

  it("serializes concurrent duplicate queue delivery", async () => {
    const input = await task(5, "c".repeat(40));
    const requests = await Promise.all(
      Array.from({ length: 4 }, () =>
        queuePullRequestAutoMerge(client.db, input),
      ),
    );
    expect(new Set(requests.map((request) => request!.id)).size).toBe(1);
    const [count] =
      await client.sql`select count(*)::int as n from pull_request_auto_merges where task_id=${input.taskId}::uuid`;
    expect(count!.n).toBe(1);
  });

  it("refuses a queued task, a changed revision, and another installation", async () => {
    const queued = await task(6, "d".repeat(40), { status: "queued" });
    await expect(queuePullRequestAutoMerge(client.db, queued)).rejects.toThrow(
      "matching published review task",
    );
    const input = await task(7, "e".repeat(40));
    await expect(
      queuePullRequestAutoMerge(client.db, {
        ...input,
        headSha: "f".repeat(40),
      }),
    ).rejects.toThrow("matching published review task");
    await expect(
      queuePullRequestAutoMerge(client.db, {
        ...input,
        installationId: "98765",
      }),
    ).rejects.toThrow("repository identity");
    const [count] =
      await client.sql`select count(*)::int as n from pull_request_auto_merges where repository_id=${repositoryId}::uuid and pull_number in (6,7)`;
    expect(count!.n).toBe(0);
  });
});
