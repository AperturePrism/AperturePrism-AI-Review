/**
 * 质量门禁只计算，不发布 GitHub 状态；宿主决定何时把结果对外展示。
 * @example evaluateGate(context, {policyId:'...', humanApproved:true});
 */
import type {
  Finding,
  GateCheck,
  GateDecision,
  GateResult,
  Policy,
  PolicyRules,
} from "./types.js";
import type { CommandContext } from "./audit.js";
import { activePolicyVersion, DEFAULT_POLICY_RULES } from "./policy.js";
import { matchingSuppression } from "./suppression.js";
import {
  boolean,
  findRecord,
  globMatches,
  optionalText,
  severities,
} from "./utils/input.js";

function matchesPolicy(finding: Finding, rules: PolicyRules): boolean {
  if (finding.confidence < rules.minConfidence) return false;
  if (
    rules.includePaths.length &&
    !rules.includePaths.some((pattern) => globMatches(pattern, finding.path))
  )
    return false;
  if (rules.excludePaths.some((pattern) => globMatches(pattern, finding.path)))
    return false;
  if (
    rules.labels.length &&
    !rules.labels.some((label) => finding.tags.includes(label))
  )
    return false;
  return true;
}

/** 默认选择最近更新的启用策略；显式 policyId 可重现历史报告。 */
export function selectedPolicy(
  context: CommandContext,
  input: Record<string, unknown>,
): Policy | null {
  const policyId = optionalText(input.policyId, "policyId", 100);
  if (policyId)
    return findRecord(context.data.policies, context.repository, policyId);
  return (
    context.data.policies
      .filter(
        (policy) => policy.repository === context.repository && policy.enabled,
      )
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.id.localeCompare(right.id),
      )[0] ?? null
  );
}

/**
 * 已有问题只有严重度不升级时才算基线内；升为高风险仍会阻断。
 * 所有时间都使用同一事务时钟，临界到期规则不会一半有效一半失效。
 */
export function evaluateGate(
  context: CommandContext,
  input: Record<string, unknown>,
): GateResult {
  const policy = selectedPolicy(context, input);
  const version = policy ? activePolicyVersion(policy) : null;
  const rules = version?.rules ?? DEFAULT_POLICY_RULES;
  const baselineId = optionalText(input.baselineId, "baselineId", 100);
  const baseline = baselineId
    ? findRecord(context.data.baselines, context.repository, baselineId)
    : (context.data.baselines.find(
        (item) =>
          item.repository === context.repository &&
          item.active &&
          !item.archived,
      ) ?? null);
  const baselineFindings = new Map(
    baseline?.findings.map((item) => [item.fingerprint, item]) ?? [],
  );
  const all = context.data.findings.filter(
    (finding) => finding.repository === context.repository,
  );
  const resolved = all.filter((finding) =>
    ["fixed", "false_positive"].includes(finding.status),
  );
  const open = all.filter(
    (finding) =>
      ["open", "acknowledged"].includes(finding.status) &&
      matchesPolicy(finding, rules),
  );
  const suppressed = open.filter((finding) =>
    matchingSuppression(finding, context.data.suppressions, context.now),
  );
  const suppressionIds = new Set(suppressed.map((finding) => finding.id));
  const actionable = open.filter((finding) => !suppressionIds.has(finding.id));
  const existing: Finding[] = [];
  const added: Finding[] = [];
  for (const finding of actionable) {
    const previous = baselineFindings.get(finding.fingerprint);
    if (
      previous &&
      severities.indexOf(finding.severity) >=
        severities.indexOf(previous.severity)
    )
      existing.push(finding);
    else added.push(finding);
  }
  const blocked = added.filter((finding) =>
    rules.blockedSeverities.includes(finding.severity),
  );
  const checks: GateCheck[] = [
    {
      name: "blocked_severity",
      decision: blocked.length ? "fail" : "pass",
      message: blocked.length
        ? `${blocked.length} 个新增发现达到阻断严重度`
        : "没有新增阻断级发现",
      findingIds: blocked.map((finding) => finding.id),
    },
    {
      name: "new_findings",
      decision: added.length > rules.maxNewFindings ? "fail" : "pass",
      message: `新增 ${added.length}，允许最多 ${rules.maxNewFindings}`,
      findingIds:
        added.length > rules.maxNewFindings
          ? added.map((finding) => finding.id)
          : [],
    },
    {
      name: "baseline",
      decision: rules.requireBaseline && !baseline ? "fail" : "pass",
      message: baseline
        ? `使用基线 ${baseline.name}`
        : rules.requireBaseline
          ? "策略要求活动基线"
          : "策略允许首次审查无基线",
      findingIds: [],
    },
    {
      name: "human_approval",
      decision:
        rules.requireHumanApproval &&
        !boolean(input.humanApproved, "humanApproved", false)
          ? "fail"
          : "pass",
      message: rules.requireHumanApproval
        ? input.humanApproved === true
          ? "已提供人工确认"
          : "等待人工确认"
        : "策略未要求人工确认",
      findingIds: [],
    },
  ];
  const expiring = context.data.suppressions.filter(
    (item) =>
      item.repository === context.repository &&
      item.enabled &&
      item.expiresAt !== null &&
      item.expiresAt <= context.now,
  );
  if (expiring.length)
    checks.push({
      name: "expired_suppressions",
      decision: "warn",
      message: `${expiring.length} 条忽略规则已到期`,
      findingIds: [],
    });
  if (all.length === 0)
    checks.push({
      name: "empty_review",
      decision: "warn",
      message: "尚无审查发现记录，请确认审查任务确已完成",
      findingIds: [],
    });
  const decision: GateDecision = checks.some(
    (check) => check.decision === "fail",
  )
    ? "fail"
    : checks.some((check) => check.decision === "warn")
      ? "warn"
      : "pass";
  return {
    repository: context.repository,
    decision,
    policyId: policy?.id ?? null,
    policyVersion: version?.version ?? null,
    baselineId: baseline?.id ?? null,
    checks,
    counts: {
      total: all.length,
      new: added.length,
      existing: existing.length,
      suppressed: suppressed.length,
      resolved: resolved.length,
    },
    evaluatedAt: context.now,
  };
}
