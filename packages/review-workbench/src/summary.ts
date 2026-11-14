/**
 * 仪表盘从业务记录现场计算，避免维护另一份容易失步的计数表。
 * @example summarizeWorkbench(context);
 */
import type { WorkbenchSummary } from "./types.js";
import type { CommandContext } from "./audit.js";
import { evaluateGate } from "./gate.js";
import { matchingSuppression } from "./suppression.js";
import { WorkbenchError } from "./utils/input.js";

function totalMicros(values: readonly number[]): number {
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER))
    throw new WorkbenchError(
      "summary_overflow",
      "预算总额超过安全整数范围，请按预算单独查看",
      409,
    );
  return Number(total);
}

export function summarizeWorkbench(context: CommandContext): WorkbenchSummary {
  const findings = context.data.findings.filter(
    (item) => item.repository === context.repository,
  );
  const policies = context.data.policies.filter(
    (item) => item.repository === context.repository,
  );
  const budgets = context.data.budgets.filter(
    (item) =>
      item.repository === context.repository &&
      item.enabled &&
      item.periodStart <= context.now &&
      item.periodEnd > context.now,
  );
  const batches = context.data.batches.filter(
    (item) => item.repository === context.repository,
  );
  const severity: WorkbenchSummary["severity"] = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const finding of findings) {
    if (finding.status === "open" || finding.status === "acknowledged")
      severity[finding.severity] += 1;
  }
  return {
    repository: context.repository,
    policies: policies.length,
    activePolicies: policies.filter((item) => item.enabled).length,
    baselines: context.data.baselines.filter(
      (item) => item.repository === context.repository && !item.archived,
    ).length,
    findings: findings.length,
    openFindings: findings.filter(
      (item) => item.status === "open" || item.status === "acknowledged",
    ).length,
    suppressedFindings: findings.filter(
      (item) =>
        (item.status === "open" || item.status === "acknowledged") &&
        matchingSuppression(item, context.data.suppressions, context.now),
    ).length,
    batches: batches.length,
    runningBatches: batches.filter(
      (item) => item.status === "queued" || item.status === "running",
    ).length,
    pendingFeedback: context.data.feedback.filter(
      (item) => item.repository === context.repository && !item.resolved,
    ).length,
    budgetAmountMicros: totalMicros(
      budgets.map((item) => item.limits.amountMicros),
    ),
    spentAmountMicros: totalMicros(
      budgets.map((item) => item.usage.amountMicros),
    ),
    severity,
    gate: evaluateGate(context, {}),
  };
}
