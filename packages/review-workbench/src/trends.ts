/**
 * 时间桶来自实际审查交付账本；没有记录的日期保持零，不外推或伪造增长趋势。
 * @example workbenchTrends(context,{days:30});
 */
import type { WorkbenchTrends } from "./types.js";
import type { CommandContext } from "./audit.js";
import { integer } from "./utils/input.js";

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function workbenchTrends(
  context: CommandContext,
  input: Record<string, unknown>,
): WorkbenchTrends {
  const days = integer(input.days, "days", 1, 365, 30);
  const until = new Date(context.now);
  const start = new Date(
    Date.UTC(
      until.getUTCFullYear(),
      until.getUTCMonth(),
      until.getUTCDate() - days + 1,
    ),
  );
  const daily: WorkbenchTrends["daily"] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(start.getTime() + offset * 86_400_000)
      .toISOString()
      .slice(0, 10);
    daily.push({
      date,
      reviews: 0,
      imported: 0,
      resolved: 0,
      gatePass: 0,
      gateWarn: 0,
      gateFail: 0,
    });
  }
  const buckets = new Map(daily.map((item) => [item.date, item]));
  const reviews = context.data.reviews.filter(
    (record) =>
      record.repository === context.repository &&
      record.receivedAt >= start.toISOString() &&
      record.receivedAt <= context.now,
  );
  for (const review of reviews) {
    const bucket = buckets.get(review.receivedAt.slice(0, 10))!;
    bucket.reviews += 1;
    bucket.imported += review.imported;
    bucket.resolved += review.resolved;
    if (review.gate.decision === "pass") bucket.gatePass += 1;
    if (review.gate.decision === "warn") bucket.gateWarn += 1;
    if (review.gate.decision === "fail") bucket.gateFail += 1;
  }
  const findings = context.data.findings.filter(
    (finding) => finding.repository === context.repository,
  );
  const findingById = new Map(findings.map((finding) => [finding.id, finding]));
  const rules = new Map<string, WorkbenchTrends["rules"][number]>();
  const fixes = new Map<string, number[]>();
  const owners = new Map<string, WorkbenchTrends["owners"][number]>();
  const aging = { under7Days: 0, days7To30: 0, days30To90: 0, over90Days: 0 };
  let reopenedFindings = 0;
  for (const finding of findings) {
    const rule = rules.get(finding.ruleId) ?? {
      ruleId: finding.ruleId,
      open: 0,
      fixed: 0,
      falsePositive: 0,
      acceptedRisk: 0,
      feedback: 0,
      usefulFeedback: 0,
      medianFixHours: null,
    };
    if (finding.status === "fixed") rule.fixed += 1;
    if (finding.status === "false_positive") rule.falsePositive += 1;
    if (finding.status === "accepted_risk") rule.acceptedRisk += 1;
    const fixed = finding.history.find(
      (change) => change.action === "status" && change.to === "fixed",
    );
    if (fixed) {
      const hours = Math.max(
        0,
        (new Date(fixed.at).getTime() - new Date(finding.createdAt).getTime()) /
          3_600_000,
      );
      fixes.set(finding.ruleId, [...(fixes.get(finding.ruleId) ?? []), hours]);
    }
    if (
      finding.history.some(
        (change) =>
          change.action === "reappeared" ||
          (change.action === "status" &&
            change.to === "open" &&
            change.from !== ""),
      )
    )
      reopenedFindings += 1;
    if (finding.status === "open" || finding.status === "acknowledged") {
      rule.open += 1;
      const age = Math.max(
        0,
        (until.getTime() - new Date(finding.createdAt).getTime()) / 86_400_000,
      );
      if (age < 7) aging.under7Days += 1;
      else if (age < 30) aging.days7To30 += 1;
      else if (age < 90) aging.days30To90 += 1;
      else aging.over90Days += 1;
      const owner = owners.get(finding.assignee) ?? {
        assignee: finding.assignee,
        open: 0,
        critical: 0,
        high: 0,
        oldestDays: 0,
      };
      owner.open += 1;
      if (finding.severity === "critical") owner.critical += 1;
      if (finding.severity === "high") owner.high += 1;
      owner.oldestDays = Math.max(owner.oldestDays, Math.floor(age));
      owners.set(finding.assignee, owner);
    }
    rules.set(finding.ruleId, rule);
  }
  for (const feedback of context.data.feedback) {
    if (feedback.repository !== context.repository) continue;
    const finding = findingById.get(feedback.findingId)!;
    const rule = rules.get(finding.ruleId)!;
    rule.feedback += 1;
    if (feedback.verdict === "useful") rule.usefulFeedback += 1;
  }
  for (const rule of rules.values())
    rule.medianFixHours = median(fixes.get(rule.ruleId) ?? []);
  return {
    repository: context.repository,
    since: start.toISOString(),
    until: context.now,
    daily,
    rules: [...rules.values()].sort(
      (left, right) =>
        right.open - left.open || left.ruleId.localeCompare(right.ruleId),
    ),
    owners: [...owners.values()].sort(
      (left, right) =>
        right.critical - left.critical ||
        right.high - left.high ||
        right.open - left.open ||
        left.assignee.localeCompare(right.assignee),
    ),
    aging,
    totals: {
      reviews: reviews.length,
      imported: reviews.reduce((total, record) => total + record.imported, 0),
      resolved: reviews.reduce((total, record) => total + record.resolved, 0),
      failRate: reviews.length
        ? reviews.filter((record) => record.gate.decision === "fail").length /
          reviews.length
        : 0,
      fixedFindings: findings.filter((finding) => finding.status === "fixed")
        .length,
      reopenedFindings,
    },
  };
}
