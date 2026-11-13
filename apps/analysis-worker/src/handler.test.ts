import { describe, expect, it } from "vitest";
import type {
  GradedIssueAnalysis,
  IssueAnalysisResult,
} from "../../../packages/contracts/src/index.js";
import type { LeasedTask } from "../../../packages/domain/src/index.js";
import { GitHubApiError } from "../../../packages/github-adapter/src/index.js";
import type {
  IssueAnalysisOutcome,
  IssueContext,
} from "../../../packages/issue-analysis/src/index.js";
import {
  createIssueAnalysisHandler,
  type IssueAnalysisServices,
} from "./handler.js";

const analysisResult: IssueAnalysisResult = {
  contractVersion: "issue-analysis/v1",
  category: "bug",
  summary: "Crash on startup.",
  severity: "S2",
  priority: "P2",
  quality: "complete",
  evidence: [],
  missingInformation: [],
  suggestedLabels: [],
  suggestedActions: [],
  troubleshooting: [],
  proposedChanges: [],
  confidence: { severity: 0.6, rootCause: 0.6, suggestion: 0.6 },
};

const gradedAnalysis: GradedIssueAnalysis = {
  result: analysisResult,
  adjustments: [],
};

const validOutcome: IssueAnalysisOutcome = {
  outcome: "valid",
  analysis: gradedAnalysis,
  usage: { inputTokens: 10, outputTokens: 5 },
  candidate: {
    provider: "provider-a",
    model: "model-a",
    accountName: "account-a",
  },
  attempts: [],
  durationMs: 12,
};

function leasedTask(overrides: Partial<LeasedTask> = {}): LeasedTask {
  return {
    id: "task-1",
    taskType: "issue_analysis",
    status: "leased",
    dedupeKey: "issue-analysis:repo:1:rev:v1",
    leaseOwner: "worker-a",
    leaseExpiresAt: new Date("2026-08-18T00:01:00Z"),
    heartbeatAt: new Date("2026-08-18T00:00:00Z"),
    attemptNumber: 1,
    payload: {
      installationId: "42",
      repositoryFullName: "owner/repo",
      subjectNumber: 7,
      subjectRevision: "rev-1",
    },
    ...overrides,
  };
}

function context(): IssueContext {
  return {
    repository: { owner: "owner", name: "repo" },
    installationId: "42",
    issue: {
      number: 7,
      title: "Crash",
      body: "It crashes.",
      state: "open",
      htmlUrl: "https://github.test/o/r/issues/7",
      author: "alice",
      createdAt: "2026-08-17T00:00:00Z",
      updatedAt: "2026-08-17T01:00:00Z",
      labels: [],
    },
    comments: [],
    degraded: [],
    estimatedTokens: 5,
    images: [],
  };
}

function makeServices(overrides: Partial<IssueAnalysisServices> = {}): {
  services: IssueAnalysisServices;
  calls: () => string[];
} {
  const calls: string[] = [];
  const base: IssueAnalysisServices = {
    buildContext: async () => {
      calls.push("buildContext");
      return context();
    },
    publishPlaceholder: async () => {
      calls.push("publishPlaceholder");
    },
    analyze: async () => {
      calls.push("analyze");
      return validOutcome;
    },
    recallRelated: async () => {
      calls.push("recallRelated");
      return [];
    },
    publishFinal: async () => {
      calls.push("publishFinal");
    },
    publishFailure: async () => {
      calls.push("publishFailure");
    },
    recordUsage: async () => {
      calls.push("recordUsage");
    },
  };
  const merged = { ...base, ...overrides };
  return { services: merged, calls: () => calls };
}

const neverAbort = new AbortController().signal;

