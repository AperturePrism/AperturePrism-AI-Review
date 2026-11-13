import { expect, it, vi } from "vitest";
import type {
  ModelCandidate,
  ModelProviderAdapter,
} from "../../domain/src/index.js";
import { renderDiffForModel } from "./context.js";
import { parseUnifiedDiff } from "./diff.js";
import { renderInlineComments, renderReviewBody } from "./publish.js";
import { reviewPullRequest } from "./review.js";
import type { Finding, PrReviewContract } from "./types.js";

const candidate: ModelCandidate = {
  provider: "test",
  model: "test-reviewer",
  accountName: "test-account",
};
const context = renderDiffForModel(
  parseUnifiedDiff(
    'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n export const answer = 42;\n+console.log("debug");\n',
  ),
);

it.each(["low", "info"] as const)(
  "keeps %s meaningless changes from the default reviewer through rendering",
  async (severity) => {
    const finding: Finding = {
      rule: "meaningless-change",
      severity,
      file: "src/a.ts",
      message: "新增的临时调试输出与 PR 目标无关。",
      evidence: 'console.log("debug");',
      impact: "增加无关的日志输出。",
      confidence: 0.9,
      suggestion: "删除临时调试输出。",
      afterLine: 2,
    };
    const review: PrReviewContract = {
      contractVersion: "pr-review/v1",
      summary: "存在一处应清理的无价值修改。",
      changedFileCount: 1,
      additions: 1,
      deletions: 0,
      overallTone: "comment",
      findings: [finding],
    };
    const invoke = vi.fn<ModelProviderAdapter["invoke"]>().mockResolvedValue({
      content: JSON.stringify(review),
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    const outcome = await reviewPullRequest(
      {
        adapters: new Map([
          [candidate.provider, { provider: candidate.provider, invoke }],
        ]),
        candidates: [candidate],
        deadlineMs: 10_000,
        retryPolicy: {
          maxAttemptsPerCandidate: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
        },
      },
      context,
    );

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]![1].messages[0]!.content).toContain(
      "meaningless-change",
    );
    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.review.findings).toEqual([finding]);
    expect(renderReviewBody(outcome.review)).toContain(finding.message);
    expect(renderInlineComments(outcome.review)).toEqual([
      expect.objectContaining({ path: finding.file, line: 2 }),
    ]);
  },
);

const validReview: PrReviewContract = {
  contractVersion: "pr-review/v1", summary: "审查通过", changedFileCount: 1,
  additions: 1, deletions: 0, overallTone: "approve", findings: [],
};

function optionsFor(invoke: ModelProviderAdapter["invoke"]) {
  return {
    adapters: new Map([[candidate.provider, { provider: candidate.provider, invoke }]]),
    candidates: [candidate], deadlineMs: 10_000,
    retryPolicy: { maxAttemptsPerCandidate: 1, baseDelayMs: 0, maxDelayMs: 0 },
  };
}

it("persists the actual tool call and result messages from the review", async () => {
  const call = { id: "tool-1", name: "get_git_info", arguments: "{}" };
  const invoke = vi.fn<ModelProviderAdapter["invoke"]>()
    .mockResolvedValueOnce({ content: "读取仓库信息", toolCalls: [call], usage: { inputTokens: 1, outputTokens: 1 } })
    .mockResolvedValueOnce({ content: JSON.stringify(validReview), usage: { inputTokens: 2, outputTokens: 2 } });
  const outcome = await reviewPullRequest({
    ...optionsFor(invoke),
    tools: { context: {
      client: {} as import("../../github-adapter/src/index.js").GitHubClient,
      installationId: "i", owner: "o", name: "r", ref: "head-sha",
    } },
  }, context);
  expect(outcome.outcome).toBe("valid");
  expect(outcome.messages).toContainEqual({ role: "assistant", content: "读取仓库信息", toolCalls: [call] });
  expect(outcome.messages).toContainEqual({ role: "tool", toolCallId: "tool-1", content: "仓库: o/r\n读取 ref: head-sha" });
  expect(outcome.messages?.at(-1)?.content).toBe(JSON.stringify(validReview));
});

it("persists the repaired result as the last assistant message", async () => {
  const invoke = vi.fn<ModelProviderAdapter["invoke"]>()
    .mockResolvedValueOnce({ content: "invalid-json", usage: { inputTokens: 1, outputTokens: 1 } })
    .mockResolvedValueOnce({ content: JSON.stringify(validReview), usage: { inputTokens: 2, outputTokens: 2 } });
  const outcome = await reviewPullRequest(optionsFor(invoke), context);
  expect(outcome.outcome).toBe("valid");
  expect(outcome.messages?.at(-1)).toEqual({ role: "assistant", content: JSON.stringify(validReview) });
  expect(outcome.messages).toContainEqual({ role: "assistant", content: "invalid-json" });
  expect(outcome.messages?.some((message) => message.role === "user" && message.content.includes("没有通过契约校验"))).toBe(true);
});
