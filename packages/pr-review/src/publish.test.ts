import { describe, expect, it, vi } from "vitest";
import {
  publishAssessment,
  renderReviewBody,
  reviewEventTone,
  type GitHubReviewClient,
  type ReviewPublicationStore,
  type PublishReviewInput,
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

it("uses the assessed publication and keeps accepted findings out of inline comments", async () => {
  const { assessReview } = await import("./assessment.js");
  const { findingFingerprint } = await import("./baseline.js");
  const { renderDiffForModel } = await import("./context.js");
  const { parseUnifiedDiff } = await import("./diff.js");
  const { parseSuppressions } = await import("./suppression.js");
  const finding: Finding = {
    rule: "unsafe-query",
    severity: "high",
    file: "src/db.ts",
    afterLine: 1,
    message: "查询未经约束",
    evidence: "database.query(input);",
    impact: "查询范围可被影响",
    suggestion: "绑定参数",
    confidence: 0.9,
  };
  const original: PrReviewContract = {
    ...review,
    overallTone: "changes_requested",
    findings: [finding],
  };
  const context = renderDiffForModel(
    parseUnifiedDiff(
      "diff --git a/src/db.ts b/src/db.ts\n--- /dev/null\n+++ b/src/db.ts\n@@ -0,0 +1 @@\n+database.query(input);\n",
    ),
  );
  const suppressions = parseSuppressions([
    {
      id: "accepted",
      fingerprint: findingFingerprint(finding),
      reason: "等待维护窗口完成修复",
      owner: "@db",
      expiresAt: "2027-01-01T00:00:00Z",
    },
  ]);
  const assessment = assessReview(original, context, {
    suppressions,
    now: new Date("2026-11-13T00:00:00Z"),
  });
  const publishReview = vi
    .fn<GitHubReviewClient["publishReview"]>()
    .mockResolvedValue({ id: 99 });
  await publishAssessment({
    store: store(),
    github: { publishReview },
    taskId: "task-assessed",
    installationId: "42",
    owner: "owner",
    name: "repo",
    pullNumber: 12,
    revision: "new-head",
    review: original,
    assessment,
  });
  expect(publishReview).toHaveBeenCalledOnce();
  const call = publishReview.mock.calls[0]![0];
  expect(call.comments).toEqual([]);
  expect(call.event).toBe("COMMENT");
  expect(call.body).toContain("已接受问题：1");
  expect(call.body).toContain("审查范围与质量门禁");
  expect(renderReviewBody(original, assessment)).not.toContain(finding.message);
});

function cancellablePublication(
  overrides: Partial<PublishReviewInput> = {},
): PublishReviewInput {
  return {
    store: store(),
    github,
    taskId: "cancel-test",
    installationId: "42",
    owner: "owner",
    name: "repo",
    pullNumber: 10,
    revision: "cancel-head",
    review,
    ...overrides,
  };
}

it("does not read publication state or contact GitHub after prior cancellation", async () => {
  const findExternalObjectId =
    vi.fn<ReviewPublicationStore["findExternalObjectId"]>();
  const publishReview = vi.fn<GitHubReviewClient["publishReview"]>();
  await expect(
    publishAssessment(
      cancellablePublication({
        signal: AbortSignal.abort(),
        github: { publishReview },
        store: { ...store(), findExternalObjectId },
      }),
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(findExternalObjectId).not.toHaveBeenCalled();
  expect(publishReview).not.toHaveBeenCalled();
});

it("does not start an external publication when canceled while looking up idempotency state", async () => {
  const controller = new AbortController();
  const publishReview = vi.fn<GitHubReviewClient["publishReview"]>();
  await expect(
    publishAssessment(
      cancellablePublication({
        signal: controller.signal,
        github: { publishReview },
        store: {
          ...store(),
          findExternalObjectId: async () => {
            controller.abort();
            return null;
          },
        },
      }),
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(publishReview).not.toHaveBeenCalled();
});

it("does not fall back to a second review after the first request was canceled", async () => {
  const controller = new AbortController();
  const publishReview = vi
    .fn<GitHubReviewClient["publishReview"]>()
    .mockImplementation(async () => {
      controller.abort();
      throw Object.assign(new Error("own pull request"), { status: 422 });
    });
  await expect(
    publishAssessment(
      cancellablePublication({
        signal: controller.signal,
        github: { publishReview },
      }),
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(publishReview).toHaveBeenCalledOnce();
});

it("propagates provider AbortError even when its other fields look like a fallback condition", async () => {
  const publishReview = vi
    .fn<GitHubReviewClient["publishReview"]>()
    .mockRejectedValue(
      Object.assign(new Error("own pull request"), {
        name: "AbortError",
        status: 422,
      }),
    );
  await expect(
    publishAssessment(cancellablePublication({ github: { publishReview } })),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(publishReview).toHaveBeenCalledOnce();
});

it("records a successful external publication even if cancellation arrives just after its response", async () => {
  const controller = new AbortController();
  const insert = vi.fn<ReviewPublicationStore["insert"]>().mockResolvedValue();
  const publishReview = vi
    .fn<GitHubReviewClient["publishReview"]>()
    .mockImplementation(async () => {
      controller.abort();
      return { id: 57 };
    });
  const result = await publishAssessment(
    cancellablePublication({
      signal: controller.signal,
      github: { publishReview },
      store: { ...store(), insert },
    }),
  );
  expect(result).toEqual({ reviewId: 57, created: true });
  expect(insert).toHaveBeenCalledOnce();
  expect(insert.mock.calls[0]![0].externalObjectId).toBe("57");
});
