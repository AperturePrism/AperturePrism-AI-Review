import { drizzle } from "drizzle-orm/pg-proxy";
import { expect, it, vi } from "vitest";
import type { DatabaseClient } from "../../../packages/database/src/index.js";
import type { GitHubClient } from "../../../packages/github-adapter/src/index.js";
import {
  buildFailureComment,
  buildPlaceholderComment,
} from "../../../packages/issue-analysis/src/comment.js";
import { issueCommentIdempotencyKey } from "../../../packages/issue-analysis/src/payload.js";
import { reconcileIssueComments } from "./issue-comments.js";

function harness(status: "failed" | "completed" = "failed") {
  const attemptId = "7bc740b3-8921-402d-9cb9-a7262a3a54c4";
  const payload = {
    installationId: "42",
    repositoryFullName: "owner/repo",
    subjectNumber: 7,
    subjectRevision: "revision",
  };
  const state = {
    pending: true,
    body: buildPlaceholderComment(attemptId),
    failAck: false,
  };
  const mockDb = drizzle(async (sql, params) => {
    if (sql.includes('inner join "analysis_tasks"')) {
      return {
        rows:
          state.pending && params.includes(status)
            ? [["publication", "task", attemptId]]
            : [],
      };
    }
    if (sql.includes('from "analysis_tasks"')) {
      return {
        rows: params.includes(status)
          ? [[status, payload, "handler_error"]]
          : [],
      };
    }
    if (sql.includes('from "external_publications"')) {
      return {
        rows: [
          [
            issueCommentIdempotencyKey(
              payload.repositoryFullName,
              payload.subjectNumber,
            ),
            "101",
          ],
        ],
      };
    }
    if (sql.startsWith('update "external_publications" set "updated_at"')) {
      return { rows: [] };
    }
    if (
      sql.startsWith(
        'update "external_publications" set "issue_comment_pending_attempt_id"',
      )
    ) {
      if (state.failAck) throw new Error("acknowledgment rolled back");
      state.pending = false;
      return { rows: [["publication"]] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const db = Object.assign(mockDb, {
    transaction: (run: (tx: typeof mockDb) => Promise<unknown>) => run(mockDb),
  }) as unknown as DatabaseClient["db"];
  const getIssueComment = vi
    .fn<GitHubClient["getIssueComment"]>()
    .mockImplementation(async () => ({ id: 101, body: state.body }));
  const updateIssueComment = vi
    .fn<GitHubClient["updateIssueComment"]>()
    .mockImplementation(async ({ body }) => {
      state.body = body;
      return { id: 101, htmlUrl: "https://github.test/comment/101" };
    });
  const onError = vi.fn();
  return {
    state,
    getIssueComment,
    updateIssueComment,
    onError,
    run: () =>
      reconcileIssueComments({
        db,
        github: { getIssueComment, updateIssueComment },
        signal: new AbortController().signal,
        onError,
      }),
  };
}

it("closes a completed task's leftover placeholder without claiming a new result", async () => {
  const test = harness("completed");
  await expect(test.run()).resolves.toBe(1);
  expect(test.state.body).toBe(
    "## 🤖 AperturePrism 分析已结束\n\n此次任务已结束，没有发布新的分析结果。",
  );
  expect(test.updateIssueComment).toHaveBeenCalledOnce();
  expect(test.state.pending).toBe(false);
});

it.each([
  "## AperturePrism analysis result",
  buildFailureComment("handler_error"),
])(
  "does not overwrite a completed task's existing result: %j",
  async (body) => {
    const test = harness("completed");
    test.state.body = body;
    await expect(test.run()).resolves.toBe(1);
    expect(test.updateIssueComment).not.toHaveBeenCalled();
    expect(test.state.pending).toBe(false);
  },
);

it("retries a database acknowledgment failure without repeating a successful PATCH", async () => {
  const test = harness();
  test.state.failAck = true;
  await expect(test.run()).resolves.toBe(0);
  expect(test.onError).toHaveBeenCalledExactlyOnceWith(
    expect.any(Error),
    "publication",
  );
  expect(test.state.pending).toBe(true);
  expect(test.updateIssueComment).toHaveBeenCalledOnce();
  test.state.failAck = false;
  await expect(test.run()).resolves.toBe(1);
  expect(test.getIssueComment).toHaveBeenCalledTimes(2);
  expect(test.updateIssueComment).toHaveBeenCalledOnce();
  expect(test.state.pending).toBe(false);
});

it("shares a finite 15-second deadline across GET and PATCH and retains pending work at timeout", async () => {
  const test = harness();
  const deadline = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(deadline.signal);
  const timeoutError = new DOMException("deadline exceeded", "TimeoutError");
  test.updateIssueComment.mockImplementationOnce(async (_comment, signal) => {
    deadline.abort(timeoutError);
    signal?.throwIfAborted();
    throw new Error("PATCH did not receive the deadline signal");
  });
  try {
    await expect(test.run()).resolves.toBe(0);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(15_000);
    expect(test.onError).toHaveBeenCalledExactlyOnceWith(
      timeoutError,
      "publication",
    );
    expect(test.getIssueComment.mock.calls[0]?.[1]).toBe(
      test.updateIssueComment.mock.calls[0]?.[1],
    );
    expect(test.state.pending).toBe(true);
  } finally {
    timeout.mockRestore();
  }
  await expect(test.run()).resolves.toBe(1);
  expect(test.state.pending).toBe(false);
});
