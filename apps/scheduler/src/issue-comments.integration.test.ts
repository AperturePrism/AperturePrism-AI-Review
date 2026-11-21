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
  type DatabaseClient,
} from "../../../packages/database/src/index.js";
import {
  GitHubApiError,
  type GitHubClient,
} from "../../../packages/github-adapter/src/index.js";
import {
  buildCanceledIssueComment,
  buildFailureComment,
  buildPlaceholderComment,
} from "../../../packages/issue-analysis/src/comment.js";
import { issueCommentIdempotencyKey } from "../../../packages/issue-analysis/src/payload.js";
import { reconcileIssueComments } from "./issue-comments.js";

const databaseUrl = process.env.APERTUREPRISM_INTEGRATION_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const oldest = new Date("2000-01-01T00:00:00Z");

integration("Issue comment reconciliation PostgreSQL fencing", () => {
  let client: DatabaseClient;
  const tasks: string[] = [];
  beforeAll(() => {
    if (!databaseUrl) throw new Error("integration database required");
    client = createDatabaseClient(databaseUrl);
  });
  afterEach(async () => {
    if (!tasks.length) return;
    await client.sql`delete from external_publications where task_id in ${client.sql(tasks)}`;
    await client.sql`delete from analysis_tasks where id in ${client.sql(tasks)}`;
    tasks.length = 0;
  });
  afterAll(async () => {
    await client?.close();
  });

  async function seedTask(input: {
    repository: string;
    status?: "failed" | "canceled" | "retry_wait" | "completed";
  }) {
    const id = randomUUID();
    tasks.push(id);
    const payload = {
      installationId: "42",
      repositoryFullName: input.repository,
      subjectNumber: 7,
      subjectRevision: id,
    };
    await client.sql`insert into analysis_tasks (id,task_type,subject_revision,policy_version,dedupe_key,status,payload,last_error_category)
      values (${id},'issue_analysis',${id},'test',${id},${input.status ?? "failed"},${JSON.stringify(payload)}::jsonb,'handler_error')`;
    return id;
  }

  async function seed(
    input: {
      status?: Parameters<typeof seedTask>[0]["status"];
      repository?: string;
      key?: string;
      externalId?: string | null;
      tracked?: boolean;
      updatedAt?: Date;
    } = {},
  ) {
    const repository = input.repository ?? `owner/test-${randomUUID()}`;
    const taskId = await seedTask({
      repository,
      status: input.status ?? "failed",
    });
    const publicationId = randomUUID();
    const attemptId = input.tracked === false ? null : randomUUID();
    const externalId =
      input.externalId === undefined ? "101" : input.externalId;
    const key = input.key ?? issueCommentIdempotencyKey(repository, 7);
    await client.sql`insert into external_publications (id,task_id,idempotency_key,external_object_id,channel,issue_comment_pending_attempt_id,updated_at)
      values (${publicationId},${taskId},${key},${externalId},'github_issue_comment',${attemptId},${(input.updatedAt ?? oldest).toISOString()})`;
    return { taskId, publicationId, attemptId, repository };
  }

  function github(body: string) {
    return {
      getIssueComment: vi
        .fn<GitHubClient["getIssueComment"]>()
        .mockResolvedValue({ id: 101, body }),
      updateIssueComment: vi
        .fn<GitHubClient["updateIssueComment"]>()
        .mockResolvedValue({
          id: 101,
          htmlUrl: "https://github.test/comment/101",
        }),
    };
  }

  async function publication(id: string) {
    const [row] = await client.sql<
      {
        taskId: string;
        attemptId: string | null;
        updatedAtEpoch: number;
      }[]
    >`select task_id as "taskId", issue_comment_pending_attempt_id as "attemptId", extract(epoch from updated_at)::float8 as "updatedAtEpoch" from external_publications where id=${id}`;
    if (!row) throw new Error("expected publication");
    return row;
  }

  function sweep(
    remote: ReturnType<typeof github>,
    signal = new AbortController().signal,
  ) {
    const onError = vi.fn();
    return {
      onError,
      result: reconcileIssueComments({
        db: client.db,
        github: remote,
        signal,
        onError,
      }),
    };
  }

  it.each([
    ["failed", buildFailureComment("handler_error")],
    ["canceled", buildCanceledIssueComment()],
    [
      "completed",
      "## 🤖 AperturePrism 分析已结束\n\n此次任务已结束，没有发布新的分析结果。",
    ],
  ] as const)(
    "replaces the exact placeholder for a %s task",
    async (status, body) => {
      const tracked = await seed({ status });
      const remote = github(
        buildPlaceholderComment(tracked.attemptId ?? undefined),
      );
      const { onError, result } = sweep(remote);
      await expect(result).resolves.toBe(1);
      const request = {
        installationId: "42",
        owner: "owner",
        name: tracked.repository.split("/")[1],
        commentId: 101,
      };
      const requestSignal = remote.getIssueComment.mock.calls[0]?.[1];
      expect(requestSignal).toBeInstanceOf(AbortSignal);
      expect(remote.getIssueComment).toHaveBeenCalledExactlyOnceWith(
        request,
        requestSignal,
      );
      expect(remote.updateIssueComment).toHaveBeenCalledExactlyOnceWith(
        { ...request, body },
        requestSignal,
      );
      expect((await publication(tracked.publicationId)).attemptId).toBeNull();
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it("does not select retrying, untracked or unpublished rows", async () => {
    await seed({ status: "retry_wait" });
    await seed({ tracked: false });
    await seed({ externalId: null });
    const remote = github("unused");
    const { result, onError } = sweep(remote);
    await expect(result).resolves.toBe(0);
    expect(remote.getIssueComment).not.toHaveBeenCalled();
    expect(remote.updateIssueComment).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps 404s and failed updates pending, rotates them, and retries", async () => {
    const tracked = await seed();
    const remote = github(
      buildPlaceholderComment(tracked.attemptId ?? undefined),
    );
    const notFound = new GitHubApiError("not_found", "Not Found", 404);
    const patchFailure = new Error("PATCH failed");
    remote.getIssueComment.mockRejectedValueOnce(notFound);
    remote.updateIssueComment.mockRejectedValueOnce(patchFailure);

    const first = sweep(remote);
    await expect(first.result).resolves.toBe(0);
    expect(first.onError).toHaveBeenCalledExactlyOnceWith(
      notFound,
      tracked.publicationId,
    );
    expect(remote.updateIssueComment).not.toHaveBeenCalled();
    const pending = await publication(tracked.publicationId);
    expect(pending.attemptId).toBe(tracked.attemptId);
    expect(pending.updatedAtEpoch).toBeGreaterThan(oldest.getTime() / 1000);

    const second = sweep(remote);
    await expect(second.result).resolves.toBe(0);
    expect(second.onError).toHaveBeenCalledExactlyOnceWith(
      patchFailure,
      tracked.publicationId,
    );
    expect((await publication(tracked.publicationId)).attemptId).toBe(
      tracked.attemptId,
    );

    await expect(sweep(remote).result).resolves.toBe(1);
    expect((await publication(tracked.publicationId)).attemptId).toBeNull();
  });

  it.each(["final result", "edited placeholder", "other attempt"])(
    "acknowledges a nonmatching %s without updating GitHub",
    async (kind) => {
      const tracked = await seed();
      const body =
        kind === "edited placeholder"
          ? `${buildPlaceholderComment(tracked.attemptId ?? undefined)}\nMaintainer note.`
          : kind === "other attempt"
            ? buildPlaceholderComment(randomUUID())
            : "## AperturePrism analysis result";
      const remote = github(body);
      const { result, onError } = sweep(remote);
      await expect(result).resolves.toBe(1);
      expect(remote.getIssueComment).toHaveBeenCalledOnce();
      expect(remote.updateIssueComment).not.toHaveBeenCalled();
      expect((await publication(tracked.publicationId)).attemptId).toBeNull();
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it("does not repeat a successful PATCH when acknowledgment was interrupted", async () => {
    const tracked = await seed({ status: "canceled" });
    const remote = github(
      buildPlaceholderComment(tracked.attemptId ?? undefined),
    );
    const shutdown = new AbortController();
    remote.updateIssueComment.mockImplementationOnce(async ({ body }) => {
      remote.getIssueComment.mockResolvedValue({ id: 101, body });
      shutdown.abort();
      return { id: 101, htmlUrl: "https://github.test/comment/101" };
    });

    await expect(sweep(remote, shutdown.signal).result).resolves.toBe(0);
    expect((await publication(tracked.publicationId)).attemptId).toBe(
      tracked.attemptId,
    );
    await expect(sweep(remote).result).resolves.toBe(1);
    expect(remote.updateIssueComment).toHaveBeenCalledOnce();
    expect((await publication(tracked.publicationId)).attemptId).toBeNull();
  });

  it("skips a publication held by a worker and processes it after release", async () => {
    const tracked = await seed();
    const remote = github(
      buildPlaceholderComment(tracked.attemptId ?? undefined),
    );
    await client.sql.begin(async (tx) => {
      await tx`select id from external_publications where id=${tracked.publicationId} for update`;
      await expect(sweep(remote).result).resolves.toBe(0);
      expect(remote.getIssueComment).not.toHaveBeenCalled();
    });
    await expect(sweep(remote).result).resolves.toBe(1);
    expect(remote.updateIssueComment).toHaveBeenCalledOnce();
  });

  it.each(["task", "attempt"])(
    "skips an earlier terminal candidate after its %s was rebound",
    async (binding) => {
      await seed();
      const stale = await seed({
        updatedAt: new Date(oldest.getTime() + 1_000),
      });
      const currentTaskId =
        binding === "task"
          ? await seedTask({ repository: stale.repository, status: "canceled" })
          : stale.taskId;
      // Isolate both guards: change only the task or only the attempt.
      const currentAttemptId =
        binding === "attempt" ? randomUUID() : stale.attemptId;
      const remote = github(
        buildPlaceholderComment(currentAttemptId ?? undefined),
      );
      remote.getIssueComment.mockImplementationOnce(async () => {
        // The first candidate's GET runs after the batch was selected, but before
        // reconciliation has locked the second candidate.
        await client.sql`update external_publications set task_id=${currentTaskId}, issue_comment_pending_attempt_id=${currentAttemptId} where id=${stale.publicationId}`;
        return { id: 101, body: "already final" };
      });

      const first = sweep(remote);
      await expect(first.result).resolves.toBe(1);
      expect(first.onError).not.toHaveBeenCalled();
      expect(remote.getIssueComment).toHaveBeenCalledOnce();
      expect(remote.updateIssueComment).not.toHaveBeenCalled();
      expect(await publication(stale.publicationId)).toMatchObject({
        taskId: currentTaskId,
        attemptId: currentAttemptId,
      });

      await expect(sweep(remote).result).resolves.toBe(1);
      expect(remote.updateIssueComment).toHaveBeenCalledOnce();
      expect((await publication(stale.publicationId)).attemptId).toBeNull();
    },
  );

  it.each([
    { key: "not-the-canonical-key" },
    { repository: "owner/repo/extra" },
    { repository: "owner/.." },
    { externalId: "1e2" },
    { externalId: "9007199254740992" },
  ])(
    "does not call GitHub when publication identity is invalid: %j",
    async (identity) => {
      const tracked = await seed(identity);
      const remote = github("unused");
      const { result, onError } = sweep(remote);
      await expect(result).resolves.toBe(0);
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.any(Error),
        tracked.publicationId,
      );
      expect(remote.getIssueComment).not.toHaveBeenCalled();
      expect(remote.updateIssueComment).not.toHaveBeenCalled();
      expect((await publication(tracked.publicationId)).attemptId).toBe(
        tracked.attemptId,
      );
    },
  );
});
