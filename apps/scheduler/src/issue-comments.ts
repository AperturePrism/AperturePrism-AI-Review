import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import {
  analysisTasks,
  externalPublications,
  type DatabaseClient,
} from "../../../packages/database/src/index.js";
import type { GitHubClient } from "../../../packages/github-adapter/src/index.js";
import {
  buildCanceledIssueComment,
  buildFailureComment,
  buildPlaceholderComment,
} from "../../../packages/issue-analysis/src/comment.js";
import {
  issueCommentIdempotencyKey,
  parseIssueTaskPayload,
  repositoryOwnerName,
} from "../../../packages/issue-analysis/src/payload.js";

type IssueCommentClient = Pick<
  GitHubClient,
  "getIssueComment" | "updateIssueComment"
>;
const terminalStatuses = ["failed", "canceled", "completed"] as const;
const completedWithoutResultComment =
  "## 🤖 AperturePrism 分析已结束\n\n此次任务已结束，没有发布新的分析结果。";
const channel = "github_issue_comment";
const batchSize = 20;
const requestTimeoutMs = 15_000;

export async function reconcileIssueComments(input: {
  db: DatabaseClient["db"];
  github: IssueCommentClient;
  signal: AbortSignal;
  onError: (error: unknown, publicationId: string) => void;
}): Promise<number> {
  const { db, github, signal, onError } = input;
  const candidates = await db
    .select({
      id: externalPublications.id,
      taskId: externalPublications.taskId,
      attemptId: externalPublications.issueCommentPendingAttemptId,
    })
    .from(externalPublications)
    .innerJoin(analysisTasks, eq(analysisTasks.id, externalPublications.taskId))
    .where(
      and(
        eq(externalPublications.channel, channel),
        isNotNull(externalPublications.externalObjectId),
        isNotNull(externalPublications.issueCommentPendingAttemptId),
        eq(analysisTasks.taskType, "issue_analysis"),
        inArray(analysisTasks.status, terminalStatuses),
      ),
    )
    .orderBy(asc(externalPublications.updatedAt), asc(externalPublications.id))
    .limit(batchSize);

  let finalized = 0;
  for (const { id, taskId, attemptId } of candidates) {
    if (signal.aborted) break;
    if (!attemptId) continue;
    try {
      const acknowledged = await db.transaction(async (tx) => {
        // Match worker lock order; keep both locks while checking and updating GitHub.
        const [task] = await tx
          .select({
            status: analysisTasks.status,
            payload: analysisTasks.payload,
            errorCategory: analysisTasks.lastErrorCategory,
          })
          .from(analysisTasks)
          .where(
            and(
              eq(analysisTasks.id, taskId),
              eq(analysisTasks.taskType, "issue_analysis"),
              inArray(analysisTasks.status, terminalStatuses),
            ),
          )
          .for("update", { skipLocked: true })
          .limit(1);
        if (!task) return false;

        const ownership = and(
          eq(externalPublications.id, id),
          eq(externalPublications.taskId, taskId),
          eq(externalPublications.channel, channel),
          eq(externalPublications.issueCommentPendingAttemptId, attemptId),
        );
        const [publication] = await tx
          .select({
            idempotencyKey: externalPublications.idempotencyKey,
            externalObjectId: externalPublications.externalObjectId,
          })
          .from(externalPublications)
          .where(
            and(ownership, isNotNull(externalPublications.externalObjectId)),
          )
          .for("update", { skipLocked: true })
          .limit(1);
        if (!publication || publication.externalObjectId === null) return false;

        // Rotate failed rows behind other candidates without dropping their marker.
        await tx
          .update(externalPublications)
          .set({ updatedAt: new Date() })
          .where(ownership);
        try {
          const payload = parseIssueTaskPayload(task.payload);
          const repository =
            payload && repositoryOwnerName(payload.repositoryFullName);
          const commentId = Number(publication.externalObjectId);
          if (
            !payload ||
            !repository ||
            !/^[1-9]\d*$/.test(payload.installationId) ||
            !/^[a-z0-9][a-z0-9_-]*$/i.test(repository.owner) ||
            !/^[a-z0-9_.-]+$/i.test(repository.name) ||
            repository.name === "." ||
            repository.name === ".." ||
            !Number.isSafeInteger(payload.subjectNumber) ||
            payload.subjectNumber <= 0 ||
            publication.idempotencyKey !==
              issueCommentIdempotencyKey(
                payload.repositoryFullName,
                payload.subjectNumber,
              ) ||
            !Number.isSafeInteger(commentId) ||
            commentId <= 0 ||
            String(commentId) !== publication.externalObjectId
          ) {
            throw new Error("invalid issue comment publication identity");
          }
          const requestSignal = AbortSignal.any([
            signal,
            AbortSignal.timeout(requestTimeoutMs),
          ]);
          const comment = {
            installationId: payload.installationId,
            ...repository,
            commentId,
          };
          requestSignal.throwIfAborted();
          // GitHub may mask authorization problems as a 404; leave those pending.
          const current = await github.getIssueComment(comment, requestSignal);
          if (current.id !== commentId) {
            throw new Error("unexpected GitHub issue comment ID");
          }
          // A result, manual edit, or an earlier successful PATCH whose DB write
          // rolled back must not be replaced by terminal cleanup.
          if (current.body === buildPlaceholderComment(attemptId)) {
            requestSignal.throwIfAborted();
            await github.updateIssueComment(
              {
                ...comment,
                body:
                  task.status === "completed"
                    ? completedWithoutResultComment
                    : task.status === "canceled"
                      ? buildCanceledIssueComment()
                      : buildFailureComment(task.errorCategory ?? "unknown"),
              },
              requestSignal,
            );
          }
          requestSignal.throwIfAborted();
        } catch (error) {
          onError(error, id);
          return false;
        }
        const cleared = await tx
          .update(externalPublications)
          .set({ issueCommentPendingAttemptId: null })
          .where(
            and(
              ownership,
              eq(
                externalPublications.externalObjectId,
                publication.externalObjectId,
              ),
            ),
          )
          .returning({ id: externalPublications.id });
        return cleared.length > 0;
      });
      if (acknowledged) finalized += 1;
    } catch (error) {
      onError(error, id);
    }
  }
  return finalized;
}
