/**
 * 审查完成后登记合并意图；这里不调用 GitHub，调度器会重新核对检查和当前提交。
 * @example await queueReviewedAutoMerge(db, { taskId, repositoryId, installationId, repositoryFullName, pullNumber, headSha, result });
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  getRepositorySettingsFor,
  parseAutoMergeSettings,
  pullRequestAutoMerges,
  queuePullRequestAutoMerge,
  type DatabaseClient,
} from "../../../packages/database/src/index.js";
import { reviewAllowsAutoMerge } from "../../../packages/pr-review/src/auto-merge.js";

export async function queueReviewedAutoMerge(
  db: DatabaseClient["db"],
  input: {
    taskId: string;
    repositoryId: string;
    installationId: string;
    repositoryFullName: string;
    pullNumber: number;
    headSha: string;
    result: unknown;
  },
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const settings = parseAutoMergeSettings(
    await getRepositorySettingsFor(db, input.repositoryId, [
      "pr_auto_merge_enabled",
      "pr_auto_merge_method",
      "pr_auto_merge_required_checks",
    ]),
  );
  signal?.throwIfAborted();
  if (!settings.enabled || !reviewAllowsAutoMerge(input.result)) {
    // 人工重跑仍使用同一个 taskId；新的失败结论必须撤销旧的通过意图。
    await db
      .update(pullRequestAutoMerges)
      .set({
        status: "canceled",
        reason: settings.enabled
          ? "review_not_approved"
          : "configuration_disabled",
        message: settings.enabled
          ? "本次审查未满足自动合并条件"
          : "仓库未开启自动合并",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(pullRequestAutoMerges.taskId, input.taskId),
          eq(pullRequestAutoMerges.repositoryId, input.repositoryId),
          inArray(pullRequestAutoMerges.status, [
            "pending",
            "waiting",
            "blocked",
          ]),
        ),
      );
    return;
  }
  await queuePullRequestAutoMerge(db, { ...input, method: settings.method });
}