describe("Issue publication cancellation and lease fencing", () => {
  it("does not publish a final result or failure comment after usage recording is canceled", async () => {
    const controller = new AbortController();
    const { services, calls } = makeServices({
      recordUsage: async () => controller.abort(),
    });
    await expect(
      createIssueAnalysisHandler(services)(leasedTask(), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls()).toContain("publishPlaceholder");
    expect(calls()).not.toContain("recallRelated");
    expect(calls()).not.toContain("publishFinal");
    expect(calls()).not.toContain("publishFailure");
  });

  it("does not turn canceled related-issue recall into a successful fallback", async () => {
    const controller = new AbortController();
    const { services, calls } = makeServices({
      recallRelated: async () => {
        controller.abort();
        throw new Error("canceled index request");
      },
    });
    await expect(
      createIssueAnalysisHandler(services)(leasedTask(), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls()).not.toContain("publishFinal");
    expect(calls()).not.toContain("publishFailure");
  });

  it("does not turn canceled spam detection into ordinary analysis", async () => {
    const controller = new AbortController();
    const { services, calls } = makeServices({
      detectSpam: async () => {
        controller.abort();
        throw new Error("canceled detector");
      },
    });
    await expect(
      createIssueAnalysisHandler(services)(leasedTask(), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls()).not.toContain("publishPlaceholder");
    expect(calls()).not.toContain("analyze");
    expect(calls()).not.toContain("publishFailure");
  });

  it("does not write a failure comment when the final publication fence is refused", async () => {
    const { services, calls } = makeServices();
    await expect(
      createIssueAnalysisHandler(services)(leasedTask(), neverAbort, {
        beginPublishing: async () => false,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls()).not.toContain("publishFinal");
    expect(calls()).not.toContain("publishFailure");
  });

  it("does not close spam when the task no longer owns the publication lease", async () => {
    let closed = false;
    const { services, calls } = makeServices({
      detectSpam: async () => ({
        isSpam: true,
        reason: "advertisement",
        confidence: 1,
      }),
      handleSpam: async () => {
        closed = true;
      },
    });
    await expect(
      createIssueAnalysisHandler(services)(leasedTask(), neverAbort, {
        beginPublishing: async () => false,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(closed).toBe(false);
    expect(calls()).not.toContain("analyze");
  });

  it("obtains current ownership before changing an invalid-output placeholder", async () => {
    const { services, calls } = makeServices({
      analyze: async () => ({
        outcome: "invalid",
        usage: { inputTokens: 1, outputTokens: 1 },
        attempts: [],
        durationMs: 1,
      }),
    });
    await expect(
      createIssueAnalysisHandler(services)(leasedTask(), neverAbort, {
        beginPublishing: async () => false,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls()).not.toContain("publishFailure");
  });
});

describe("issue analysis handler", () => {
  it("runs the full vertical flow and completes", async () => {
    const { services, calls } = makeServices();
    const handler = createIssueAnalysisHandler(services);

    const result = await handler(leasedTask(), neverAbort);

    expect(result).toEqual({ outcome: "completed" });
    expect(calls()).toEqual([
      "buildContext",
      "publishPlaceholder",
      "analyze",
      "recordUsage",
      "recallRelated",
      "publishFinal",
    ]);
  });

  it("degrades gracefully when the related-issue recall fails", async () => {
    const { services, calls } = makeServices({
      recallRelated: async () => {
        throw new Error("index down");
      },
    });
    const handler = createIssueAnalysisHandler(services);

    const result = await handler(leasedTask(), neverAbort);

    // The recall failure must not block the core flow or the final publish.
    expect(result).toEqual({ outcome: "completed" });
    expect(calls()).toContain("publishFinal");
  });

  it("fails with invalid_output and skips the final publish on invalid analysis", async () => {
    const { services, calls } = makeServices({
      analyze: async () => ({
        outcome: "invalid" as const,
        usage: { inputTokens: 20, outputTokens: 10 },
        attempts: [],
        durationMs: 30,
      }),
    });
    const handler = createIssueAnalysisHandler(services);

    const result = await handler(leasedTask(), neverAbort);

    expect(result).toEqual({
      outcome: "failed",
      errorCategory: "invalid_output",
    });
    expect(calls()).not.toContain("publishFinal");
    expect(calls()).toContain("recordUsage");
  });

  it("fails unsupported task types without touching the services", async () => {
    const { services, calls } = makeServices();
    const handler = createIssueAnalysisHandler(services);

    const result = await handler(
      leasedTask({ taskType: "pr_review" }),
      neverAbort,
    );

    expect(result).toEqual({
      outcome: "failed",
      errorCategory: "unsupported_task_type",
    });
    expect(calls()).toEqual([]);
  });

  it("marks a missing GitHub object as a permanent failure", async () => {
    const { services } = makeServices({
      buildContext: async () => {
        throw new GitHubApiError("not_found", "issue gone", 404);
      },
    });
    const handler = createIssueAnalysisHandler(services);

    const result = await handler(leasedTask(), neverAbort);

    expect(result).toEqual({
      outcome: "failed",
      errorCategory: "github_not_found",
    });
  });

  it("marks a GitHub auth failure as a permanent failure", async () => {
    const { services } = makeServices({
      publishPlaceholder: async () => {
        throw new GitHubApiError("authentication_failed", "bad token", 401);
      },
    });
    const handler = createIssueAnalysisHandler(services);

    const result = await handler(leasedTask(), neverAbort);

    expect(result).toEqual({
      outcome: "failed",
      errorCategory: "github_auth_failed",
    });
  });

  it("lets retryable errors propagate so the engine retries the task", async () => {
    const { services } = makeServices({
      analyze: async () => {
        throw new Error("provider down");
      },
    });
    const handler = createIssueAnalysisHandler(services);

    await expect(handler(leasedTask(), neverAbort)).rejects.toThrow(
      "provider down",
    );
  });

  it("completes without analysis when the spam detector flags the issue", async () => {
    const handled: string[] = [];
    const { services, calls } = makeServices({
      detectSpam: async () => ({
        isSpam: true,
        reason: "pure advertisement",
        confidence: 0.99,
      }),
      handleSpam: async () => {
        handled.push("handleSpam");
      },
    });
    const handler = createIssueAnalysisHandler(services);

    const result = await handler(leasedTask(), neverAbort);

    expect(result).toEqual({ outcome: "completed" });
    expect(handled).toEqual(["handleSpam"]);
    expect(calls()).toEqual(["buildContext"]);
    expect(calls()).not.toContain("analyze");
  });

  it("completes without analysis when the edit is not worth reanalyzing", async () => {
    const { services, calls } = makeServices({
      shouldReanalyze: async () => false,
    });
    const handler = createIssueAnalysisHandler(services);

    const result = await handler(leasedTask(), neverAbort);

    expect(result).toEqual({ outcome: "completed" });
    // 关键点：跳过时不能发占位评论，否则它会永远停在「正在分析」。
    expect(calls()).toEqual(["buildContext"]);
    expect(calls()).not.toContain("publishPlaceholder");
    expect(calls()).not.toContain("analyze");
  });

  it("skips before the spam detector so a trivial edit costs no model call", async () => {
    const detected: string[] = [];
    const { services } = makeServices({
      shouldReanalyze: async () => false,
      detectSpam: async () => {
        detected.push("detectSpam");
        return null;
      },
    });
    const handler = createIssueAnalysisHandler(services);

    await handler(leasedTask(), neverAbort);

    expect(detected).toEqual([]);
  });

  it("runs the normal flow when the gate allows the reanalysis", async () => {
    const { services, calls } = makeServices({
      shouldReanalyze: async () => true,
    });
    const handler = createIssueAnalysisHandler(services);

    const result = await handler(leasedTask(), neverAbort);

    expect(result).toEqual({ outcome: "completed" });
    expect(calls()).toContain("analyze");
    expect(calls()).toContain("publishFinal");
  });

  it("continues the normal flow when the spam detector throws", async () => {
    const { services, calls } = makeServices({
      detectSpam: async () => {
        throw new Error("detector down");
      },
    });
    const handler = createIssueAnalysisHandler(services);

    const result = await handler(leasedTask(), neverAbort);

    expect(result).toEqual({ outcome: "completed" });
    expect(calls()).toContain("analyze");
    expect(calls()).toContain("publishFinal");
  });

  it("continues the normal flow when the spam detector returns not-spam", async () => {
    const { services, calls } = makeServices({
      detectSpam: async () => ({
        isSpam: false,
        reason: "genuine bug report",
        confidence: 0.8,
      }),
    });
    const handler = createIssueAnalysisHandler(services);

    const result = await handler(leasedTask(), neverAbort);

    expect(result).toEqual({ outcome: "completed" });
    expect(calls()).toContain("analyze");
    expect(calls()).toContain("publishFinal");
    expect(calls()).not.toContain("handleSpam");
  });

  it("swallows handleSpam failures and still completes the spam task", async () => {
    const handled: string[] = [];
    const { services, calls } = makeServices({
      detectSpam: async () => ({
        isSpam: true,
        reason: "spam",
        confidence: 0.95,
      }),
      handleSpam: async () => {
        handled.push("handleSpam");
        throw new Error("github down");
      },
    });
    const handler = createIssueAnalysisHandler(services);

    const result = await handler(leasedTask(), neverAbort);

    expect(result).toEqual({ outcome: "completed" });
    expect(handled).toEqual(["handleSpam"]);
    expect(calls()).not.toContain("analyze");
  });

  it("契约校验失败时收尾占位评论", async () => {
    // 不收尾的话，占位会永远停在「正在分析」，用户看到一条误导性评论。
    const { services, calls } = makeServices({
      analyze: async () => ({
        outcome: "invalid",
        usage: { inputTokens: 1, outputTokens: 1 },
        attempts: [],
        durationMs: 1,
      }),
    });
    const handler = createIssueAnalysisHandler(services);

    const result = await handler(leasedTask(), neverAbort);

    expect(result).toEqual({
      outcome: "failed",
      errorCategory: "invalid_output",
    });
    expect(calls()).toContain("publishFailure");
    expect(calls()).not.toContain("publishFinal");
  });

  it("模型异常时也收尾占位评论", async () => {
    const { services, calls } = makeServices({
      analyze: async () => {
        throw new Error("model gateway 5xx");
      },
    });
    const handler = createIssueAnalysisHandler(services);

    await expect(handler(leasedTask(), neverAbort)).rejects.toThrow(
      "model gateway 5xx",
    );
    expect(calls()).toContain("publishFailure");
  });

  it("收尾占位自身失败不改变任务的失败原因", async () => {
    const { services } = makeServices({
      analyze: async () => ({
        outcome: "invalid",
        usage: { inputTokens: 1, outputTokens: 1 },
        attempts: [],
        durationMs: 1,
      }),
      publishFailure: async () => {
        throw new Error("github down");
      },
    });
    const handler = createIssueAnalysisHandler(services);

    expect(await handler(leasedTask(), neverAbort)).toEqual({
      outcome: "failed",
      errorCategory: "invalid_output",
    });
  });
});
