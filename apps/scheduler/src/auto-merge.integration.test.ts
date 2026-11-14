/** PostgreSQL 的真实锁与恢复测试；GitHub 边界使用可观测的客户端，不向外部仓库写入。 */
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createDatabaseClient,
  queuePullRequestAutoMerge,
  type DatabaseClient,
} from "../../../packages/database/src/index.js";
import type { GitHubClient } from "../../../packages/github-adapter/src/index.js";
import { assessReview } from "../../../packages/pr-review/src/assessment.js";
import { renderDiffForModel } from "../../../packages/pr-review/src/context.js";
import { parseUnifiedDiff } from "../../../packages/pr-review/src/diff.js";
import type { PrReviewContract } from "../../../packages/pr-review/src/types.js";
import { reconcilePullRequestAutoMerges } from "./auto-merge.js";

const url = process.env.APERTUREPRISM_INTEGRATION_DATABASE_URL;
const integration = url ? describe : describe.skip;
const headSha = "a".repeat(40);

function approvedReview() {
  const review: PrReviewContract = {
    contractVersion: "pr-review/v1",
    summary: "变更正确",
    changedFileCount: 1,
    additions: 1,
    deletions: 1,
    overallTone: "approve",
    findings: [],
  };
  const context = renderDiffForModel(
    parseUnifiedDiff(
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n",
    ),
  );
  return { ...review, assessment: assessReview(review, context) };
}

