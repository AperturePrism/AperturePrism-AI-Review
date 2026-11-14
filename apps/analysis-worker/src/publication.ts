/**
 * 发布记录：评论幂等键与持久审查结果。
 * 调用示例：await publicationStore.findExternalObjectId("pr-comment:owner/repo#1:revision")。
 * 仅拆分内部实现；任务与数据契约保持兼容，依赖在下方显式列出。
 */
import { and, eq, exists, isNull, sql } from "drizzle-orm";
import {
  analysisTasks,
  externalPublications,
  subjectResults,
  taskAttempts,
} from "../../../packages/database/src/index.js";
import type { LeasedTask } from "../../../packages/domain/src/index.js";
import { type PublicationStore } from "../../../packages/issue-analysis/src/index.js";
import { database } from "./runtime.js";

export const publicationStore: PublicationStore = {
  findExternalObjectId: async (idempotencyKey) => {
    const rows = await database.db
      .select({ externalObjectId: externalPublications.externalObjectId })
      .from(externalPublications)
      .where(eq(externalPublications.idempotencyKey, idempotencyKey))
      .limit(1);
    return rows[0]?.externalObjectId ?? null;
  },
  insert: async (input) => {
    await database.db
      .insert(externalPublications)
      .values({
        taskId: input.taskId,
        idempotencyKey: input.idempotencyKey,
        externalObjectId: input.externalObjectId,
        channel: input.channel,
      })
      .onConflictDoNothing({ target: externalPublications.idempotencyKey });
  },
  touch: async (idempotencyKey) => {
    await database.db
      .update(externalPublications)
      .set({ updatedAt: new Date() })
      .where(eq(externalPublications.idempotencyKey, idempotencyKey));
  },
};

/** Persists a structured issue/PR result once per task (idempotent on taskId). */
export async function persistSubjectResult(input: {
  taskId: string;
  subjectType: "issue" | "pr";
  subjectNumber: number;
  repositoryFullName: string;
  revision: string;
  result: unknown;
  execution?: LeasedTask;
}): Promise<void> {
  await database.db.transaction(async (tx) => {
    if (input.execution) {
      const execution = input.execution;
      // 重跑可以替换旧结果，但失去发布租约的旧进程不能盖回旧的通过结论。
      const [current] = await tx
        .select({ id: analysisTasks.id })
        .from(analysisTasks)
        .where(
          and(
            eq(analysisTasks.id, input.taskId),
            eq(analysisTasks.status, "publishing"),
            eq(analysisTasks.leaseOwner, execution.leaseOwner),
            eq(analysisTasks.attemptCount, execution.attemptNumber),
            sql`${analysisTasks.leaseExpiresAt} > now()`,
            exists(
              tx
                .select({ id: taskAttempts.id })
                .from(taskAttempts)
                .where(
                  and(
                    eq(taskAttempts.taskId, input.taskId),
                    eq(taskAttempts.workerId, execution.leaseOwner),
                    eq(taskAttempts.attemptNumber, execution.attemptNumber),
                    isNull(taskAttempts.finishedAt),
                    ...(execution.attemptId
                      ? [eq(taskAttempts.id, execution.attemptId)]
                      : []),
                  ),
                ),
            ),
          ),
        )
        .for("update")
        .limit(1);
      if (!current)
        throw new DOMException(
          "Review publication lease is no longer current",
          "AbortError",
        );
    }
    const values = {
      taskId: input.taskId,
      subjectType: input.subjectType,
      subjectNumber: input.subjectNumber,
      repositoryFullName: input.repositoryFullName,
      revision: input.revision,
      result: input.result,
      published: true,
    };
    const insert = tx.insert(subjectResults).values(values);
    if (input.execution)
      await insert.onConflictDoUpdate({
        target: subjectResults.taskId,
        set: { ...values, updatedAt: new Date() },
      });
    else await insert.onConflictDoNothing({ target: subjectResults.taskId });
  });
}
