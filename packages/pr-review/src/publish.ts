import type { PrReviewContract } from "./types.js";

/**
 * The persisted bookkeeping a publication needs. The worker supplies a
 * Drizzle-backed implementation so this module never imports Drizzle tables.
 */
export type ReviewPublicationStore = {
  findExternalObjectId: (idempotencyKey: string) => Promise<string | null>;
  insert: (input: {
    taskId: string;
    idempotencyKey: string;
    externalObjectId: string;
    channel: string;
  }) => Promise<void>;
  touch: (idempotencyKey: string) => Promise<void>;
};

/**
 * The small GitHub surface PR-review publishing needs. Kept separate from the
 * generic GitHubClient because a PR review is a different resource than an
 * issue comment and the caller supplies the parsed data + review body it owns.
 */
export type GitHubReviewClient = {
  publishReview: (input: {
    installationId: string;
    owner: string;
    name: string;
    pullNumber: number;
    /** `revision` is the PR head SHA; publishing is tied to it for idempotency. */
    revision: string;
    body: string;
    event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
    /** Optional inline review comments anchored to new-file lines. */
    comments?: readonly { path: string; line: number; body: string }[];
  }) => Promise<{ id: number }>;
};

export type PublishReviewInput = {
  store: ReviewPublicationStore;
  github: GitHubReviewClient;
  taskId: string;
  installationId: string;
  owner: string;
  name: string;
  pullNumber: number;
  revision: string;
  review: PrReviewContract;
};

export type PublishReviewResult = {
  reviewId: number;
  created: boolean;
};

export function reviewEventTone(
  tone: PrReviewContract["overallTone"],
): "COMMENT" | "APPROVE" | "REQUEST_CHANGES" {
  if (tone === "approve") return "APPROVE";
  if (tone === "changes_requested") return "REQUEST_CHANGES";
  return "COMMENT";
}

export function renderReviewBody(review: PrReviewContract): string {
  const lines: string[] = [`## 审查总结`, review.summary, ""];
  if (review.findings.length > 0) {
    lines.push(`### 发现的问题 (${review.findings.length})`);
    for (const finding of review.findings) {
      lines.push(
        `- **${finding.severity.toUpperCase()}** \`${finding.rule}\` ${finding.file}${finding.afterLine > 0 ? `:${finding.afterLine}` : ""}`,
      );
      lines.push(`  - ${finding.message}`);
      lines.push(`  - 建议: ${finding.suggestion}`);
    }
  }
  return lines.join("\n");
}

/** Max inline comments per review to keep GitHub rate limits sane. */
const MAX_INLINE_COMMENTS = 5;

/**
 * Maps findings that carry a new-file line anchor into inline review comments.
 * Findings without a known line (afterLine === 0) are skipped — they cannot be
 * pinned to the diff and are already fully covered by the review body.
 */
export function renderInlineComments(
  review: PrReviewContract,
): readonly { path: string; line: number; body: string }[] {
  const comments: { path: string; line: number; body: string }[] = [];
  for (const finding of review.findings) {
    if (comments.length >= MAX_INLINE_COMMENTS) break;
    if (finding.afterLine <= 0) continue;
    comments.push({
      path: finding.file,
      line: finding.afterLine,
      body: `**${finding.severity.toUpperCase()}** · \`${finding.rule}\`\n\n${finding.message}\n\n建议：${finding.suggestion}`,
    });
  }
  return comments;
}

/**
 * Publishes a PR review tied to a head SHA. Because a GitHub review is
 * immutable, a retried or re-run task on the same head SHA must not create a
 * second review — `external_object_id` is persisted so the first call wins and
 * later calls only touch the bookkeeping. A new head SHA gets a fresh
 * idempotency key, which is how "new head SHA task creation" is kept idempotent.
 */
export async function publishAssessment(
  input: PublishReviewInput,
): Promise<PublishReviewResult> {
  const idempotencyKey = `pr-review:${input.owner}/${input.name}#${input.pullNumber}:${input.revision}`;
  const externalObjectId = await input.store.findExternalObjectId(
    idempotencyKey,
  );
  if (externalObjectId !== null) {
    await input.store.touch(idempotencyKey);
    return { reviewId: Number(externalObjectId), created: false };
  }
  const published = await publishWithOwnPrFallback(input, reviewEventTone(input.review.overallTone));
  await input.store.insert({
    taskId: input.taskId,
    idempotencyKey,
    externalObjectId: String(published.id),
    channel: "github_pull_request_review",
  });
  return { reviewId: published.id, created: true };
}

/**
 * GitHub rejects `REQUEST_CHANGES` on a pull request authored by the same bot
 * ("Can not request changes on your own pull request"). When the review model
 * judges changes_requested but the PR is the bot's own, degrade once to a
 * COMMENT review so the pipeline still completes. The finding text already
 * carries the requested changes, so nothing is lost.
 */
async function publishWithOwnPrFallback(
  input: PublishReviewInput,
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
): Promise<{ id: number }> {
  let comments: ReturnType<typeof renderInlineComments> | undefined =
    renderInlineComments(input.review);
  let currentEvent = event;
  for (;;) {
    try {
      return await input.github.publishReview({
        installationId: input.installationId,
        owner: input.owner,
        name: input.name,
        pullNumber: input.pullNumber,
        revision: input.revision,
        body: renderReviewBody(input.review),
        event: currentEvent,
        ...(comments === undefined ? {} : { comments }),
      });
    } catch (error) {
      // An invalid inline anchor can produce the same 422 as an own-PR
      // rejection. Remove anchors first, preserving the model's review event.
      if (comments && comments.length > 0 && isGithubStatus(error, 422)) {
        comments = undefined;
        continue;
      }
      const ownPrRejection =
        currentEvent === "REQUEST_CHANGES" &&
        (isGithubStatus(error, 422) ||
          (error instanceof Error && /own pull request/i.test(error.message)));
      if (ownPrRejection) {
        currentEvent = "COMMENT";
        continue;
      }
      throw error;
    }
  }
}

function isGithubStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === status
  );
}