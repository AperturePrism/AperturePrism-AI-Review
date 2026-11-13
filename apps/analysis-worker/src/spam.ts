/**
 * 垃圾报告：处理方式、关闭原因与GitHub动作。
 * 调用示例：await spamHandlingMode("owner/repository")。
 * 仅拆分内部实现；任务与数据契约保持兼容，依赖在下方显式列出。
 */
import { parseSpamHandling } from "../../../packages/config/src/index.js";
import { createGitHubClient } from "../../../packages/github-adapter/src/index.js";
import { resolveIssueSettings } from "./preferences.js";
import { logger } from "./runtime.js";

/** Reads the ad/spam handling policy with repository override; defaults to close. */
export async function spamHandlingMode(
  repositoryFullName: string | null = null,
): Promise<"none" | "close" | "delete"> {
  try {
    const settings = await resolveIssueSettings(repositoryFullName, [
      "spam_handling",
    ]);
    return parseSpamHandling(settings.get("spam_handling"));
  } catch (error) {
    logger.warn(
      { err: error, repo: repositoryFullName },
      "spam handling setting read failed; using close",
    );
    return "close";
  }
}

/** Posts an explanatory comment and closes the flagged spam issue. */
export async function closeSpamIssue(
  githubClient: ReturnType<typeof createGitHubClient>,
  payload: { installationId: string; subjectNumber: number },
  identity: { owner: string; name: string },
  reason: string,
): Promise<void> {
  await githubClient.createIssueComment({
    installationId: payload.installationId,
    owner: identity.owner,
    name: identity.name,
    number: payload.subjectNumber,
    body: spamCloseComment(reason),
  });
  await githubClient.closeIssue({
    installationId: payload.installationId,
    owner: identity.owner,
    name: identity.name,
    number: payload.subjectNumber,
  });
}

function spamCloseComment(reason: string): string {
  return `该 Issue 被识别为广告 / 垃圾内容，已自动关闭。\n\n判定理由：${reason}\n\n如果这是误判，请重新打开 Issue 并补充说明，维护者会复核。`;
}
