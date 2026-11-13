import {
  formatSuggestedTitle,
  type GradedIssueAnalysis,
} from "../../../packages/contracts/src/index.js";
import type { RelatedIssueRow } from "../../../packages/duplicate-detection/src/index.js";
import { renderIssueTriage, type IssueTriage } from "./triage.js";
import type { EvidenceAudit } from "./evidence.js";
import { CODE_ACCESS_UNKNOWN_PATH } from "./prompt.js";

const severityLabels: Readonly<Record<string, string>> = {
  S0: "S0（灾难性）",
  S1: "S1（严重）",
  S2: "S2（中等）",
  S3: "S3（轻微）",
  unknown: "unknown（未知）",
};

const priorityLabels: Readonly<Record<string, string>> = {
  P0: "P0（立即处理）",
  P1: "P1（尽快处理）",
  P2: "P2（常规）",
  P3: "P3（低优先级）",
  needs_triage: "needs_triage（待人工分诊）",
};

const qualityLabels: Readonly<Record<string, string>> = {
  complete: "complete（完整）",
  actionable: "actionable（可操作）",
  incomplete: "incomplete（不完整）",
  invalid: "invalid（无效）",
};

const evidenceKindLabels: Readonly<Record<string, string>> = {
  reproduction_steps: "复现步骤",
  logs: "日志",
  stack_trace: "堆栈",
  data_loss: "数据损坏",
  security_path: "安全路径",
  impact_scope: "影响范围",
};

export function buildPlaceholderComment(): string {
  return "🤖 **AperturePrism** 正在分析该 Issue，完成后会原位更新此评论。";
}

/** 失败原因到用户可读说明的映射；未知分类只说明结果，不编造原因。 */
const failureReasons: Readonly<Record<string, string>> = {
  invalid_output:
    "模型返回的结果不符合约定格式，已自动重试若干次仍未通过校验。",
  handler_error: "分析过程中出现异常，可能是模型服务暂时不可用。",
  github_not_found: "读取该 Issue 时 GitHub 返回资源不存在。",
  github_auth_failed: "GitHub 授权失败，无法读取该 Issue。",
  unsupported_task_type: "当前版本尚不支持该任务类型。",
};

/**
 * 分析失败时改写占位评论。不做这件事的话，占位会永远停在「正在分析」，
 * 用户看到的是一条误导性评论。
 */
export function buildFailureComment(errorCategory: string): string {
  const reason =
    failureReasons[errorCategory] ??
    "分析未能完成，具体原因已记录在任务事件中。";
  return [
    "## 🤖 AperturePrism 分析未完成",
    "",
    reason,
    "",
    `失败原因：\`${errorCategory}\``,
    "",
    "> 可在 WebUI 的任务详情中查看完整失败信息；修复后可重新触发分析。",
  ].join("\n");
}

