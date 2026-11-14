/** 使用真实 PostgreSQL 验证审查重跑不会复活旧的自动合并许可。 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../../packages/database/src/client.js";
import type { LeasedTask } from "../../../packages/domain/src/index.js";
import { assessReview } from "../../../packages/pr-review/src/assessment.js";
import { parseUnifiedDiff } from "../../../packages/pr-review/src/diff.js";
import { renderDiffForModel } from "../../../packages/pr-review/src/context.js";
import type { PrReviewContract } from "../../../packages/pr-review/src/types.js";
import { queueReviewedAutoMerge } from "./auto-merge.js";

const state = vi.hoisted(() => ({ database: null as DatabaseClient | null }));
vi.mock("./runtime.js", () => ({
  database: {
    get db() {
      return state.database!.db;
    },
  },
}));
import { persistSubjectResult } from "./publication.js";

const url = process.env.APERTUREPRISM_INTEGRATION_DATABASE_URL;
const integration = url ? describe : describe.skip;
integration("review publication and automatic merge intent", () => {
  let database: DatabaseClient;
  let repositoryId: string;
  const owner = `merge-worker-${randomUUID().slice(0, 8)}`;
  const fullName = `${owner}/fixture`;
  const sha = "a".repeat(40);
  const context = renderDiffForModel(
    parseUnifiedDiff(
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n",
    ),
  );
  const review: PrReviewContract = {
    contractVersion: "pr-review/v1",
    summary: "The arithmetic change is correct",
    changedFileCount: 1,
    additions: 1,
    deletions: 1,
    overallTone: "approve",
    findings: [],
  };
  const passed = { ...review, assessment: assessReview(review, context) };
  const failed = { ...passed, overallTone: "changes_requested" };
  beforeAll(async () => {
    database = createDatabaseClient(url!);
    state.database = database;
    const [row] = await database.sql<
      { id: string }[]
    >`insert into repositories(github_id,owner,name,installation_id) values(${owner},${owner},'fixture','12345') returning id`;
    repositoryId = row!.id;
  });
  afterAll(async () => {
    if (!database) return;
    await database.sql`delete from pull_request_auto_merges where repository_id=${repositoryId}::uuid`;
    await database.sql`delete from subject_results where task_id in (select id from analysis_tasks where repository_id=${repositoryId}::uuid)`;
    await database.sql`delete from task_attempts where task_id in (select id from analysis_tasks where repository_id=${repositoryId}::uuid)`;
    await database.sql`delete from analysis_tasks where repository_id=${repositoryId}::uuid`;
    await database.sql`delete from repository_settings where repository_id=${repositoryId}::uuid`;
    await database.sql`delete from repositories where id=${repositoryId}::uuid`;
    await database.close();
    state.database = null;
  });
  async function task(): Promise<LeasedTask> {
    const id = randomUUID();
    const attemptId = randomUUID();
    await database.sql`insert into analysis_tasks(id,task_type,repository_id,subject_number,subject_revision,policy_version,dedupe_key,status,payload,lease_owner,lease_expires_at,attempt_count) values(${id}::uuid,'pr_review',${repositoryId}::uuid,1,${sha},'test',${id},'publishing','{}','merge-worker',now()+interval '5 minutes',1)`;
    await database.sql`insert into task_attempts(id,task_id,attempt_number,worker_id) values(${attemptId}::uuid,${id}::uuid,1,'merge-worker')`;
    return {
      id,
      taskType: "pr_review",
      status: "publishing",
      dedupeKey: id,
      leaseOwner: "merge-worker",
      leaseExpiresAt: new Date(Date.now() + 300000),
      heartbeatAt: new Date(),
      attemptNumber: 1,
      attemptId,
      payload: {},
    };
  }
  const identity = (execution: LeasedTask) => ({
    taskId: execution.id,
    repositoryId,
    installationId: "12345",
    repositoryFullName: fullName,
    pullNumber: 1,
    headSha: sha,
  });
  const publication = (execution: LeasedTask, result: unknown) => ({
    taskId: execution.id,
    subjectType: "pr" as const,
    subjectNumber: 1,
    repositoryFullName: fullName,
    revision: sha,
    result,
    execution,
  });
  async function enabled(value: boolean) {
    await database.sql`insert into repository_settings(repository_id,key,value) values(${repositoryId}::uuid,'pr_auto_merge_enabled',${String(value)}) on conflict(repository_id,key) do update set value=excluded.value`;
  }
  it("does not queue a merge before the repository explicitly opts in", async () => {
    await enabled(false);
    const execution = await task();
    await queueReviewedAutoMerge(database.db, {
      ...identity(execution),
      result: passed,
    });
    expect(
      await database.sql`select id from pull_request_auto_merges where task_id=${execution.id}::uuid`,
    ).toHaveLength(0);
  });
  it("queues an approved fully assessed review, then revokes it after a failing rerun", async () => {
    await enabled(true);
    const execution = await task();
    await persistSubjectResult(publication(execution, passed));
    await queueReviewedAutoMerge(database.db, {
      ...identity(execution),
      result: passed,
    });
    const [queued] =
      await database.sql`select status from pull_request_auto_merges where task_id=${execution.id}::uuid`;
    expect(queued?.status).toBe("pending");
    await persistSubjectResult(publication(execution, failed));
    await queueReviewedAutoMerge(database.db, {
      ...identity(execution),
      result: failed,
    });
    const [result] =
      await database.sql`select result from subject_results where task_id=${execution.id}::uuid`;
    expect(result?.result.overallTone).toBe("changes_requested");
    const [canceled] =
      await database.sql`select status,reason from pull_request_auto_merges where task_id=${execution.id}::uuid`;
    expect(canceled).toMatchObject({
      status: "canceled",
      reason: "review_not_approved",
    });
  });
  it("rejects an expired publishing lease without changing its saved result", async () => {
    const execution = await task();
    await persistSubjectResult(publication(execution, failed));
    await database.sql`update analysis_tasks set lease_expires_at=now()-interval '1 second' where id=${execution.id}::uuid`;
    await expect(
      persistSubjectResult(publication(execution, passed)),
    ).rejects.toMatchObject({ name: "AbortError" });
    const [result] =
      await database.sql`select result from subject_results where task_id=${execution.id}::uuid`;
    expect(result?.result.overallTone).toBe("changes_requested");
  });
  it("rejects an old permanent attempt id after a manual rerun resets the counter", async () => {
    const execution = await task();
    await persistSubjectResult(publication(execution, failed));
    await database.sql`delete from task_attempts where task_id=${execution.id}::uuid`;
    await database.sql`insert into task_attempts(task_id,attempt_number,worker_id) values(${execution.id}::uuid,1,'merge-worker')`;
    await expect(
      persistSubjectResult(publication(execution, passed)),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("does not enqueue a request after cancellation", async () => {
    const execution = await task();
    await expect(
      queueReviewedAutoMerge(
        database.db,
        { ...identity(execution), result: passed },
        AbortSignal.abort(),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(
      await database.sql`select id from pull_request_auto_merges where task_id=${execution.id}::uuid`,
    ).toHaveLength(0);
  });
});
