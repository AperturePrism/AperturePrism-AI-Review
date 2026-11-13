/** Markdown 报告使用文本转义；发现正文不会变成可执行 HTML 或伪造链接。 */
import type { ReportData } from "../types.js";

export const mimeType = "text/markdown; charset=utf-8";
export const extension = "md";

function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\\`*_[\]{}()#|]/g, "\\$&")
    .replaceAll("\r", "")
    .replaceAll("\n", " ");
}

/** @example render(reportData) // 包含门禁结论、检查明细和发现定位。 */
export function render(data: ReportData): string {
  const lines = [
    `# ${escape(data.repository)} 审查报告`,
    "",
    `生成时间：${data.generatedAt}`,
    "",
    `门禁：**${data.summary.gate.decision.toUpperCase()}**；开放发现 ${data.summary.openFindings}；忽略 ${data.summary.suppressedFindings}。`,
    "",
    "## 门禁检查",
    "",
    "| 检查 | 结论 | 说明 |",
    "| --- | --- | --- |",
    ...data.summary.gate.checks.map(
      (check) =>
        `| ${escape(check.name)} | ${check.decision} | ${escape(check.message)} |`,
    ),
    "",
    "## 发现",
    "",
    "| 严重度 | 状态 | 路径 | 行 | 发现 | 负责人 |",
    "| --- | --- | --- | --- | --- | --- |",
    ...data.findings.map(
      (finding) =>
        `| ${finding.severity} | ${finding.status} | ${escape(finding.path)} | ${finding.line} | ${escape(finding.title)} | ${escape(finding.assignee)} |`,
    ),
  ];
  if (!data.findings.length) lines.push("| — | — | — | — | 暂无发现记录 | — |");
  if (data.evaluations.length) {
    lines.push(
      "",
      "## 离线评估",
      "",
      "| 评估 | 模型 | 精确率 | 召回率 | F1 |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const evaluation of data.evaluations)
      lines.push(
        `| ${escape(evaluation.name)} | ${escape(evaluation.model)} | ${evaluation.result.precision.toFixed(4)} | ${evaluation.result.recall.toFixed(4)} | ${evaluation.result.f1.toFixed(4)} |`,
      );
  }
  lines.push(
    "",
    "## 预算",
    "",
    "| 名称 | 周期 | 限额（美元） | 已用（美元） |",
    "| --- | --- | --- | --- |",
  );
  for (const budget of data.budgets)
    lines.push(
      `| ${escape(budget.name)} | ${budget.periodStart} — ${budget.periodEnd} | ${(budget.limits.amountMicros / 1_000_000).toFixed(6)} | ${(budget.usage.amountMicros / 1_000_000).toFixed(6)} |`,
    );
  return lines.join("\n") + "\n";
}
