import { and, eq, isNull, sql } from "drizzle-orm";
import {
  analysisTasks,
  externalPublications,
  taskAttempts,
  type DatabaseClient,
} from "../../../packages/database/src/index.js";
import type { LeasedTask } from "../../../packages/domain/src/index.js";
import type { GitHubClient } from "../../../packages/github-adapter/src/index.js";
import {
  buildPlaceholderComment,
  issueCommentIdempotencyKey,
  repositoryOwnerName,
  type IssueTaskPayload,
} from "../../../packages/issue-analysis/src/index.js";

type Input = {
  db: DatabaseClient["db"];
  github: Pick<GitHubClient, "createIssueComment" | "updateIssueComment">;
  task: LeasedTask;
  payload: IssueTaskPayload;
  identity: NonNullable<ReturnType<typeof repositoryOwnerName>>;
  signal: AbortSignal;
} & ({ kind: "placeholder" } | { kind: "final"; body: string });

const channel = "github_issue_comment";

export async function publishTrackedIssueComment(
  input: Input,
): Promise<boolean> {
  const { db, github, task, payload, identity, signal } = input;
  signal.throwIfAborted();
  const key = issueCommentIdempotencyKey(
    payload.repositoryFullName,
    payload.subjectNumber,
  );
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    const [current] = await tx
      .select({ id: analysisTasks.id })
      .from(analysisTasks)
      .where(
        and(
          eq(analysisTasks.id, task.id),
          eq(analysisTasks.taskType, "issue_analysis"),
          eq(
            analysisTasks.status,
            input.kind === "placeholder" ? "running" : "publishing",
          ),
          eq(analysisTasks.leaseOwner, task.leaseOwner),
          eq(analysisTasks.attemptCount, task.attemptNumber),
          sql`${analysisTasks.leaseExpiresAt} > clock_timestamp()`,
        ),
      )
      .for("update")
      .limit(1);
    const [attempt] = current
      ? await tx
          .select({ id: taskAttempts.id })
          .from(taskAttempts)
          .where(
            and(
              eq(taskAttempts.taskId, task.id),
              eq(taskAttempts.attemptNumber, task.attemptNumber),
              eq(taskAttempts.workerId, task.leaseOwner),
              isNull(taskAttempts.finishedAt),
              ...(task.attemptId ? [eq(taskAttempts.id, task.attemptId)] : []),
            ),
          )
          .limit(1)
      : [];
    if (!attempt) {
      throw new DOMException(
        "Issue comment publication lease was lost",
        "AbortError",
      );
    }

    // The task lock precedes the publication lock in both worker and scheduler.
    // The advisory lock also serializes first publication when no row exists yet.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
    const [publication] = await tx
      .select({
        id: externalPublications.id,
        taskId: externalPublications.taskId,
        commentId: externalPublications.externalObjectId,
        channel: externalPublications.channel,
        pendingAttemptId: externalPublications.issueCommentPendingAttemptId,
      })
      .from(externalPublications)
      .where(eq(externalPublications.idempotencyKey, key))
      .for("update")
      .limit(1);
    if (publication && publication.channel !== channel) {
      throw new Error("Issue comment publication channel does not match");
    }
    if (input.kind === "final") {
      if (
        publication?.taskId !== task.id ||
        publication.pendingAttemptId !== attempt.id
      ) {
        return false;
      }
    } else if (publication && publication.taskId !== task.id) {
      const [newer] = await tx
        .select({ id: analysisTasks.id })
        .from(analysisTasks)
        .where(
          and(
            eq(analysisTasks.id, publication.taskId),
            sql`(${analysisTasks.createdAt}, ${analysisTasks.id}) > (
              select created_at, id from analysis_tasks where id = ${task.id}
            )`,
          ),
        )
        .limit(1);
      if (newer) return false;
    }

    signal.throwIfAborted();
    const checkedAt = performance.now();
    const [held] = await tx
      .select({
        remainingMs:
          sql<number>`extract(epoch from (${analysisTasks.leaseExpiresAt} - clock_timestamp())) * 1000`.mapWith(
            Number,
          ),
      })
      .from(analysisTasks)
      .where(eq(analysisTasks.id, task.id));
    const remainingMs = Math.floor(
      (held?.remainingMs ?? 0) - (performance.now() - checkedAt),
    );
    if (remainingMs <= 0) {
      throw new DOMException(
        "Issue comment publication lease expired",
        "AbortError",
      );
    }
    const requestSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.min(15_000, remainingMs)),
    ]);
    requestSignal.throwIfAborted();
    const body =
      input.kind === "placeholder"
        ? buildPlaceholderComment(attempt.id)
        : input.body;
    const target = {
      ...identity,
      installationId: payload.installationId,
      body,
    };
    let commentId = publication?.commentId;
    if (commentId) {
      const id = Number(commentId);
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new Error("Invalid Issue comment publication ID");
      }
      await github.updateIssueComment(
        { ...target, commentId: id },
        requestSignal,
      );
    } else {
      if (input.kind !== "placeholder") return false;
      const created = await github.createIssueComment(
        { ...target, number: payload.subjectNumber },
        requestSignal,
      );
      commentId = String(created.id);
    }
    // After GitHub accepted the write, retain the ID even if shutdown raced it.
    const values = {
      taskId: task.id,
      externalObjectId: commentId,
      issueCommentPendingAttemptId:
        input.kind === "placeholder" ? attempt.id : null,
      updatedAt: new Date(),
    };
    if (publication) {
      await tx
        .update(externalPublications)
        .set(values)
        .where(eq(externalPublications.id, publication.id));
    } else {
      await tx
        .insert(externalPublications)
        .values({ ...values, channel, idempotencyKey: key });
    }
    return true;
  });
}
