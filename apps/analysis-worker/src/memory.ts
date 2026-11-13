/**
 * 仓库记忆：读取已保存的知识并限制提示词长度。
 * 调用示例：await repoMemoryText("owner/repository")。
 * 仅拆分内部实现；任务与数据契约保持兼容，依赖在下方显式列出。
 */
import { and, eq } from "drizzle-orm";
import {
  getRepoMemorySummary,
  repositories,
} from "../../../packages/database/src/index.js";
import { repositoryOwnerName } from "../../../packages/issue-analysis/src/index.js";
import { database, logger } from "./runtime.js";

/** Looks up the internal repository id for an owner/name pair, if ingested. */
export async function resolveRepositoryId(
  fullName: string,
): Promise<string | null> {
  const identity = repositoryOwnerName(fullName);
  if (!identity) return null;
  const rows = await database.db
    .select({ id: repositories.id })
    .from(repositories)
    .where(
      and(
        eq(repositories.owner, identity.owner),
        eq(repositories.name, identity.name),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Consolidated repo memory of a repository as reference text, or undefined
 * when the repo is unknown / has no consolidated memory yet. Best-effort: a
 * database failure degrades to "no memory" instead of breaking the analysis.
 */
export async function repoMemoryText(
  fullName: string,
): Promise<string | undefined> {
  try {
    const repositoryId = await resolveRepositoryId(fullName);
    if (!repositoryId) return undefined;
    const text = await getRepoMemorySummary(database.db, repositoryId);
    return text.length > 0 ? text : undefined;
  } catch (error) {
    logger.warn({ err: error, fullName }, "repo memory backfill skipped");
    return undefined;
  }
}
