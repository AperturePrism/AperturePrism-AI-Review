import {
  highPriorityLevels,
  highSeverityLevels,
  issueAnalysisResultSchema,
  type IssueAnalysisResult,
} from "./issue-analysis.js";

export type GradingAdjustment = {
  field: "severity" | "priority" | "probableCause" | "proposedChanges";
  from: string;
  to: string;
  reason: string;
};

export type GradingOptions = {
  /**
   * 本次分析是否真的读取过仓库源码。为 false 时会剥离 proposedChanges 里的
   * locator：没读过代码却给出行号必然是编造，比不给建议更有害。
   */
  exploredCode?: boolean;
};

export type GradedIssueAnalysis = {
  result: IssueAnalysisResult;
  adjustments: readonly GradingAdjustment[];
};

/**
 * Evidence kinds that can carry a high severity on their own. Impact scope is
 * excluded because a model can assert broad impact without any issue detail.
 */
const substantiveEvidenceKinds: readonly string[] = [
  "reproduction_steps",
  "logs",
  "stack_trace",
  "data_loss",
  "security_path",
];

function hasSubstantiveEvidence(result: IssueAnalysisResult): boolean {
  return result.evidence.some(
    (item) =>
      substantiveEvidenceKinds.includes(item.kind) &&
      item.excerpt.trim().length > 0,
  );
}

/**
 * Enforces the grading rules on the server instead of trusting the model to
 * restrain itself. A high grade without verifiable evidence is downgraded to
 * an explicit unknown, which is honest rather than confidently wrong.
 */
export function applyGradingRules(
  result: IssueAnalysisResult,
  options: GradingOptions = {},
): GradedIssueAnalysis {
  const adjustments: GradingAdjustment[] = [];
  let severity = result.severity;
  let priority = result.priority;

  const evidenced = hasSubstantiveEvidence(result);

  if (highSeverityLevels.includes(severity) && !evidenced) {
    adjustments.push({
      field: "severity",
      from: severity,
      to: "unknown",
      reason:
        "high severity requires reproduction, logs, stack, data loss, or a security path",
    });
    severity = "unknown";
  }

  if (highPriorityLevels.includes(priority) && !evidenced) {
    adjustments.push({
      field: "priority",
      from: priority,
      to: "needs_triage",
      reason: "high priority requires verifiable evidence in the issue",
    });
    priority = "needs_triage";
  }

  // An invalid or incomplete report cannot support a confident schedule.
  if (
    (result.quality === "invalid" || result.quality === "incomplete") &&
    highPriorityLevels.includes(priority)
  ) {
    adjustments.push({
      field: "priority",
      from: priority,
      to: "needs_triage",
      reason: `quality ${result.quality} cannot justify a high priority`,
    });
    priority = "needs_triage";
  }

  if (result.quality === "invalid" && severity !== "unknown") {
    adjustments.push({
      field: "severity",
      from: severity,
      to: "unknown",
      reason: "an invalid report cannot establish severity",
    });
    severity = "unknown";
  }

  // 低置信度的「原因」比不给更糟：用户会照着错方向排查。
  let probableCause = result.probableCause;
  if (probableCause && result.confidence.rootCause < 0.5) {
    adjustments.push({
      field: "probableCause",
      from: "present",
      to: "removed",
      reason: "根因置信度不足 0.5，不足以给出原因判断",
    });
    probableCause = undefined;
  }

  // 没读过代码就给出行号必然是编造。剥离 locator 但保留 change 文字建议。
  // 兼容直接传入手写对象（未过 zod 默认值填充）的调用方。
  let proposedChanges = result.proposedChanges ?? [];
  if (!options.exploredCode && proposedChanges.some((item) => item.locator)) {
    adjustments.push({
      field: "proposedChanges",
      from: "with-locator",
      to: "path-only",
      reason: "未读取源码，无法确认具体位置，已移除行号/符号定位",
    });
    proposedChanges = proposedChanges.map(
      ({ locator: _drop, ...rest }) => rest,
    );
  }

  const { probableCause: _originalCause, ...rest } = result;
  return {
    result: {
      ...rest,
      severity,
      priority,
      ...(probableCause === undefined ? {} : { probableCause }),
      proposedChanges,
    },
    adjustments,
  };
}

export type ContractValidation =
  | { outcome: "valid"; analysis: GradedIssueAnalysis }
  | { outcome: "invalid"; issues: readonly string[] };

/**
 * Parses and grades a model response. Returning structured issues lets the
 * router attempt exactly one bounded repair instead of retrying blindly.
 */
export function validateIssueAnalysis(
  raw: unknown,
  options: GradingOptions = {},
): ContractValidation {
  const parsed = issueAnalysisResultSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      outcome: "invalid",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "root"}: ${issue.message}`,
      ),
    };
  }
  return {
    outcome: "valid",
    analysis: applyGradingRules(parsed.data, options),
  };
}

/**
 * 从模型输出中容错提取 JSON。之前是严格 JSON.parse —— 模型一旦用 ```json
 * 代码块包裹、带尾随解释文字，或输出被 maxOutputTokens 截断，就整个判 invalid。
 * 现在依次尝试：纯 JSON → markdown 围栏 → 首个 `{` 到末个 `}`。
 */
function extractIssueAnalysisJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) return fence[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

/** Parses a JSON model response without letting syntax errors escape. */
export function parseIssueAnalysisJson(
  text: string,
  options: GradingOptions = {},
): ContractValidation {
  try {
    return validateIssueAnalysis(
      JSON.parse(extractIssueAnalysisJson(text)),
      options,
    );
  } catch {
    return {
      outcome: "invalid",
      issues: ["root: response was not valid JSON"],
    };
  }
}
