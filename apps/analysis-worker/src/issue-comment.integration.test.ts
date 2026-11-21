import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../../packages/database/src/index.js";
import type { LeasedTask } from "../../../packages/domain/src/index.js";
import type { GitHubClient } from "../../../packages/github-adapter/src/index.js";
import {
  buildPlaceholderComment,
  issueCommentIdempotencyKey,
} from "../../../packages/issue-analysis/src/index.js";
import { publishTrackedIssueComment } from "./issue-comment.js";

const databaseUrl = process.env.APERTUREPRISM_INTEGRATION_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("Issue comment publication PostgreSQL fencing", () => {
  let client: DatabaseClient;
  const taskIds: string[] = [];
  beforeAll(() => {
    if (!databaseUrl) throw new Error("integration database required");
    client = createDatabaseClient(databaseUrl);
  });
  afterAll(async () => {
    if (!client) return;
    if (taskIds.length) {
      await client.sql`delete from external_publications where task_id in ${client.sql(taskIds)}`;
      await client.sql`delete from task_attempts where task_id in ${client.sql(taskIds)}`;
      await client.sql`delete from analysis_tasks where id in ${client.sql(taskIds)}`;
    }
    await client.close();
  });

  async function setup() {
    const identity = { owner: "issue-comment-test", name: randomUUID() };
    const payload = {
      repositoryFullName: `${identity.owner}/${identity.name}`,
      subjectNumber: 7,
      subjectRevision: randomUUID(),
      installationId: "42",
    };
    const key = issueCommentIdempotencyKey(payload.repositoryFullName, 7);
    const github = {
      createIssueComment: vi
        .fn<GitHubClient["createIssueComment"]>()
        .mockResolvedValue({
          id: 101,
          htmlUrl: "https://github.test/comment/101",
        }),
      updateIssueComment: vi
        .fn<GitHubClient["updateIssueComment"]>()
        .mockResolvedValue({
          id: 101,
          htmlUrl: "https://github.test/comment/101",
        }),
    };
    const signal = new AbortController().signal;
    const db = client.db;
    async function seed(
      createdAt: string,
    ): Promise<LeasedTask & { attemptId: string }> {
      const id = randomUUID();
      const attemptId = randomUUID();
      taskIds.push(id);
      const now = new Date();
      const leaseExpiresAt = new Date(now.getTime() + 60_000);
      await client.sql`insert into analysis_tasks (id,task_type,subject_revision,policy_version,dedupe_key,status,payload,lease_owner,lease_expires_at,attempt_count,created_at)
        values (${id},'issue_analysis',${payload.subjectRevision},'test',${id},'running',${JSON.stringify(payload)}::jsonb,'worker',${leaseExpiresAt.toISOString()},1,${createdAt})`;
      await client.sql`insert into task_attempts (id,task_id,attempt_number,worker_id) values (${attemptId},${id},1,'worker')`;
      return {
        id,
        taskType: "issue_analysis",
        status: "running",
        dedupeKey: id,
        leaseOwner: "worker",
        leaseExpiresAt,
        heartbeatAt: now,
        attemptNumber: 1,
        attemptId,
        payload,
      };
    }
    function placeholder(task: LeasedTask) {
      return publishTrackedIssueComment({
        db,
        github,
        task,
        payload,
        identity,
        signal,
        kind: "placeholder",
      });
    }
    async function final(task: LeasedTask) {
      await client.sql`update analysis_tasks set status='publishing' where id=${task.id}`;
      return publishTrackedIssueComment({
        db,
        github,
        task,
        payload,
        identity,
        signal,
        kind: "final",
        body: "analysis result",
      });
    }
    async function row() {
      const [record] =
        await client.sql`select task_id,external_object_id,issue_comment_pending_attempt_id from external_publications where idempotency_key=${key}`;
      return record;
    }
    return { github, seed, placeholder, final, row };
  }

  it("creates one comment, rebinds it to the newer task and fences the older result", async () => {
    const test = await setup();
    const older = await test.seed("2026-11-19T12:00:00Z");
    const newer = await test.seed("2026-11-19T12:00:01Z");
    await expect(test.placeholder(older)).resolves.toBe(true);
    expect(await test.row()).toMatchObject({
      task_id: older.id,
      external_object_id: "101",
      issue_comment_pending_attempt_id: older.attemptId,
    });
    await expect(test.placeholder(newer)).resolves.toBe(true);
    await expect(test.placeholder(older)).resolves.toBe(false);
    await expect(test.final(older)).resolves.toBe(false);
    expect(test.github.updateIssueComment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        commentId: 101,
        body: buildPlaceholderComment(newer.attemptId),
      }),
      expect.any(AbortSignal),
    );
    await expect(test.final(newer)).resolves.toBe(true);
    expect(test.github.createIssueComment).toHaveBeenCalledOnce();
    expect(test.github.updateIssueComment).toHaveBeenLastCalledWith(
      expect.objectContaining({ commentId: 101, body: "analysis result" }),
      expect.any(AbortSignal),
    );
    expect(await test.row()).toMatchObject({
      task_id: newer.id,
      external_object_id: "101",
      issue_comment_pending_attempt_id: null,
    });
  });

  it("serializes concurrent first writes without posting duplicate comments", async () => {
    const test = await setup();
    const older = await test.seed("2026-11-19T12:00:00Z");
    const newer = await test.seed("2026-11-19T12:00:01Z");
    await Promise.all([test.placeholder(older), test.placeholder(newer)]);
    expect(test.github.createIssueComment).toHaveBeenCalledOnce();
    expect(await test.row()).toMatchObject({
      task_id: newer.id,
      issue_comment_pending_attempt_id: newer.attemptId,
    });
  });

  it("does not let a replaced attempt publish after a same-task rerun", async () => {
    const test = await setup();
    const previous = await test.seed("2026-11-19T12:00:00Z");
    await test.placeholder(previous);
    const attemptId = randomUUID();
    await client.sql`update task_attempts set id=${attemptId} where id=${previous.attemptId}`;
    await expect(test.placeholder(previous)).rejects.toMatchObject({
      name: "AbortError",
    });
    await test.placeholder({ ...previous, attemptId });
    expect(test.github.createIssueComment).toHaveBeenCalledOnce();
    expect(await test.row()).toMatchObject({
      issue_comment_pending_attempt_id: attemptId,
    });
  });
});
