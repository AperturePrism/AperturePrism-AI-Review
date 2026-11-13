import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../../../packages/database/src/index.js";
import {
  GitHubApiError,
  type GitHubClient,
} from "../../../packages/github-adapter/src/index.js";
import { reconcileCheckRuns, terminalCheckRunOutput } from "./check-runs.js";

const payload = {
  installationId: "42",
  repositoryFullName: "owner/repo",
  subjectNumber: 7,
  subjectRevision: "sha",
};
const review = {
  contractVersion: "pr-review/v1",
  summary: "完成",
  changedFileCount: 1,
  additions: 2,
  deletions: 1,
  overallTone: "approve",
  findings: [],
};

function harness(status: "completed" | "failed" | "canceled" = "completed") {
  const state = {
    status,
    acknowledged: false,
    taskVisible: true,
    publicationVisible: true,
    externalId: "101",
    result: review as unknown,
    failAck: false,
  };
  const statements: string[] = [];
  const query = vi.fn(
    async (sql: string, params: unknown[], method: string) => {
      statements.push(sql);
      if (sql.includes('inner join "analysis_tasks"')) {
        expect(sql).toContain('"check_run_completed_at" is null');
        expect(sql).toContain('"analysis_tasks"."status" in');
        expect(sql).toContain(
          'order by "external_publications"."updated_at" asc',
        );
        expect(params).toContain("check_run");
        return {
          rows: state.acknowledged ? [] : [["publication-1", "task-1"]],
        };
      }
      if (method === "all" && sql.includes('from "analysis_tasks"')) {
        expect(sql).toContain("for update skip locked");
        expect(params).toContain("completed");
        expect(params).toContain("failed");
        expect(params).toContain("canceled");
        return {
          rows: state.taskVisible
            ? [[state.status, payload, "lease_expired"]]
            : [],
        };
      }
      if (method === "all" && sql.includes('from "external_publications"')) {
        expect(sql).toContain("for update skip locked");
        expect(params).toContain("task-1");
        return { rows: state.publicationVisible ? [[state.externalId]] : [] };
      }
      if (method === "all" && sql.includes('from "subject_results"')) {
        expect(params).toContain("task-1");
        expect(params).toContain("sha");
        return { rows: [{ result: state.result }].map((row) => [row.result]) };
      }
      if (sql.startsWith('update "external_publications"')) {
        if (sql.includes('set "check_run_completed_at"')) {
          expect(params).toContain("publication-1");
          expect(params).toContain("task-1");
          expect(params).toContain("101");
          expect(sql).toContain('"check_run_completed_at" is null');
          if (state.failAck) throw new Error("database ACK failed");
          state.acknowledged = true;
        }
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  );
  const tx = drizzle(query);
  const db = Object.assign(drizzle(query), {
    transaction: vi.fn(
      async (run: (transaction: typeof tx) => Promise<unknown>) => run(tx),
    ),
  }) as unknown as DatabaseClient["db"];
  const getCheckRun = vi.fn<GitHubClient["getCheckRun"]>().mockResolvedValue({
    id: 101,
    status: "in_progress",
    conclusion: null,
    title: "正在审核中",
    htmlUrl: null,
  });
  const updateCheckRun = vi
    .fn<GitHubClient["updateCheckRun"]>()
    .mockResolvedValue({ id: 101, htmlUrl: "https://github.test/check/101" });
  const onError = vi.fn();
  const run = (signal = new AbortController().signal) =>
    reconcileCheckRuns({
      db,
      github: { getCheckRun, updateCheckRun },
      signal,
      onError,
    });
  return {
    state,
    query,
    statements,
    getCheckRun,
    updateCheckRun,
    onError,
    run,
  };
}

describe("terminalCheckRunOutput", () => {
  it.each(["failed", "canceled"] as const)(
    "uses the %s task state even if an old result exists",
    (status) => {
      expect(
        terminalCheckRunOutput(status, review, "lease_expired"),
      ).toMatchObject({
        conclusion: status === "failed" ? "failure" : "cancelled",
      });
    },
  );
  it("preserves successful and findings conclusions without inventing a review", () => {
    expect(terminalCheckRunOutput("completed", review, null).conclusion).toBe(
      "success",
    );
    expect(terminalCheckRunOutput("completed", null, null).conclusion).toBe(
      "neutral",
    );
  });
});

describe("reconcileCheckRuns", () => {
  it.each(["completed", "failed", "canceled"] as const)(
    "durably closes a %s task's pending Check Run",
    async (status) => {
      const test = harness(status);
      await expect(test.run()).resolves.toBe(1);
      expect(test.updateCheckRun).toHaveBeenCalledWith(
        expect.objectContaining({
          checkRunId: 101,
          status: "completed",
          conclusion:
            status === "completed"
              ? "success"
              : status === "failed"
                ? "failure"
                : "cancelled",
        }),
        expect.any(AbortSignal),
      );
      expect(test.state.acknowledged).toBe(true);
      expect(test.onError).not.toHaveBeenCalled();
      await expect(test.run()).resolves.toBe(0);
      expect(test.updateCheckRun).toHaveBeenCalledTimes(1);
    },
  );

  it("retries a transient completion failure on a later sweep without rerunning analysis", async () => {
    const test = harness("canceled");
    test.updateCheckRun.mockRejectedValueOnce(
      new GitHubApiError("server_error", "temporary 503", 503),
    );
    await expect(test.run()).resolves.toBe(0);
    expect(test.state.acknowledged).toBe(false);
    expect(test.onError).toHaveBeenCalledTimes(1);
    await expect(test.run()).resolves.toBe(1);
    expect(test.updateCheckRun).toHaveBeenCalledTimes(2);
    expect(test.state.acknowledged).toBe(true);
  });

  it("preserves an already-completed GitHub conclusion after an ambiguous previous response", async () => {
    const test = harness("failed");
    test.getCheckRun.mockResolvedValueOnce({
      id: 101,
      status: "completed",
      conclusion: "success",
      title: "already done",
      htmlUrl: null,
    });
    await expect(test.run()).resolves.toBe(1);
    expect(test.updateCheckRun).not.toHaveBeenCalled();
    expect(test.state.acknowledged).toBe(true);
  });

  it("does not mistake a hidden repository or installation 404 for completion", async () => {
    const test = harness();
    test.getCheckRun.mockRejectedValueOnce(
      new GitHubApiError("not_found", "installation inaccessible", 404),
    );
    await expect(test.run()).resolves.toBe(0);
    expect(test.updateCheckRun).not.toHaveBeenCalled();
    expect(test.state.acknowledged).toBe(false);
    await expect(test.run()).resolves.toBe(1);
    expect(test.updateCheckRun).toHaveBeenCalledOnce();
  });

  it.each(["task", "publication"] as const)(
    "rechecks locked %s state and skips stale rerun/replacement candidates",
    async (changed) => {
      const test = harness();
      if (changed === "task") test.state.taskVisible = false;
      else test.state.publicationVisible = false;
      await expect(test.run()).resolves.toBe(0);
      expect(test.getCheckRun).not.toHaveBeenCalled();
      expect(test.updateCheckRun).not.toHaveBeenCalled();
      const taskLock = test.statements.findIndex((statement) =>
        statement.includes('from "analysis_tasks"'),
      );
      const publicationLock = test.statements.findIndex(
        (statement) =>
          statement.includes('from "external_publications"') &&
          statement.includes("for update"),
      );
      if (changed === "publication")
        expect(publicationLock).toBeGreaterThan(taskLock);
    },
  );

  it("also discovers a publication first persisted after task cancellation", async () => {
    const test = harness("canceled");
    await expect(test.run()).resolves.toBe(1);
    const candidateQuery = test.statements[0]!;
    expect(candidateQuery).not.toContain('"analysis_tasks"."updated_at"');
    expect(test.updateCheckRun).toHaveBeenCalledOnce();
  });

  it("leaves pending work on authentication failures and keeps its sweep retryable", async () => {
    const test = harness();
    test.getCheckRun.mockRejectedValueOnce(
      new GitHubApiError("authentication_failed", "forbidden", 403),
    );
    await expect(test.run()).resolves.toBe(0);
    expect(test.state.acknowledged).toBe(false);
    expect(test.updateCheckRun).not.toHaveBeenCalled();
    await expect(test.run()).resolves.toBe(1);
  });

  it("does not acknowledge a successful remote write when the database write fails", async () => {
    const test = harness();
    test.state.failAck = true;
    await expect(test.run()).resolves.toBe(0);
    expect(test.state.acknowledged).toBe(false);
    test.state.failAck = false;
    test.getCheckRun.mockResolvedValueOnce({
      id: 101,
      status: "completed",
      conclusion: "success",
      title: null,
      htmlUrl: null,
    });
    await expect(test.run()).resolves.toBe(1);
    expect(test.updateCheckRun).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled request at its shared deadline and retries later", async () => {
    const test = harness();
    const deadline = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(deadline.signal);
    test.getCheckRun.mockImplementationOnce(
      async (_check, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("deadline exceeded")),
            { once: true },
          );
        }),
    );
    try {
      const pending = test.run();
      await vi.waitFor(() => expect(test.getCheckRun).toHaveBeenCalledOnce());
      deadline.abort();
      await expect(pending).resolves.toBe(0);
      expect(timeout).toHaveBeenCalledWith(15_000);
      expect(test.state.acknowledged).toBe(false);
      expect(test.updateCheckRun).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
    await expect(test.run()).resolves.toBe(1);
  });

  it("does not start remote work during scheduler shutdown", async () => {
    const test = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(test.run(controller.signal)).resolves.toBe(0);
    expect(test.getCheckRun).not.toHaveBeenCalled();
  });
});
