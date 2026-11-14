/**
 * 评估报告：精确 JSON、供人阅读的 Markdown、可进表格的 CSV。
 * @example
 * renderReviewEvaluation(result, { format: "markdown", comparison, gate });
 *
 * 默认报告不携带数据集 input 和预测 message，避免把源码复制进 CI 日志。
 */
import { EVALUATION_SEVERITIES } from "./dataset.js";
import { type ReviewComparison } from "./comparison.js";
import { type ReviewGateResult } from "./gate.js";
import { type ReviewEvaluation } from "./score.js";

export type EvaluationReportOptions = {
  format: "json" | "markdown" | "csv";
  comparison?: ReviewComparison;
  gate?: ReviewGateResult;
};

function percentage(value: number | null): string {
  return value === null ? "未定义" : `${(value * 100).toFixed(2)}%`;
}
function decimal(value: number | null): string {
  return value === null ? "未知" : value.toFixed(2);
}
function markdown(value: string): string {
  return value
    .replace(/[\r\n]/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function csv(value: string | number | boolean | null): string {
  let text = value === null ? "" : String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`; // 导入 Excel/Sheets 后不会把模型名或案例名当公式执行。
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 移除消息正文后再序列化，JSON 报告仍足以复算每条匹配与门禁。 */
export function renderReviewEvaluation(
  result: ReviewEvaluation,
  options: EvaluationReportOptions,
): string {
  if (options.comparison && options.comparison.candidateRunId !== result.runId)
    throw new RangeError("comparison belongs to another candidate");
  if (options.gate && options.gate.runId !== result.runId)
    throw new RangeError("gate belongs to another candidate");
  if (options.format === "json") {
    const safe = {
      ...result,
      cases: result.cases.map((item) => ({
        ...item,
        falsePositives: item.falsePositives.map(
          ({ message: _message, ...finding }) => finding,
        ),
        ignoredLowConfidence: item.ignoredLowConfidence.map(
          ({ message: _message, ...finding }) => finding,
        ),
      })),
    };
    return (
      JSON.stringify(
        {
          evaluation: safe,
          comparison: options.comparison ?? null,
          gate: options.gate ?? null,
        },
        null,
        2,
      ) + "\n"
    );
  }
  if (options.format === "csv") {
    const rows: (string | number | boolean | null)[][] = [
      [
        "case_id",
        "repository",
        "split",
        "true_positive",
        "false_positive",
        "false_negative",
        "precision",
        "recall",
        "f1",
        "weighted_f1",
        "duration_ms",
        "input_tokens",
        "output_tokens",
        "cost_micros",
        "missing",
        "error_category",
        "perfect",
      ],
    ];
    for (const item of result.cases)
      rows.push([
        item.caseId,
        item.repository,
        item.split,
        item.metrics.truePositive,
        item.metrics.falsePositive,
        item.metrics.falseNegative,
        item.metrics.precision,
        item.metrics.recall,
        item.metrics.f1,
        item.weighted.f1,
        item.durationMs,
        item.inputTokens,
        item.outputTokens,
        item.costMicros,
        item.missingPrediction,
        item.errorCategory,
        item.perfect,
      ]);
    return rows.map((row) => row.map(csv).join(",")).join("\r\n") + "\r\n";
  }
  if (options.format !== "markdown")
    throw new RangeError("format must be json, markdown, or csv");
  const lines = [
    `# 审查评估：${markdown(result.runId)}`,
    "",
    `模型：${markdown(result.model)}；策略：${markdown(result.policyVersion)}；划分：${result.split}。`,
    "",
    `数据集：${markdown(result.datasetId)}；版本：\`${result.datasetHash}\`。`,
    "",
    "| 指标 | 结果 |",
    "|---|---:|",
    `| 案例数 | ${result.caseCount} |`,
    `| 精确率 | ${percentage(result.metrics.precision)} |`,
    `| 召回率 | ${percentage(result.metrics.recall)} |`,
    `| F1 | ${percentage(result.metrics.f1)} |`,
    `| 严重度加权 F1 | ${percentage(result.weighted.f1)} |`,
    `| TP / FP / FN | ${result.metrics.truePositive} / ${result.metrics.falsePositive} / ${result.metrics.falseNegative} |`,
    `| 完整通过 / 缺失 / 调用失败 | ${result.perfectCases} / ${result.missingCases} / ${result.failedCases} |`,
    `| 延迟 p50 / p95 / p99 (ms) | ${decimal(result.performance.p50Ms)} / ${decimal(result.performance.p95Ms)} / ${decimal(result.performance.p99Ms)} |`,
    `| 输入 / 输出 token | ${result.performance.inputTokens} / ${result.performance.outputTokens} |`,
    `| 总费用 (微单位) | ${result.performance.costMicros ?? "未知"} ${result.performance.currency ?? ""} |`,
    "",
    "| 严重度 | 精确率 | 召回率 | F1 | TP / FP / FN |",
    "|---|---:|---:|---:|---:|",
  ];
  for (const severity of EVALUATION_SEVERITIES) {
    const item = result.bySeverity[severity];
    lines.push(
      `| ${severity} | ${percentage(item.precision)} | ${percentage(item.recall)} | ${percentage(item.f1)} | ${item.truePositive} / ${item.falsePositive} / ${item.falseNegative} |`,
    );
  }
  if (options.comparison) {
    const compare = options.comparison;
    lines.push(
      "",
      `对比 ${markdown(compare.baselineRunId)}：F1 变化 ${percentage(compare.delta.f1)}，成对 Bootstrap 区间 ${percentage(compare.intervals.f1.low)} 至 ${percentage(compare.intervals.f1.high)}（${compare.intervals.f1.samples} 次，seed=${compare.intervals.f1.seed}）。`,
      "",
      `判定：${compare.outcome}。区间描述当前数据集的不确定性，不保证其他仓库表现。`,
    );
    if (compare.warnings.length)
      lines.push(
        "",
        `数据限制：${compare.warnings.map(markdown).join("、")}。`,
      );
  }
  if (options.gate) {
    lines.push(
      "",
      `门禁：${options.gate.passed ? "通过" : "失败"}。`,
      "",
      "| 检查 | 实际值 | 门槛 | 结果 | 原因 |",
      "|---|---:|---:|---|---|",
    );
    for (const check of options.gate.checks)
      lines.push(
        `| ${check.id} | ${check.actual ?? "未知"} | ${check.threshold} | ${check.passed ? "通过" : "失败"} | ${check.reason} |`,
      );
  }
  lines.push(
    "",
    "逐案例结果：",
    "",
    "| 案例 | F1 | TP / FP / FN | 状态 |",
    "|---|---:|---:|---|",
  );
  for (const item of result.cases)
    lines.push(
      `| ${markdown(item.caseId)} | ${percentage(item.metrics.f1)} | ${item.metrics.truePositive} / ${item.metrics.falsePositive} / ${item.metrics.falseNegative} | ${item.missingPrediction ? "缺失预测" : item.errorCategory ? markdown(item.errorCategory) : item.perfect ? "通过" : "有差异"} |`,
    );
  return lines.join("\n") + "\n";
}
