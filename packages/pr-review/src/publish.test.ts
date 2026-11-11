import { describe, expect, it, vi } from "vitest";
import {
  publishAssessment,
  renderReviewBody,
  reviewEventTone,
  type GitHubReviewClient,
  type ReviewPublicationStore,
} from "./publish.js";
import type { Finding, PrReviewContract } from "./types.js";
import { parsePrReviewJson } from "./validate.js";

const review: PrReviewContract = {
  contractVersion: "pr-review/v1",
  summary: "looks fine",
  changedFileCount: 1,
  additions: 2,
  deletions: 0,
  overallTone: "changes_requested",
  findings: [],
};

function store(): ReviewPublicationStore & { touches: () => number } {
  const versions = new Map<string, string>();
  let touches = 0;
  return {
    touches: () => touches,
    findExternalObjectId: async (key) => versions.get(key) ?? null,
    insert: async (input) => {
      versions.set(input.idempotencyKey, input.externalObjectId);
    },
    touch: async () => {
      touches += 1;
    },
  };
}

const github: GitHubReviewClient = {
  publishReview: async ({ revision }) => ({ id: revision.length }),
};

const meaninglessChange: Finding = {
  rule: "meaningless-change",
  severity: "low",
  file: "src/a.ts",
  message: "该调试输出与修复目标无关，且未提供必要的日志诊断信息。",
  evidence: 'console.log("debug");',
  impact: "增加无关日志噪声。",
  confidence: 0.9,
  suggestion: "移除误提交的调试输出。",
  afterLine: 4,
};

describe("publishAssessment", () => {
  it.each(["low", "info"] as const)(
    "publishes parsed %s meaningless changes in the review body and inline comments",
    async (severity) => {
      const finding = { ...meaninglessChange, severity };
      const parsed = parsePrReviewJson(
        JSON.stringify({
          ...review,
          overallTone: "comment",
          findings: [
            finding,
            { ...finding, rule: "style-naming", message: "unwanted style nit" },
            {
              ...finding,
              file: "src/unverified.ts",
              confidence: 0.49,
              message: "unsupported meaningless change",
            },
          ],
        }),
      );
      expect(parsed.outcome).toBe("valid");
      if (parsed.outcome !== "valid") return;
      expect(parsed.review.findings).toEqual([finding]);
      const publishReview = vi
        .fn<GitHubReviewClient["publishReview"]>()
        .mockResolvedValue({ id: 7 });

      await publishAssessment({
        store: store(),
        github: { publishReview },
        taskId: "t",
        installationId: "42",
        owner: "o",
        name: "r",
        pullNumber: 9,
        revision: "meaningless-change-sha",
        review: parsed.review,
      });

      expect(publishReview).toHaveBeenCalledOnce();
      const published = publishReview.mock.calls[0]![0];
      expect(published.event).toBe("COMMENT");
      expect(published.body).toContain("### 发现的问题 (1)");
      expect(published.body).toContain(
        `**${severity.toUpperCase()}** \`meaningless-change\``,
      );
      expect(published.body).toContain(finding.message);
      expect(published.body).not.toContain("unwanted style nit");
      expect(published.body).not.toContain("unsupported meaningless change");
      expect(published.comments).toEqual([
        {
          path: finding.file,
          line: finding.afterLine,
          body: `**${severity.toUpperCase()}** · \`meaningless-change\`\n\n${finding.message}\n\n建议：${finding.suggestion}`,
        },
      ]);
    },
  );

  it("creates once per head SHA and reuses the idempotency record", async () => {
    const s = store();
    const first = await publishAssessment({
      store: s,
      github,
      taskId: "t",
      installationId: "42",
      owner: "o",
      name: "r",
      pullNumber: 9,
      revision: "abc123",
      review,
    });
    expect(first.created).toBe(true);

    const second = await publishAssessment({
      store: s,
      github,
      taskId: "t",
      installationId: "42",
      owner: "o",
      name: "r",
      pullNumber: 9,
      revision: "abc123",
      review,
    });
    expect(second.created).toBe(false);
    expect(second.reviewId).toBe(first.reviewId);
  });

  it("publishes a new review for a new head SHA", async () => {
    const s = store();
    await publishAssessment({
      store: s,
      github,
      taskId: "t",
      installationId: "42",
      owner: "o",
      name: "r",
      pullNumber: 9,
      revision: "hash1",
      review,
    });
    const second = await publishAssessment({
      store: s,
      github,
      taskId: "t",
      installationId: "42",
      owner: "o",
      name: "r",
      pullNumber: 9,
      revision: "hash2",
      review,
    });
    expect(second.created).toBe(true);
  });

  it("degrades REQUEST_CHANGES to COMMENT on the bot's own PR", async () => {
    const events: string[] = [];
    const ownPr: GitHubReviewClient = {
      publishReview: async ({ event }) => {
        events.push(event);
        if (event === "REQUEST_CHANGES") {
          const err = new Error("GitHub responded with 422") as Error & {
            status?: number;
          };
          err.status = 422;
          throw err;
        }
        return { id: 7 };
      },
    };
    const result = await publishAssessment({
      store: store(),
      github: ownPr,
      taskId: "t",
      installationId: "42",
      owner: "o",
      name: "r",
      pullNumber: 9,
      revision: "hash3",
      review,
    });
    expect(events).toEqual(["REQUEST_CHANGES", "COMMENT"]);
    expect(result.created).toBe(true);
    expect(result.reviewId).toBe(7);
  });
});

describe("review rendering", () => {
  it("maps overall tone to a review event", () => {
    expect(reviewEventTone("approve")).toBe("APPROVE");
    expect(reviewEventTone("changes_requested")).toBe("REQUEST_CHANGES");
    expect(reviewEventTone("comment")).toBe("COMMENT");
  });

  it("keeps unanchored meaningless changes in the body without creating inline comments", async () => {
    const parsed = parsePrReviewJson(
      JSON.stringify({
        ...review,
        overallTone: "comment",
        findings: [{ ...meaninglessChange, severity: "info", afterLine: 0 }],
      }),
    );
    expect(parsed.outcome).toBe("valid");
    if (parsed.outcome !== "valid") return;
    const publishReview = vi
      .fn<GitHubReviewClient["publishReview"]>()
      .mockResolvedValue({ id: 8 });
    await publishAssessment({
      store: store(),
      github: { publishReview },
      taskId: "t",
      installationId: "42",
      owner: "o",
      name: "r",
      pullNumber: 9,
      revision: "unanchored-change-sha",
      review: parsed.review,
    });
    const published = publishReview.mock.calls[0]![0];
    expect(published.body).toContain("**INFO** `meaningless-change` src/a.ts");
    expect(published.body).toContain(meaninglessChange.message);
    expect(published.comments).toEqual([]);
  });

  it("renders a human-readable review body", () => {
    const body = renderReviewBody({ ...review, overallTone: "approve" });
    expect(body).toContain("looks fine");
  });
});
