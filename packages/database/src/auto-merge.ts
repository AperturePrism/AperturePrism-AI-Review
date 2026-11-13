/** 自动合并队列只持久化审查产生的意图；GitHub 的最终检查由调度器执行。 */
import { and, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import type { DatabaseClient } from "./client.js";
import {
  analysisTasks,
  outboxEvents,
  pullRequestAutoMerges,
  repositories,
} from "./schema.js";
import type { PullRequestMergeMethod } from "../../config/src/auto-merge.js";

export {
  AUTO_MERGE_SETTING_KEYS,
  parseAutoMergeSettings,
  type AutoMergeSettings,
  type PullRequestMergeMethod,
} from "../../config/src/auto-merge.js";

export type PullRequestAutoMerge = typeof pullRequestAutoMerges.$inferSelect;
export type QueuePullRequestAutoMergeInput = {
  taskId: string;
  repositoryId: string;
  installationId: string;
  repositoryFullName: string;
  pullNumber: number;
  headSha: string;
  method: PullRequestMergeMethod;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 与设置写入、合并执行共享 repository → task → request 锁序。
 * 同一任务重试只更新原意图；新 head 取消旧等待，已完成合并不被重置。
 */
export async function queuePullRequestAutoMerge(
  db: DatabaseClient["db"],
  input: QueuePullRequestAutoMergeInput,
  now = new Date(),
): Promise<Pick<PullRequestAutoMerge, "id" | "status"> | null> {
  if (
    !uuidPattern.test(input.taskId) ||
    !uuidPattern.test(input.repositoryId) ||
    !/^[1-9]\d*$/.test(input.installationId) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repositoryFullName) ||
    !Number.isSafeInteger(input.pullNumber) ||
    input.pullNumber <= 0 ||
    !/^[0-9a-f]{40}$/i.test(input.headSha) ||
    !["merge", "squash", "rebase"].includes(input.method) ||
    !Number.isFinite(now.getTime())
  )
    throw new Error("invalid auto-merge request identity");
  const fullName = input.repositoryFullName.toLowerCase();
  const headSha = input.headSha.toLowerCase();
  return db.transaction(async (tx) => {
    const [repository] = await tx
      .select()
      .from(repositories)
      .where(eq(repositories.id, input.repositoryId))
      .for("update")
      .limit(1);
    if (
      !repository ||
      `${repository.owner}/${repository.name}`.toLowerCase() !== fullName ||
      repository.installationId !== input.installationId
    )
      throw new Error(
        "auto-merge repository identity does not match installation",
      );
    const [task] = await tx
      .select({ id: analysisTasks.id })
      .from(analysisTasks)
      .where(
        and(
          eq(analysisTasks.id, input.taskId),
          eq(analysisTasks.repositoryId, input.repositoryId),
          eq(analysisTasks.taskType, "pr_review"),
          eq(analysisTasks.subjectNumber, input.pullNumber),
          eq(analysisTasks.subjectRevision, headSha),
          inArray(analysisTasks.status, ["publishing", "completed"]),
        ),
      )
      .for("update")
      .limit(1);
    if (!task)
      throw new Error("auto-merge requires the matching published review task");
    const [existing] = await tx
      .select({
        id: pullRequestAutoMerges.id,
        status: pullRequestAutoMerges.status,
      })
      .from(pullRequestAutoMerges)
      .where(eq(pullRequestAutoMerges.taskId, input.taskId))
      .for("update")
      .limit(1);
    if (existing?.status === "merged") return existing;
    if (existing) {
      // 请求已外发而结果尚未确认时，重试只能恢复远端状态；不能换 head 或重发。
      const [recovery] = await tx
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.id, existing.id),
            eq(outboxEvents.topic, "review.auto_merge_recovery"),
            isNull(outboxEvents.publishedAt),
          ),
        )
        .limit(1);
      if (recovery) return existing;
    }
    const [newer] = await tx
      .select({ id: pullRequestAutoMerges.id })
      .from(pullRequestAutoMerges)
      .innerJoin(
        analysisTasks,
        eq(analysisTasks.id, pullRequestAutoMerges.taskId),
      )
      .where(
        and(
          eq(pullRequestAutoMerges.repositoryId, input.repositoryId),
          eq(pullRequestAutoMerges.pullNumber, input.pullNumber),
          ne(pullRequestAutoMerges.taskId, input.taskId),
          // 比较保留 PostgreSQL 的微秒精度，不把 Date 的毫秒截断当成任务排序。
          gt(
            analysisTasks.createdAt,
            sql`(select created_at from analysis_tasks where id = ${input.taskId}::uuid)`,
          ),
        ),
      )
      .limit(1);
    if (newer) return null;
    await tx
      .update(pullRequestAutoMerges)
      .set({
        status: "canceled",
        reason: "head_changed",
        message: "PR 已有更新的提交，等待重新审查。",
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(pullRequestAutoMerges.repositoryId, input.repositoryId),
          eq(pullRequestAutoMerges.pullNumber, input.pullNumber),
          ne(pullRequestAutoMerges.headSha, headSha),
          inArray(pullRequestAutoMerges.status, [
            "pending",
            "waiting",
            "blocked",
          ]),
        ),
      );
    const values = {
      ...input,
      repositoryFullName: fullName,
      headSha,
      status: "pending" as const,
      reason: "awaiting_checks",
      message: null,
      mergeCommitSha: null,
      attempts: 0,
      nextAttemptAt: now,
      updatedAt: now,
      completedAt: null,
    };
    const [queued] = await tx
      .insert(pullRequestAutoMerges)
      .values(values)
      .onConflictDoUpdate({
        target: pullRequestAutoMerges.taskId,
        set: values,
        setWhere: sql`${pullRequestAutoMerges.status} <> 'merged' and not exists (select 1 from outbox_events where outbox_events.id = pull_request_auto_merges.id and outbox_events.topic = 'review.auto_merge_recovery' and outbox_events.published_at is null)`,
      })
      .returning({
        id: pullRequestAutoMerges.id,
        status: pullRequestAutoMerges.status,
      });
    return queued ?? null;
  });
}
