/**
 * GitHub：明确要求已配置的客户端。
 * 调用示例：assertGithub(client)。
 * 仅拆分内部实现；任务与数据契约保持兼容，依赖在下方显式列出。
 */
import { createGitHubClient } from "../../../packages/github-adapter/src/index.js";

export function assertGithub(
  github: ReturnType<typeof createGitHubClient> | null,
) {
  if (!github) throw new Error("GitHub App is not configured");
  return github;
}
