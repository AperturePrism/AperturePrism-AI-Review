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
