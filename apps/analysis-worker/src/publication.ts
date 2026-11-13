/**
 * 发布记录：评论幂等键与持久审查结果。
 * 调用示例：await publicationStore.findExternalObjectId("pr-comment:owner/repo#1:revision")。
 * 仅拆分内部实现；任务与数据契约保持兼容，依赖在下方显式列出。
 */
import { eq } from "drizzle-orm";
import {
  externalPublications,
  subjectResults,
} from "../../../packages/database/src/index.js";
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
}): Promise<void> {
  await database.db
    .insert(subjectResults)
    .values({
      taskId: input.taskId,
      subjectType: input.subjectType,
      subjectNumber: input.subjectNumber,
      repositoryFullName: input.repositoryFullName,
      revision: input.revision,
      result: input.result,
      published: true,
    })
    .onConflictDoNothing({ target: subjectResults.taskId });
}
