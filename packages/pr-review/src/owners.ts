/**
 * 代码负责人：读取 CODEOWNERS 文本，按“最后匹配的规则生效”找审查对象。
 * 调用：const owners = parseCodeOwners("/src/** @team/core\n"); ownersForPath(owners, "src/a.ts");
 * 只返回建议负责人，不会自动发送消息或发出 GitHub 审查请求。
 */
import { matchPath, normalizeReviewPath } from "./utils/path.js";

export type CodeOwnerRule = {
  pattern: string;
  owners: readonly string[];
  line: number;
};
export type CodeOwners = {
  rules: readonly CodeOwnerRule[];
  warnings: readonly { line: number; message: string }[];
};
export type OwnerAssignment = {
  owner: string;
  paths: readonly string[];
  changedLines: number;
  sensitivePaths: readonly string[];
};

/** 解析常用 CODEOWNERS 规则；明确拒绝 gitignore 专属否定和字符集合语法。 */
export function parseCodeOwners(text: string): CodeOwners {
  if (text.length > 3_000_000) throw new Error("CODEOWNERS 内容超过 3 MB");
  const rules: CodeOwnerRule[] = [];
  const warnings: { line: number; message: string }[] = [];
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/u);
    const pattern = parts[0]!;
    if (
      pattern.startsWith("!") ||
      pattern.includes("[") ||
      pattern.includes("\\")
    ) {
      warnings.push({
        line: index + 1,
        message: "此 CODEOWNERS 规则包含当前不支持的匹配语法，未作负责人推断",
      });
      continue;
    }
    const comment = parts.findIndex((part) => part.startsWith("#"));
    const owners = parts.slice(1, comment >= 0 ? comment : undefined);
    if (
      owners.some(
        (owner) =>
          !/^(@[a-z\d-]+(?:\/[a-z\d_.-]+)?|[^\s@]+@[^\s@]+\.[^\s@]+)$/iu.test(
            owner,
          ),
      )
    ) {
      warnings.push({
        line: index + 1,
        message: "负责人必须是 GitHub 用户、团队或邮箱；已忽略此行",
      });
      continue;
    }
    rules.push({ pattern, owners, line: index + 1 }); // 空负责人是一条有效的清除规则。
  }
  return { rules, warnings };
}

/** CODEOWNERS 无斜线模式可匹配任意层；根锚点和目录规则仍保留边界。 */
export function codeOwnerPatternMatches(
  pattern: string,
  rawPath: string,
): boolean {
  const path = normalizeReviewPath(rawPath);
  const rooted = pattern.startsWith("/");
  let normalized = rooted ? pattern.slice(1) : pattern;
  if (normalized.endsWith("/")) normalized += "**";
  if (normalized === "*") return true;
  if (!rooted && !normalized.includes("/")) {
    return path.split("/").some((part) => matchPath(normalized, part));
  }
  return matchPath(normalized, path) || matchPath(`${normalized}/**`, path);
}

/** 从后向前找第一条匹配规则，遵守 GitHub 的最后匹配优先语义。 */
export function ownersForPath(
  config: CodeOwners,
  path: string,
): readonly string[] {
  for (let index = config.rules.length - 1; index >= 0; index -= 1) {
    const rule = config.rules[index]!;
    if (codeOwnerPatternMatches(rule.pattern, path)) return rule.owners;
  }
  return [];
}

/** 把同一负责人的多个变更文件合并成一项，保留其风险范围供界面解释。 */
export function assignReviewOwners(
  config: CodeOwners,
  files: readonly {
    path: string;
    additions: number;
    deletions: number;
    securitySensitive: boolean;
  }[],
): readonly OwnerAssignment[] {
  const assignments = new Map<
    string,
    {
      owner: string;
      paths: string[];
      changedLines: number;
      sensitivePaths: string[];
    }
  >();
  for (const file of files) {
    for (const owner of ownersForPath(config, file.path)) {
      const entry = assignments.get(owner) ?? {
        owner,
        paths: [],
        changedLines: 0,
        sensitivePaths: [],
      };
      if (!entry.paths.includes(file.path)) {
        entry.paths.push(file.path);
        entry.changedLines += file.additions + file.deletions;
        if (file.securitySensitive) entry.sensitivePaths.push(file.path);
      }
      assignments.set(owner, entry);
    }
  }
  return [...assignments.values()].sort(
    (left, right) =>
      right.sensitivePaths.length - left.sensitivePaths.length ||
      right.changedLines - left.changedLines ||
      left.owner.localeCompare(right.owner),
  );
}