export function buildIssueAnalysisComment(
  analysis: GradedIssueAnalysis & {
    triage?: IssueTriage;
    evidenceAudit?: EvidenceAudit;
  },
  related: readonly RelatedIssueRow[] = [],
): string {
  const { result, adjustments } = analysis;
  const lines: string[] = [
    "## 🤖 AperturePrism 分析",
    "",
    `**分类**：${result.category}`,
    `**Severity**：${severityLabels[result.severity] ?? result.severity}`,
    `**Priority**：${priorityLabels[result.priority] ?? result.priority}`,
    `**信息质量**：${qualityLabels[result.quality] ?? result.quality}`,
    "",
    "### 摘要",
    result.summary,
  ];

  // 显示层标记：视觉/图片理解未参与（带图 Issue 在视觉模型不可用时回退文本）。
  if ((result as { _visionSkipped?: boolean })._visionSkipped) {
    lines.push(
      "",
      "> ⚠️ 该 Issue 含图片，但视觉模型暂不可用，本次分析未读取图片（已回退文本分析）。",
    );
  }

  // 与实际改写保持一致：展示服务端拼装后的 [标签][重要度]标题（issue #5）。
  const suggestedTitle = formatSuggestedTitle(result);
  if (suggestedTitle) {
    lines.push("", `### 建议标题`, suggestedTitle);
  }

  // 原因与修复方向（issue #6）：只在模型给出且通过服务端校验时展示。
  if (result.probableCause) {
    lines.push("", "### 可能原因", result.probableCause);
  }

  if ((result.proposedChanges ?? []).length > 0) {
    lines.push("", "### 建议修改", "");
    for (const item of result.proposedChanges ?? []) {
      const where = item.locator ? ` \`${item.locator}\`` : "";
      // 未读取源码时的占位路径不算真实代码位置，不包代码框（避免被误认为真实文件）。
      const path =
        item.path === CODE_ACCESS_UNKNOWN_PATH ? item.path : `\`${item.path}\``;
      lines.push(`- ${path}${where}：${item.change}`);
    }
  }

  if ((result.troubleshooting ?? []).length > 0) {
    lines.push("", "### 可以先试试", "");
    for (const step of result.troubleshooting ?? []) lines.push(`- ${step}`);
  }

  if (result.evidence.length > 0) {
    lines.push("", "### 证据", "");
    for (const item of result.evidence) {
      lines.push(
        `- **${evidenceKindLabels[item.kind] ?? item.kind}**：> ${item.excerpt}`,
      );
    }
  }

  if (result.missingInformation.length > 0) {
    lines.push("", "### 缺失信息", "");
    for (const item of result.missingInformation) lines.push(`- ${item}`);
  }

  if (result.suggestedActions.length > 0) {
    lines.push("", "### 建议动作", "");
    for (const item of result.suggestedActions) lines.push(`- [ ] ${item}`);
  }

  if (result.suggestedAssignee) {
    // 不带 @ 前缀存储，逗号分隔多人（issue #53）；渲染时逐个补 @ 使 GitHub 识别为可点击 mention。
    const assignees = result.suggestedAssignee
      .split(",")
      .map((login) => login.trim())
      .filter((login) => login.length > 0);
    if (assignees.length > 0) {
      lines.push(
        "",
        "### 建议指派人",
        assignees.map((login) => `@${login}`).join(" "),
      );
    }
  }

  if (result.suggestedLabels.length > 0) {
    // 每个标签包行内代码（GitHub 渲染为灰底框），空格平铺时边界难辨（issue #23）。
    lines.push(
      "",
      `### 建议标签`,
      result.suggestedLabels.map((label) => `\`${label}\``).join(" "),
    );
  }

  if (adjustments.length > 0) {
    lines.push("", "### 评级调整（服务端规则）", "");
    for (const item of adjustments) {
      lines.push(
        `- ${item.field}: ${item.from} → ${item.to}（${item.reason}）`,
      );
    }
  }

  if (related.length > 0) {
    lines.push("", "### 可能相关的历史 Issue（仅供参考，不自动关联）", "");
    for (const item of related.slice(0, 5)) {
      const repo = item.repositoryFullName ?? "unknown/repo";
      const reason = item.reasons.includes("signal") ? "信号" : "文本";
      lines.push(
        `- [#${item.issueNumber}](https://github.com/${repo}/issues/${item.issueNumber}) · ${repo}（${reason} 相似）`,
      );
    }
  }

  if (analysis.evidenceAudit && analysis.evidenceAudit.unverifiedCount > 0) {
    lines.push(
      "",
      `> 引用核验：${analysis.evidenceAudit.verifiedCount} 条可在本次输入中定位，${analysis.evidenceAudit.unverifiedCount} 条未定位；请人工核对。`,
    );
  }
  if (analysis.triage) lines.push("", renderIssueTriage(analysis.triage));

  const confidence = result.confidence;
  lines.push(
    "",
    "---",
    "> 置信度：severity "
      .concat(formatConfidence(confidence.severity))
      .concat(" · root cause ")
      .concat(formatConfidence(confidence.rootCause))
      .concat(" · suggestion ")
      .concat(formatConfidence(confidence.suggestion)),
    "> 由 AperturePrism 自动生成，评级已由服务端规则校验。",
  );

  return lines.join("\n");
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}
