/** 自动合并只读取仓库显式配置；非法配置关闭执行，不能悄悄减少必需检查。 */
export type PullRequestMergeMethod = "merge" | "squash" | "rebase";

export type AutoMergeSettings = {
  enabled: boolean;
  method: PullRequestMergeMethod;
  requiredChecks: readonly string[];
};

export const AUTO_MERGE_SETTING_KEYS = [
  "pr_auto_merge_enabled",
  "pr_auto_merge_method",
  "pr_auto_merge_required_checks",
] as const;

export const MAX_AUTO_MERGE_CHECKS = 100;
export const MAX_AUTO_MERGE_CHECK_NAME = 200;
export const MAX_AUTO_MERGE_CHECKS_TEXT = 50_000;

/** JSON 数组保留名称中的逗号；手写列表也可用逗号或换行分隔。 */
export function parseRequiredAutoMergeChecks(
  raw: string | undefined,
): string[] {
  if (raw === undefined) return [];
  if (raw.length > MAX_AUTO_MERGE_CHECKS_TEXT)
    throw new Error("必需检查配置超过长度上限");
  if (raw.trim().length === 0) return [];
  let names: string[];
  if (raw.trimStart().startsWith("[")) {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.some((name) => typeof name !== "string"))
      throw new Error("必需检查配置必须是名称数组");
    names = value.map((name: string) => name.trim());
  } else
    names = raw
      .split(/[,\r\n]/)
      .map((name) => name.trim())
      .filter(Boolean);
  if (names.length > MAX_AUTO_MERGE_CHECKS)
    throw new Error(`必需检查最多 ${MAX_AUTO_MERGE_CHECKS} 项`);
  for (const name of names) {
    if (
      !name ||
      name.length > MAX_AUTO_MERGE_CHECK_NAME ||
      [...name].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new Error(
        `检查名称需不超过 ${MAX_AUTO_MERGE_CHECK_NAME} 字且不能包含控制字符`,
      );
  }
  return [...new Set(names)];
}

/** 未启用、拼错合并方式、损坏的检查列表都不能产生自动写入。 */
export function parseAutoMergeSettings(
  overrides: ReadonlyMap<string, string>,
): AutoMergeSettings {
  const rawMethod = overrides.get("pr_auto_merge_method") ?? "squash";
  const validMethod = ["merge", "squash", "rebase"].includes(rawMethod);
  const method = validMethod ? (rawMethod as PullRequestMergeMethod) : "squash";
  try {
    const requiredChecks = parseRequiredAutoMergeChecks(
      overrides.get("pr_auto_merge_required_checks"),
    );
    return {
      enabled: validMethod && overrides.get("pr_auto_merge_enabled") === "true",
      method,
      requiredChecks,
    };
  } catch {
    return { enabled: false, method, requiredChecks: [] };
  }
}
