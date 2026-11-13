/** Markdown 报告：给人直接阅读；调用 renderReviewReport("markdown", input)。 */
import type { ReviewReportFormat } from "../report.js";
import { reportFindingFingerprint } from "../report.js";

/** 外部文案作为文字显示，禁用 HTML、表格和链接语法的逃逸。 */
function text(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\\`*_[\]{}()#+.!|]/gu, "\\$&")
    .replaceAll("\r", "");
}

/** 用足够长的代码围栏展示原文，证据中的 ``` 不会提前结束代码块。 */
function code(value: string): string {
  const lengths = [...value.matchAll(/`+/gu)].map((match) => match[0].length);
  const fence = "`".repeat(Math.max(3, ...lengths.map((length) => length + 1)));
  return `${fence}\n${value}\n${fence}`;
}

const format: ReviewReportFormat = {
  extension: ".md",
  mediaType: "text/markdown; charset=utf-8",
  description: "面向人工审阅的完整报告，明确覆盖限制和抑制记录",
  render(input) {
    const assessment = input.assessment;
    const lines: string[] = [
      "# PR 审查报告",
      "",
      `仓库：${text(input.repository)}  `,
      `提交：${text(input.revision)}  `,
      `生成：${text(assessment.createdAt)}`,
      "",
      "## 审查结论",
      "",
      text(assessment.review.summary),
      "",
      "| 项目 | 结果 |",
      "| --- | --- |",
      `| 质量门禁 | ${assessment.gate.status} |`,
      `| 变更风险 | ${assessment.risk.band} / ${assessment.risk.score} 分 |`,
      `| 模型输入覆盖 | ${(assessment.coverage.changedLineRatio * 100).toFixed(1)}% 变更行 |`,
      `| 当前问题 | ${assessment.findings.length} |`,
      `| 有效抑制 | ${assessment.suppressions.suppressed.length} |`,
      `| 基线新增 / 延续 / 变化 / 已解决 | ${assessment.baseline.counts.new} / ${assessment.baseline.counts.existing} / ${assessment.baseline.counts.changed} / ${assessment.baseline.counts.resolved} |`,
      "",
      "风险分数是审查优先级提示，不代表已经发现漏洞。覆盖比例表示模型收到的输入范围，不证明模型逐行理解。",
      "",
    ];
    if (assessment.gate.reasons.length) {
      lines.push("## 门禁原因", "");
      for (const reason of assessment.gate.reasons)
        lines.push(
          `- ${text(reason.message)}（当前 ${reason.actual}，上限/要求 ${reason.limit}）`,
        );
      lines.push("");
    }
    lines.push("## 需要处理的问题", "");
    if (!assessment.findings.length)
      lines.push("本次评估范围内没有需要发布的问题。", "");
    for (const finding of assessment.findings) {
      const fingerprint = reportFindingFingerprint(finding);
      const state =
        assessment.baseline.current.find(
          (entry) => entry.fingerprint === fingerprint,
        )?.state ?? "new";
      lines.push(
        `### ${text(finding.rule)} · ${finding.severity.toUpperCase()} · ${state}`,
        "",
      );
      lines.push(
        `位置：${text(finding.file)}${finding.afterLine > 0 ? `:${finding.afterLine}` : "（行号未知）"}  `,
      );
      lines.push(`置信度：${finding.confidence}  `, `指纹：${fingerprint}`, "");
      lines.push(
        text(finding.message),
        "",
        `影响：${text(finding.impact)}`,
        "",
        `建议：${text(finding.suggestion)}`,
        "",
      );
      if (input.includeEvidence !== false)
        lines.push("证据：", "", code(finding.evidence), "");
    }
    if (
      input.includeSuppressed !== false &&
      assessment.suppressions.suppressed.length
    ) {
      lines.push(
        "## 已接受的问题",
        "",
        "| 规则 | 文件 | 接受理由 | 负责人 | 到期 |",
        "| --- | --- | --- | --- | --- |",
      );
      for (const entry of assessment.suppressions.suppressed) {
        lines.push(
          `| ${text(entry.finding.rule)} | ${text(entry.finding.file)} | ${text(entry.suppression.reason)} | ${text(entry.suppression.owner)} | ${text(entry.suppression.expiresAt)} |`,
        );
      }
      lines.push("");
    }
    lines.push(
      "## 覆盖范围",
      "",
      "| 文件 | 状态 | 已见变更行 / 总变更行 | 预读源码 |",
      "| --- | --- | --- | --- |",
    );
    for (const file of assessment.coverage.files)
      lines.push(
        `| ${text(file.path)} | ${file.state} | ${file.visibleChangedLines} / ${file.totalChangedLines} | ${file.preloaded ? "有" : "无"} |`,
      );
    lines.push("");
    if (assessment.checks.status === "completed") {
      lines.push(
        "## 配置检查提醒",
        "",
        "以下是已读变更中的配置事实或启发式提醒，未经漏洞验证，不自动改变质量门禁。",
        "",
      );
      if (!assessment.checks.observations.length)
        lines.push("已执行的检查未产生提醒。", "");
      for (const observation of assessment.checks.observations) {
        lines.push(
          `### ${text(observation.title)}`,
          "",
          `${text(observation.path)}:${observation.line} · ${observation.level} · ${observation.nature}`,
          "",
          text(observation.message),
          "",
          `建议：${text(observation.recommendation)}`,
          "",
        );
        if (input.includeEvidence !== false)
          lines.push(code(observation.evidence), "");
      }
    }
    if (assessment.intelligence.tests.selected.length) {
      lines.push("## 建议运行的相关测试", "");
      for (const test of assessment.intelligence.tests.selected)
        lines.push(
          `- ${text(test.path)}：${test.reason}（${test.confidence}）`,
        );
      lines.push("");
    }
    if (assessment.intelligence.contracts.observations.length) {
      lines.push(
        "## 契约变更候选",
        "",
        "| 文件 | 主体 | 操作 | 需要核对 |",
        "| --- | --- | --- | --- |",
      );
      for (const change of assessment.intelligence.contracts.observations)
        lines.push(
          `| ${text(change.path)} | ${text(change.name)} | ${change.action} | ${text(change.review)} |`,
        );
      lines.push("");
    }
    if (assessment.owners.length) {
      lines.push("## 建议审查人", "");
      for (const owner of assessment.owners)
        lines.push(
          `- ${text(owner.owner)}：${owner.paths.map(text).join("、")}`,
        );
      lines.push("");
    }
    if (assessment.warnings.length) {
      lines.push("## 限制与提醒", "");
      for (const warning of assessment.warnings)
        lines.push(`- ${text(warning)}`);
      lines.push("");
    }
    return lines.join("\n");
  },
};
export default format;
