/**
 * 人工反馈保留提出者与处理者；用汇总数据衡量误报，不偷偷修改模型判断。
 * @example createFeedback(context,{findingId:'...',verdict:'false_positive',comment:'这里已有上游鉴权'});
 */
import type { Feedback, FeedbackVerdict } from "./types.js";
import { audit, identity, touch, type CommandContext } from "./audit.js";
import {
  choice,
  findRecord,
  optionalText,
  revision,
  text,
  WorkbenchError,
} from "./utils/input.js";

const verdicts: readonly FeedbackVerdict[] = [
  "useful",
  "false_positive",
  "missed_issue",
  "unclear",
];

/** 同一人对同一发现只保留一票，后续编辑更新这票而不是刷高权重。 */
export function createFeedback(
  context: CommandContext,
  input: Record<string, unknown>,
): Feedback {
  const finding = findRecord(
    context.data.findings,
    context.repository,
    input.findingId,
  );
  const verdict = choice(input.verdict, "verdict", verdicts);
  const comment = text(input.comment, "comment", 5000);
  const existing = context.data.feedback.find(
    (item) =>
      item.repository === context.repository &&
      item.findingId === finding.id &&
      item.createdBy === context.actor.userId,
  );
  if (existing) {
    existing.verdict = verdict;
    existing.comment = comment;
    existing.resolved = false;
    existing.resolution = "";
    existing.resolvedBy = "";
    existing.resolvedAt = null;
    touch(context, existing);
    audit(context, "feedback.updated", existing.id, {
      findingId: finding.id,
      verdict,
    });
    return existing;
  }
  const feedback: Feedback = {
    ...identity(context),
    findingId: finding.id,
    verdict,
    comment,
    resolved: false,
    resolution: "",
    resolvedBy: "",
    resolvedAt: null,
  };
  context.data.feedback.push(feedback);
  audit(context, "feedback.created", feedback.id, {
    findingId: finding.id,
    verdict,
  });
  return feedback;
}

/** 处理意见并不自动关闭发现；误报处置仍走明确的 finding.transition。 */
export function resolveFeedback(
  context: CommandContext,
  input: Record<string, unknown>,
): Feedback {
  const feedback = findRecord(
    context.data.feedback,
    context.repository,
    input.id,
  );
  revision(feedback, input.expectedRevision);
  if (feedback.resolved)
    throw new WorkbenchError("already_resolved", "反馈已经处理", 409);
  feedback.resolution = text(input.resolution, "resolution", 5000);
  feedback.resolved = true;
  feedback.resolvedBy = context.actor.userId;
  feedback.resolvedAt = context.now;
  touch(context, feedback);
  audit(context, "feedback.resolved", feedback.id, {
    findingId: feedback.findingId,
  });
  return feedback;
}

/** 按规则汇总，便于定位哪条审查规则需要调提示词或关闭。 */
export function feedbackSummary(
  context: CommandContext,
  input: Record<string, unknown>,
): {
  total: number;
  unresolved: number;
  verdicts: Record<FeedbackVerdict, number>;
  rules: {
    ruleId: string;
    useful: number;
    falsePositive: number;
    total: number;
    usefulRate: number;
  }[];
} {
  const requested = optionalText(input.ruleId, "ruleId", 200);
  const findings = new Map(
    context.data.findings
      .filter((item) => item.repository === context.repository)
      .map((finding) => [finding.id, finding]),
  );
  const records = context.data.feedback.filter(
    (item) =>
      item.repository === context.repository &&
      (!requested || findings.get(item.findingId)?.ruleId === requested),
  );
  const counts: Record<FeedbackVerdict, number> = {
    useful: 0,
    false_positive: 0,
    missed_issue: 0,
    unclear: 0,
  };
  const rules = new Map<
    string,
    {
      ruleId: string;
      useful: number;
      falsePositive: number;
      total: number;
      usefulRate: number;
    }
  >();
  for (const record of records) {
    counts[record.verdict] += 1;
    const ruleId = findings.get(record.findingId)!.ruleId;
    const rule = rules.get(ruleId) ?? {
      ruleId,
      useful: 0,
      falsePositive: 0,
      total: 0,
      usefulRate: 0,
    };
    rule.total += 1;
    if (record.verdict === "useful") rule.useful += 1;
    if (record.verdict === "false_positive") rule.falsePositive += 1;
    rule.usefulRate = rule.useful / rule.total;
    rules.set(ruleId, rule);
  }
  return {
    total: records.length,
    unresolved: records.filter((record) => !record.resolved).length,
    verdicts: counts,
    rules: [...rules.values()].sort(
      (left, right) =>
        right.total - left.total || left.ruleId.localeCompare(right.ruleId),
    ),
  };
}
