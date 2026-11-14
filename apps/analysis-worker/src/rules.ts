/**
 * 仓库规则：读取本仓和外部公开规则，统一约束来源。
 * 调用示例：await repoRulesEnabled("owner/repository")。
 * 仅拆分内部实现；任务与数据契约保持兼容，依赖在下方显式列出。
 */
import {
  BOOLEAN_DEFAULTS,
  parseBool,
} from "../../../packages/config/src/index.js";
import { loadSettings } from "../../../packages/database/src/index.js";
import { fetchExternalRepoRulesText } from "./external-repo-rules.js";
import { resolveIssueSettings } from "./preferences.js";
import { createReviewRulesLoader } from "./review-rules.js";
import { database, logger } from "./runtime.js";

/**
 * 仓库审核规则是否启用（`repo_rules_enabled`）。仓库级覆盖优先，其次全局，
 * 缺省开启（遵循 BOOLEAN_DEFAULTS.repo_rules_enabled）。读取失败按开启处理。
 */
async function repoRulesEnabled(
  repositoryFullName: string | null,
): Promise<boolean> {
  try {
    const settings = await resolveIssueSettings(repositoryFullName, [
      "repo_rules_enabled",
    ]);
    return parseBool(
      settings.get("repo_rules_enabled"),
      BOOLEAN_DEFAULTS.repo_rules_enabled ?? true,
    );
  } catch {
    return true;
  }
}

/** Shared by Issue / PR analysis. Global rules bypass repository overrides and
 * remain active when directory/URL rules are disabled or unavailable. */
export const loadRepoRules = createReviewRulesLoader({
  loadGlobalRules: async () =>
    (await loadSettings(database.db, ["review_rules_global"])).get(
      "review_rules_global",
    ),
  repoRulesEnabled,
  fetchExternalRules: fetchExternalRepoRules,
  logger,
});

/**
 * issue #107：抓取 `repo_rules_url` 指向的外部审核规则文本。
 * 未配置 / 非公网 http(s) 链接 / 抓取失败时返回 undefined，不阻断分析（fail-open）。
 * 流式读取上限 256KB，超长截断；含 DNS 与重定向的总超时 15 秒；仅接受文本响应。
 */
async function fetchExternalRepoRules(
  repoFullName: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  let url = "";
  try {
    const settings = await resolveIssueSettings(repoFullName, [
      "repo_rules_url",
    ]);
    url = String(settings.get("repo_rules_url") ?? "").trim();
  } catch (error) {
    logger.warn(
      { err: error, repo: repoFullName },
      "external repo rules: settings read failed; skipping",
    );
    return undefined;
  }
  if (!/^https?:\/\/\S+$/i.test(url)) return undefined;
  try {
    const text = await fetchExternalRepoRulesText(url, signal);
    if (text === undefined) return undefined;
    logger.info(
      { repo: repoFullName, chars: text.length },
      "external repo rules: fetched",
    );
    return text;
  } catch (error) {
    logger.warn(
      { err: error, repo: repoFullName },
      "external repo rules: fetch failed; skipping",
    );
    return undefined;
  }
}
