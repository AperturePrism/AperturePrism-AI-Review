/**
 * 审查发布：把已验证契约转换为 GitHub review，使用持久化键避免重复发布。
 * 调用：await publishAssessment({ store, github, taskId, installationId, owner, name,
 *   pullNumber, revision, review, assessment: outcome.assessment })。
 * assessment 可选；传入后才采用其抑制、覆盖与门禁，便于渐进启用。
 */
import type { PrReviewContract } from "./types.js";
import { assessedReview, type ReviewAssessment } from "./assessment.js";

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
  assessment?: ReviewAssessment;
  /** 任务取消或租约丢失时禁止开始新的外部发布。 */
  signal?: AbortSignal;
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

export function renderReviewBody(
  original: PrReviewContract,
  assessment?: ReviewAssessment,
): string {
  const review = assessment ? assessedReview(assessment) : original; // 正式 review 与摘要评论必须采用同一套抑制和门禁。
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
  if (assessment) {
    lines.push("", "### 审查范围与质量门禁", "");
    lines.push(`- 门禁：${assessment.gate.status}`);
    lines.push(
      `- 模型输入覆盖：${(assessment.coverage.changedLineRatio * 100).toFixed(1)}% 变更行；完整文件 ${assessment.coverage.completeFiles}/${assessment.coverage.totalFiles}`,
    );
    lines.push(
      `- 基线：新增 ${assessment.baseline.counts.new}，延续 ${assessment.baseline.counts.existing}，变化 ${assessment.baseline.counts.changed}，已解决 ${assessment.baseline.counts.resolved}`,
    );
    lines.push(
      `- 已接受问题：${assessment.suppressions.suppressed.length}；过期抑制：${assessment.suppressions.expired.length}`,
    );
    for (const reason of assessment.gate.reasons)
      lines.push(`- ${reason.message}`);
    if (assessment.coverage.changedLineRatio < 1)
      lines.push("- 上下文覆盖有限，没有发现问题不代表全部变更已检查。");
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
  input.signal?.throwIfAborted();
  const idempotencyKey = `pr-review:${input.owner}/${input.name}#${input.pullNumber}:${input.revision}`;
  const externalObjectId =
    await input.store.findExternalObjectId(idempotencyKey);
  if (externalObjectId !== null) {
    input.signal?.throwIfAborted();
    await input.store.touch(idempotencyKey);
    return { reviewId: Number(externalObjectId), created: false };
  }
  const publication = input.assessment
    ? { ...input, review: assessedReview(input.assessment) }
    : input;
  input.signal?.throwIfAborted(); // 查询幂等记录期间发生的取消也不能开始外发。
  const published = await publishWithOwnPrFallback(
    publication,
    reviewEventTone(publication.review.overallTone),
  );
  // 已经成功外发后必须记下外部 ID；此时取消不能丢掉幂等记录而导致下次重复发布。
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
      input.signal?.throwIfAborted();
      return await input.github.publishReview({
        installationId: input.installationId,
        owner: input.owner,
        name: input.name,
        pullNumber: input.pullNumber,
        revision: input.revision,
        body: renderReviewBody(input.review, input.assessment),
        event: currentEvent,
        ...(comments === undefined ? {} : { comments }),
      });
    } catch (error) {
      input.signal?.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") throw error;
      // 无效行内锚点与 own-PR 拒绝都可能返回 422。先去锚点重试，保留审查
      // 结论与 event；再把 own PR 的 REQUEST_CHANGES 降级为 COMMENT。
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