integration("automatic pull request merge PostgreSQL fencing", () => {
  let client: DatabaseClient;
  const repositoryIds: string[] = [];
  const taskIds: string[] = [];
  beforeAll(() => {
    if (!url) throw Error("database required");
    client = createDatabaseClient(url);
  });
  afterEach(async () => {
    if (taskIds.length) {
      await client.sql`delete from pull_request_auto_merges where task_id in ${client.sql(taskIds)}`;
      await client.sql`delete from outbox_events where aggregate_id in ${client.sql(taskIds)}`;
      await client.sql`delete from subject_results where task_id in ${client.sql(taskIds)}`;
      await client.sql`delete from task_events where task_id in ${client.sql(taskIds)}`;
      await client.sql`delete from task_attempts where task_id in ${client.sql(taskIds)}`;
      await client.sql`delete from analysis_tasks where id in ${client.sql(taskIds)}`;
    }
    if (repositoryIds.length) {
      await client.sql`delete from repository_settings where repository_id in ${client.sql(repositoryIds)}`;
      await client.sql`delete from repositories where id in ${client.sql(repositoryIds)}`;
    }
    repositoryIds.length = 0;
    taskIds.length = 0;
  });
  afterAll(async () => {
    await client?.close();
  });

  async function seed() {
    const repositoryId = randomUUID();
    const taskId = randomUUID();
    repositoryIds.push(repositoryId);
    taskIds.push(taskId);
    const name = "auto-merge-" + randomUUID();
    const repositoryFullName = "test/" + name;
    const payload = {
      installationId: "42",
      repositoryFullName,
      subjectNumber: 7,
      subjectRevision: headSha,
    };
    await client.sql`insert into repositories (id,github_id,owner,name,installation_id) values (${repositoryId},${randomUUID()},'test',${name},'42')`;
    await client.sql`insert into analysis_tasks (id,task_type,repository_id,subject_number,subject_revision,policy_version,dedupe_key,status,payload) values (${taskId},'pr_review',${repositoryId},7,${headSha},'test',${taskId},'completed',${JSON.stringify(payload)}::jsonb)`;
    await client.sql`insert into subject_results (task_id,subject_type,subject_number,repository_full_name,revision,result,published) values (${taskId},'pr',7,${repositoryFullName},${headSha},${JSON.stringify(approvedReview())}::jsonb,true)`;
    await client.sql`insert into repository_settings (repository_id,key,value) values (${repositoryId},'pr_auto_merge_enabled','true'),(${repositoryId},'pr_auto_merge_method','squash')`;
    await client.sql`insert into outbox_events (topic,aggregate_id,payload,published_at) values ('review.workbench',${taskId},${JSON.stringify({ reference: headSha })}::jsonb,now())`;
    const request = await queuePullRequestAutoMerge(client.db, {
      taskId,
      repositoryId,
      installationId: "42",
      repositoryFullName,
      pullNumber: 7,
      headSha,
      method: "squash",
    });
    if (!request) throw Error("request missing");
    return { taskId, repositoryId, repositoryFullName, requestId: request.id };
  }
  function remote() {
    const state = {
      number: 7,
      state: "open" as const,
      headSha,
      draft: false,
      merged: false,
      mergeCommitSha: null,
      mergeable: true,
      mergeableState: "clean",
      baseRef: "main",
    };
    return {
      state,
      getPullRequestMergeState: vi
        .fn<GitHubClient["getPullRequestMergeState"]>()
        .mockResolvedValue(state),
      getCommitChecks: vi
        .fn<GitHubClient["getCommitChecks"]>()
        .mockResolvedValue({
          checks: [
            {
              name: "tests",
              status: "completed",
              conclusion: "success",
              source: "check_run",
            },
          ],
        }),
      listPullRequestReviewStates: vi
        .fn<GitHubClient["listPullRequestReviewStates"]>()
        .mockResolvedValue([]),
      mergePullRequest: vi
        .fn<GitHubClient["mergePullRequest"]>()
        .mockResolvedValue({
          merged: true,
          sha: "c".repeat(40),
          message: "merged",
        }),
    };
  }
  function run(github: ReturnType<typeof remote>, gate = "pass") {
    return reconcilePullRequestAutoMerges({
      db: client.db,
      github,
      signal: new AbortController().signal,
      workbenchGate: async () => ({ decision: gate }),
      onError: () => undefined,
    });
  }
  async function row(id: string) {
    return (
      await client.sql`select * from pull_request_auto_merges where id=${id}`
    )[0]!;
  }
  async function due(id: string) {
    await client.sql`update pull_request_auto_merges set next_attempt_at=now()-interval '1 second' where id=${id}`;
    await client.sql`update outbox_events set available_at=now()-interval '1 second' where id=${id} and topic='review.auto_merge_recovery'`;
  }

  it("merges only the reviewed SHA, records the current configured method, and never sends twice", async () => {
    const seeded = await seed();
    const github = remote();
    await client.sql`update analysis_tasks set created_at='2026-11-13T00:00:00.000123Z'::timestamptz where id=${seeded.taskId}`;
    await client.sql`update repository_settings set value='rebase' where repository_id=${seeded.repositoryId} and key='pr_auto_merge_method'`;
    expect(await run(github)).toBe(1);
    expect(github.mergePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ expectedHeadSha: headSha, method: "rebase" }),
      expect.any(AbortSignal),
    );
    expect(await row(seeded.requestId)).toMatchObject({
      status: "merged",
      method: "rebase",
      merge_commit_sha: "c".repeat(40),
    });
    expect(await run(github)).toBe(0);
    expect(github.mergePullRequest).toHaveBeenCalledOnce();
  });
  it.each(["newer", "same timestamp"])(
    "cancels when another %s review task supersedes this request",
    async (order) => {
      const seeded = await seed();
      const github = remote();
      const otherTask = randomUUID();
      taskIds.push(otherTask);
      await client.sql`update analysis_tasks set created_at='2026-11-13T00:00:00.000123Z'::timestamptz where id=${seeded.taskId}`;
      const offset = order === "newer" ? "1 microsecond" : "0 microseconds";
      await client.sql`insert into analysis_tasks (id,task_type,repository_id,subject_number,subject_revision,policy_version,dedupe_key,status,payload,created_at)
      select ${otherTask},'pr_review',repository_id,subject_number,subject_revision,'test',${otherTask},'failed',payload,created_at+${offset}::interval from analysis_tasks where id=${seeded.taskId}`;
      await run(github);
      expect((await row(seeded.requestId)).reason).toBe("review_superseded");
      expect(github.mergePullRequest).not.toHaveBeenCalled();
    },
  );
  it("waits for a pending check and merges after it actually becomes successful", async () => {
    const seeded = await seed();
    const github = remote();
    github.getCommitChecks.mockResolvedValueOnce({
      checks: [
        {
          name: "tests",
          status: "in_progress",
          conclusion: null,
          source: "check_run",
        },
      ],
    });
    expect(await run(github)).toBe(0);
    expect((await row(seeded.requestId)).reason).toBe("checks_pending");
    expect(github.mergePullRequest).not.toHaveBeenCalled();
    await due(seeded.requestId);
    expect(await run(github)).toBe(1);
  });
  it("blocks failed checks and missing configured checks, allowing a later successful rerun", async () => {
    const seeded = await seed();
    const github = remote();
    github.getCommitChecks.mockResolvedValueOnce({
      checks: [
        {
          name: "tests",
          status: "completed",
          conclusion: "failure",
          source: "check_run",
        },
      ],
    });
    await run(github);
    expect((await row(seeded.requestId)).status).toBe("blocked");
    await client.sql`insert into repository_settings (repository_id,key,value) values (${seeded.repositoryId},'pr_auto_merge_required_checks','security')`;
    await due(seeded.requestId);
    await run(github);
    expect((await row(seeded.requestId)).reason).toBe(
      "required_checks_missing",
    );
    expect(github.mergePullRequest).not.toHaveBeenCalled();
    github.getCommitChecks.mockResolvedValue({
      checks: [
        {
          name: "security",
          status: "completed",
          conclusion: "success",
          source: "check_run",
        },
      ],
    });
    await due(seeded.requestId);
    expect(await run(github)).toBe(1);
  });
  it("does not merge before workbench delivery or when the current workbench gate blocks", async () => {
    const seeded = await seed();
    const github = remote();
    await client.sql`update outbox_events set published_at=null where aggregate_id=${seeded.taskId}`;
    await run(github);
    expect((await row(seeded.requestId)).reason).toBe("workbench_pending");
    await client.sql`update outbox_events set published_at=now() where aggregate_id=${seeded.taskId}`;
    await due(seeded.requestId);
    await run(github, "fail");
    expect((await row(seeded.requestId)).reason).toBe("workbench_blocked");
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });
  it("rejects a model-only approval and a newer failed review", async () => {
    const seeded = await seed();
    const github = remote();
    const saved = approvedReview();
    await client.sql`update subject_results set result=${JSON.stringify({ ...saved, assessment: undefined })}::jsonb where task_id=${seeded.taskId}`;
    await run(github);
    expect((await row(seeded.requestId)).reason).toBe("review_incomplete");
    await client.sql`update subject_results set result=${JSON.stringify({ ...saved, overallTone: "changes_requested" })}::jsonb where task_id=${seeded.taskId}`;
    await due(seeded.requestId);
    await run(github);
    expect((await row(seeded.requestId)).status).toBe("blocked");
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });
  it("cancels after settings are disabled", async () => {
    const seeded = await seed();
    const github = remote();
    await client.sql`update repository_settings set value='false' where repository_id=${seeded.repositoryId} and key='pr_auto_merge_enabled'`;
    await run(github);
    expect((await row(seeded.requestId)).reason).toBe("disabled");
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });
  it("cancels when a new commit appears during the final GitHub recheck", async () => {
    const seeded = await seed();
    const github = remote();
    github.getPullRequestMergeState
      .mockResolvedValueOnce(github.state)
      .mockResolvedValueOnce({ ...github.state, headSha: "b".repeat(40) });
    await run(github);
    expect((await row(seeded.requestId)).reason).toBe("stale_head");
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });
  it("does not merge draft, conflicting, or changes-requested PRs", async () => {
    const seeded = await seed();
    const github = remote();
    github.getPullRequestMergeState.mockResolvedValueOnce({
      ...github.state,
      draft: true,
    });
    await run(github);
    expect((await row(seeded.requestId)).reason).toBe("draft");
    github.getPullRequestMergeState.mockResolvedValueOnce({
      ...github.state,
      mergeableState: "blocked",
    });
    await due(seeded.requestId);
    await run(github);
    expect((await row(seeded.requestId)).reason).toBe("branch_blocked");
    github.listPullRequestReviewStates.mockResolvedValue([
      {
        user: "reviewer",
        state: "CHANGES_REQUESTED",
        submittedAt: new Date().toISOString(),
        commitId: headSha,
        userType: "User",
      },
    ]);
    await due(seeded.requestId);
    await run(github);
    expect((await row(seeded.requestId)).reason).toBe("changes_requested");
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });
  it("skips a repository held by another scheduler and fences a concurrent task-state change", async () => {
    const seeded = await seed();
    const github = remote();
    let finish!: () => void;
    let started!: () => void;
    const sent = new Promise<void>((resolve) => {
      started = resolve;
    });
    const response = new Promise<void>((resolve) => {
      finish = resolve;
    });
    github.mergePullRequest.mockImplementation(async () => {
      started();
      await response;
      return { merged: true, sha: "c".repeat(40), message: "merged" };
    });
    const first = run(github);
    await sent;
    let resetFinished = false;
    // resetTaskToQueued 只支持 failed/canceled，不会锁 completed 行；
    // 使用实际可匹配当前状态的 UPDATE，验证发布期间的数据库行锁。
    const reset =
      client.sql`update analysis_tasks set status='queued' where id=${seeded.taskId} returning id`.then(
        (value) => {
          resetFinished = true;
          return value;
        },
      );
    try {
      expect(await run(github)).toBe(0);
      expect(github.mergePullRequest).toHaveBeenCalledOnce();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(resetFinished).toBe(false);
    } finally {
      finish();
    }
    expect(await first).toBe(1);
    expect(await reset).toHaveLength(1);
    expect((await row(seeded.requestId)).status).toBe("merged");
  });
  it("recovers a GitHub merge whose response was lost without repeating the write", async () => {
    const seeded = await seed();
    const github = remote();
    github.mergePullRequest.mockRejectedValueOnce(
      new Error("network response lost"),
    );
    await run(github);
    expect((await row(seeded.requestId)).reason).toBe("github_error");
    github.getPullRequestMergeState.mockResolvedValue({
      ...github.state,
      merged: true,
      state: "closed",
      mergeCommitSha: "c".repeat(40),
    });
    await due(seeded.requestId);
    expect(await run(github)).toBe(1);
    expect(github.mergePullRequest).toHaveBeenCalledOnce();
  });
  it.each(["gate changed", "disabled", "task failed"])(
    "recovers an already merged version after %s without a second write",
    async (changed) => {
      const seeded = await seed();
      const github = remote();
      github.mergePullRequest.mockImplementationOnce(async () => {
        const [marker] =
          await client.sql`select published_at,payload from outbox_events where id=${seeded.requestId} and topic='review.auto_merge_recovery'`;
        expect(marker?.published_at).toBeNull();
        expect(marker?.payload.headSha).toBe(headSha);
        throw new Error("remote completed but response lost");
      });
      await run(github);
      if (changed === "disabled") {
        await client.sql`update repository_settings set value='false' where repository_id=${seeded.repositoryId} and key='pr_auto_merge_enabled'`;
        await client.sql`update pull_request_auto_merges set status='canceled',reason='disabled' where id=${seeded.requestId}`;
      }
      if (changed === "task failed")
        await client.sql`update analysis_tasks set status='failed' where id=${seeded.taskId}`;
      github.getPullRequestMergeState.mockResolvedValue({
        ...github.state,
        merged: true,
        state: "closed",
        mergeCommitSha: "c".repeat(40),
      });
      await due(seeded.requestId);
      expect(await run(github, "fail")).toBe(1);
      expect((await row(seeded.requestId)).status).toBe("merged");
      expect(github.mergePullRequest).toHaveBeenCalledOnce();
      const [marker] =
        await client.sql`select published_at from outbox_events where id=${seeded.requestId}`;
      expect(marker?.published_at).not.toBeNull();
    },
  );
  it("keeps canceled uncertain attempts read-only until the remote outcome is known", async () => {
    const seeded = await seed();
    const github = remote();
    github.mergePullRequest.mockRejectedValueOnce(new Error("response lost"));
    await run(github);
    await client.sql`update repository_settings set value='false' where repository_id=${seeded.repositoryId} and key='pr_auto_merge_enabled'`;
    await client.sql`update pull_request_auto_merges set status='canceled',reason='disabled' where id=${seeded.requestId}`;
    await due(seeded.requestId);
    expect(await run(github)).toBe(0);
    expect((await row(seeded.requestId)).reason).toBe("recovery_pending");
    expect(github.mergePullRequest).toHaveBeenCalledOnce();
    await due(seeded.requestId);
    expect(await run(github)).toBe(0);
    expect(github.mergePullRequest).toHaveBeenCalledOnce();
  });
  it("preserves the write-ahead marker through a rolled back acknowledgement transaction", async () => {
    const seeded = await seed();
    const github = remote();
    github.mergePullRequest.mockRejectedValueOnce(new Error("response lost"));
    await expect(
      reconcilePullRequestAutoMerges({
        db: client.db,
        github,
        signal: new AbortController().signal,
        workbenchGate: async () => ({ decision: "pass" }),
        onError: () => {
          throw new Error(
            "simulate process termination before acknowledgement",
          );
        },
      }),
    ).rejects.toThrow("simulate process termination");
    expect((await row(seeded.requestId)).status).toBe("pending");
    const [marker] =
      await client.sql`select id from outbox_events where id=${seeded.requestId} and topic='review.auto_merge_recovery' and published_at is null`;
    expect(marker?.id).toBe(seeded.requestId);
    await client.sql`update pull_request_auto_merges set status='canceled',reason='disabled' where id=${seeded.requestId}`;
    await client.sql`update repository_settings set value='false' where repository_id=${seeded.repositoryId} and key='pr_auto_merge_enabled'`;
    github.getPullRequestMergeState.mockResolvedValue({
      ...github.state,
      merged: true,
      state: "closed",
      mergeCommitSha: "c".repeat(40),
    });
    await due(seeded.requestId);
    expect(await run(github, "fail")).toBe(1);
    expect(github.mergePullRequest).toHaveBeenCalledOnce();
  });
  it("never credits a changed request with an older marker's merge", async () => {
    const seeded = await seed();
    const github = remote();
    github.mergePullRequest.mockRejectedValueOnce(new Error("response lost"));
    await run(github);
    await client.sql`update pull_request_auto_merges set head_sha=${"b".repeat(40)} where id=${seeded.requestId}`;
    github.getPullRequestMergeState.mockResolvedValue({
      ...github.state,
      merged: true,
      state: "closed",
      mergeCommitSha: "c".repeat(40),
    });
    await due(seeded.requestId);
    expect(await run(github)).toBe(0);
    expect((await row(seeded.requestId)).reason).toBe("recovery_mismatch");
    expect(github.mergePullRequest).toHaveBeenCalledOnce();
  });
  it("never sends a merge while the durable marker cannot be committed", async () => {
    const seeded = await seed();
    const github = remote();
    const stop = new AbortController();
    let entered!: () => void;
    const journalStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const journal = {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => {
            entered();
            return new Promise(() => undefined);
          },
        }),
      }),
    } as unknown as DatabaseClient["db"];
    const sweep = reconcilePullRequestAutoMerges({
      db: client.db,
      journalDb: journal,
      github,
      signal: stop.signal,
      workbenchGate: async () => ({ decision: "pass" }),
      onError: () => undefined,
    });
    await journalStarted;
    stop.abort();
    expect(await sweep).toBe(0);
    expect(github.mergePullRequest).not.toHaveBeenCalled();
    expect((await row(seeded.requestId)).reason).toBe("github_error");
  });
  it("commits the marker through a separate journal when the main pool has only one connection", async () => {
    await seed();
    const github = remote();
    const previous = process.env.DATABASE_POOL_MAX;
    process.env.DATABASE_POOL_MAX = "1";
    const single = createDatabaseClient(url!);
    const journal = createDatabaseClient(url!);
    if (previous === undefined) delete process.env.DATABASE_POOL_MAX;
    else process.env.DATABASE_POOL_MAX = previous;
    try {
      expect(
        await reconcilePullRequestAutoMerges({
          db: single.db,
          journalDb: journal.db,
          github,
          signal: new AbortController().signal,
          workbenchGate: async () => ({ decision: "pass" }),
          onError: (error) => {
            throw error;
          },
        }),
      ).toBe(1);
      expect(github.mergePullRequest).toHaveBeenCalledOnce();
    } finally {
      await Promise.all([single.close(), journal.close()]);
    }
  });
});
