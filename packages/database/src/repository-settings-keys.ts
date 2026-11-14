/**
 * 仓库级设置的纯逻辑：可覆盖键白名单与「仓库优先、全局兜底」的取值规则。
 *
 * 单独一个文件，不 import drizzle：这样白名单与取值优先级可以在任何环境下被
 * 单测覆盖，不必先能连上数据库。数据库读写在 `repository-settings.ts`。
 */

/**
 * 允许按仓库覆盖的设置键。
 *
 * 只收「与单个仓库相关」的行为开关。日志级别、WebUI 令牌、OAuth 凭据、
 * Embedding 端点这些是进程级或账户级的，按仓库覆盖不会生效，还会给出
 * 「我改了却不生效」的错觉 —— 所以它们不在这里。
 */
export const REPOSITORY_SETTING_KEYS = [
  "issue_rewrite_title",
  "issue_auto_assign",
  "issue_assignee",
  "issue_deep_analysis",
  "issue_use_unified_sections",
  "issue_vision_enabled",
  "issue_reanalyze_min_change",
  "spam_handling",
  "repo_rules_enabled",
  "repo_rules_url",
  "pr_auto_merge_enabled",
  "pr_auto_merge_method",
  "pr_auto_merge_required_checks",
] as const;

export type RepositorySettingKey = (typeof REPOSITORY_SETTING_KEYS)[number];

const allowed = new Set<string>(REPOSITORY_SETTING_KEYS);

export function isRepositorySettingKey(
  key: string,
): key is RepositorySettingKey {
  return allowed.has(key);
}

/**
 * 仓库级优先、全局兜底的取值。返回 undefined 表示两处都没有配置，由调用方决定
 * 应用默认值 —— 这一层不猜默认值，因为不同开关的默认值不同（标题改写默认开，
 * 深度分析默认关）。
 *
 * 空串是一个真实的覆盖值（「清空指派对象」），不等于「跟随全局」；后者靠
 * 「这个键不存在」表达，所以清除覆盖是删除行，而不是写入空串。
 */
export function resolveSetting(
  repoOverrides: Map<string, string>,
  globals: Map<string, string>,
  key: string,
): string | undefined {
  return repoOverrides.get(key) ?? globals.get(key);
}
