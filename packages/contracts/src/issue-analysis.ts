import { z } from "zod";

/**
 * Evidence kinds that can justify a high severity or priority. The analyzer
 * must point at something concrete in the issue, never at its own reasoning.
 */
export const evidenceKinds = [
  "reproduction_steps",
  "logs",
  "stack_trace",
  "data_loss",
  "security_path",
  "impact_scope",
] as const;

export const evidenceSchema = z.object({
  kind: z.enum(evidenceKinds),
  /** Verbatim excerpt from the issue, so reviewers can verify the claim. */
  excerpt: z
    .string()
    .min(1)
    .max(2_000)
    .refine((value) => value.trim().length > 0, {
      message: "evidence excerpt must contain non-whitespace text",
    }),
});

export const issueCategories = [
  "bug",
  "feature",
  "question",
  "security",
  "performance",
  "documentation",
  "other",
] as const;

/** Severity describes impact. It is deliberately independent of priority. */
export const severityLevels = ["S0", "S1", "S2", "S3", "unknown"] as const;

/** Priority describes scheduling urgency, which is a separate judgment. */
export const priorityLevels = ["P0", "P1", "P2", "P3", "needs_triage"] as const;

export const qualityLevels = [
  "complete",
  "actionable",
  "incomplete",
  "invalid",
] as const;

export const highSeverityLevels: readonly string[] = ["S0", "S1"];
export const highPriorityLevels: readonly string[] = ["P0", "P1"];

const confidenceSchema = z.number().min(0).max(1);

/** 一条具体的修改建议：定位到文件，尽量给出位置与改法。 */
export const proposedChangeSchema = z
  .object({
    path: z.string().min(1).max(300),
    /** 行号或符号名等定位信息；未读过代码时必须省略，不允许编造。 */
    locator: z.string().min(1).max(120).optional(),
    change: z.string().min(1).max(800),
  })
  .strict();

export const issueAnalysisResultSchema = z
  .object({
    contractVersion: z.literal("issue-analysis/v1"),
    category: z.enum(issueCategories),
    summary: z.string().min(1).max(2_000),
    severity: z.enum(severityLevels),
    priority: z.enum(priorityLevels),
    quality: z.enum(qualityLevels),
    /** 当原标题含糊/冗长时给出更清晰的标题；标题已清晰时省略。 */
    suggestedTitle: z.string().min(1).max(120).optional(),
    /** 最可能的原因；无把握时省略，绝不猜测。 */
    probableCause: z.string().min(1).max(1_000).optional(),
    /** 用户可自行执行的排查步骤，按先后顺序。 */
    troubleshooting: z.array(z.string().min(1).max(500)).max(6).default([]),
    /** 具体修改建议；只有读过代码时才应给出 locator。 */
    proposedChanges: z.array(proposedChangeSchema).max(6).default([]),
    evidence: z.array(evidenceSchema).max(10).default([]),
    /** Facts the issue does not provide. Never invented by the analyzer. */
    missingInformation: z.array(z.string().min(1).max(500)).max(10).default([]),
    suggestedLabels: z.array(z.string().min(1).max(50)).max(10).default([]),
    suggestedActions: z.array(z.string().min(1).max(500)).max(10).default([]),
    /**
     * 建议指派的 GitHub 用户列表，逗号分隔、不含 @ 前缀（如 "user1, user2"）；
     * 服务端自动指派后回写全部实际指派人（issue #53）；无把握时省略，绝不编造。
     */
    suggestedAssignee: z.string().min(1).max(500).optional(),
    confidence: z.object({
      severity: confidenceSchema,
      rootCause: confidenceSchema,
      suggestion: confidenceSchema,
    }),
  })
  .strict();

export type IssueAnalysisResult = z.infer<typeof issueAnalysisResultSchema>;
export type IssueEvidence = z.infer<typeof evidenceSchema>;
export type ProposedChange = z.infer<typeof proposedChangeSchema>;

export const duplicateDecisions = [
  "duplicate",
  "related",
  "not_duplicate",
  "insufficient_evidence",
] as const;

export const duplicateJudgmentSchema = z
  .object({
    contractVersion: z.literal("duplicate-judgment/v1"),
    decision: z.enum(duplicateDecisions),
    /** Issue numbers that support the decision, ranked most relevant first. */
    relatedIssues: z.array(z.number().int().positive()).max(10).default([]),
    sharedSignals: z.array(z.string().min(1).max(500)).max(10).default([]),
    differingSignals: z.array(z.string().min(1).max(500)).max(10).default([]),
    confidence: confidenceSchema,
  })
  .strict();

export type DuplicateJudgment = z.infer<typeof duplicateJudgmentSchema>;
