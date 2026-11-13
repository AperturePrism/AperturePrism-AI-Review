/**
 * 变更契约：从 diff 中识别导出、路由、数据库和配置契约的变化候选。
 * 调用：const changes = analyzeChangeContracts(parsedDiff)。
 * 候选需要人核对，不推断完整 AST 语义，不把删除代码自动判定为破坏性变更。
 */
import type { ParsedDiff } from "./diff.js";

export type ContractKind = "export" | "http_route" | "database" | "environment";
export type ContractObservation = {
  path: string;
  line: number;
  kind: ContractKind;
  name: string;
  action: "added" | "removed" | "changed";
  before: string | null;
  after: string | null;
  review: string;
  risk: "informational" | "check_compatibility" | "destructive";
};
export type ChangeContracts = {
  observations: readonly ContractObservation[];
  compatibilityChecks: readonly string[];
  destructiveChanges: number;
  limitations: readonly string[];
};

type ContractToken = {
  kind: ContractKind;
  name: string;
  text: string;
  line: number;
  destructive: boolean;
};

/** 只识别明确语法片段；匹配到的原文随结果输出，接手者可以回到 diff 复核。 */
function contractTokens(text: string, line: number): ContractToken[] {
  const found: ContractToken[] = [];
  const exported =
    /\bexport\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/u.exec(
      text,
    );
  if (exported)
    found.push({
      kind: "export",
      name: exported[1]!,
      text: text.trim(),
      line,
      destructive: false,
    });
  const reexport = /\bexport\s*\{([^}]+)\}/u.exec(text);
  if (reexport) {
    for (const member of reexport[1]!.split(",")) {
      const name = member
        .trim()
        .split(/\s+as\s+/u)
        .at(-1)
        ?.replace(/^type\s+/u, "");
      if (name && /^[A-Za-z_$][\w$]*$/u.test(name))
        found.push({
          kind: "export",
          name,
          text: text.trim(),
          line,
          destructive: false,
        });
    }
  }
  const route =
    /\b(?:app|router|server)\.(get|post|put|patch|delete|head|options)\s*\(\s*['"]([^'"]+)['"]/iu.exec(
      text,
    );
  if (route)
    found.push({
      kind: "http_route",
      name: `${route[1]!.toUpperCase()} ${route[2]}`,
      text: text.trim(),
      line,
      destructive: false,
    });
  const manualRoute = /(?:pathname|path)\s*===\s*['"]([^'"]+)['"]/u.exec(text);
  if (manualRoute)
    found.push({
      kind: "http_route",
      name: manualRoute[1]!,
      text: text.trim(),
      line,
      destructive: false,
    });
  const environment =
    /\bprocess\.env(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])/u.exec(
      text,
    );
  if (environment)
    found.push({
      kind: "environment",
      name: environment[1] ?? environment[2]!,
      text: text.trim(),
      line,
      destructive: false,
    });
  const sql =
    /\b(DROP\s+(?:TABLE|COLUMN|DATABASE)|TRUNCATE\s+(?:TABLE\s+)?|ALTER\s+TABLE|CREATE\s+TABLE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:["`]|\[)?([A-Za-z_][\w.]*)/iu.exec(
      text,
    );
  if (sql)
    found.push({
      kind: "database",
      name: sql[2]!,
      text: text.trim(),
      line,
      destructive: /^(?:DROP|TRUNCATE)/iu.test(sql[1]!),
    });
  return found;
}

/** 相同主体按名称配对，变更候选保留前后语句；未配对的删除要求兼容性检查。 */
export function analyzeChangeContracts(diff: ParsedDiff): ChangeContracts {
  const observations: ContractObservation[] = [];
  for (const file of diff.files) {
    const before: ContractToken[] = [];
    const after: ContractToken[] = [];
    for (const hunk of file.hunks ?? []) {
      for (const line of hunk.lines) {
        if (line.kind === "delete")
          before.push(...contractTokens(line.text, 0));
        if (line.kind === "add")
          after.push(...contractTokens(line.text, line.afterLine));
      }
    }
    const oldByName = new Map<string, ContractToken[]>();
    for (const token of before) {
      const key = `${token.kind}:${token.name}`;
      const list = oldByName.get(key) ?? [];
      list.push(token);
      oldByName.set(key, list);
    }
    for (const token of after) {
      const previous = oldByName.get(`${token.kind}:${token.name}`)?.shift();
      if (previous?.text === token.text) continue;
      const risk = token.destructive
        ? "destructive"
        : previous
          ? "check_compatibility"
          : "informational";
      observations.push({
        path: file.newPath,
        line: token.line,
        kind: token.kind,
        name: token.name,
        action: previous ? "changed" : "added",
        before: previous?.text ?? null,
        after: token.text,
        risk,
        review: token.destructive
          ? "检查数据备份、回滚方案和生产执行条件"
          : token.kind === "export"
            ? "检查调用方、参数和返回值兼容性"
            : token.kind === "http_route"
              ? "检查鉴权、请求参数和响应契约"
              : token.kind === "database"
                ? "检查升级顺序与旧版本读写兼容性"
                : "检查部署配置、默认值和凭据注入方式",
      });
    }
    for (const token of [...oldByName.values()].flat())
      observations.push({
        path:
          file.newPath === "/dev/null"
            ? (file.oldPath ?? file.newPath)
            : file.newPath,
        line: 0,
        kind: token.kind,
        name: token.name,
        action: "removed",
        before: token.text,
        after: null,
        risk: "check_compatibility",
        review:
          "确认所有调用方、旧配置或已有数据已经处理；删除语句本身不证明兼容性破坏",
      });
  }
  const checks = observations
    .filter((item) => item.risk !== "informational")
    .map((item) => `${item.path}：${item.name} — ${item.review}`);
  return {
    observations,
    compatibilityChecks: [...new Set(checks)],
    destructiveChanges: observations.filter(
      (item) => item.risk === "destructive",
    ).length,
    limitations: [
      "仅识别 diff 中常见的单行语法片段；多行声明、别名和生成接口可能遗漏",
      "契约变化是待核对的审查线索，不等于已经验证的回归或漏洞",
    ],
  };
}
