/**
 * 审查策略：外部配置在这里检查一次，后续计算直接使用已验证的策略。
 * 调用：const policy = parseReviewPolicy({ minimumCoverage: 0.8 });
 * 配置可由 HTTP、CLI 或仓库文件传入；这里不读取环境变量，不改已有配置。
 */
import { z } from "zod"; // 在配置边界统一检查形状和范围。
import { findingSeverityLevels, type FindingSeverity } from "./types.js";

const pathPattern = z.string().trim().min(1).max(500); // 路径模式有界，避免意外巨型配置。
const ruleName = z.string().trim().min(1).max(120);

export const reviewPolicySchema = z
  .object({
    name: z.string().trim().min(1).max(120).default("default"),
    version: z.string().trim().min(1).max(100).default("1"),
    minimumConfidence: z.number().min(0).max(1).default(0.5),
    minimumSeverity: z.enum(findingSeverityLevels).default("medium"),
    minimumCoverage: z.number().min(0).max(1).default(0.8),
    maxFindings: z.number().int().min(0).max(500).default(50),
    maxNewCritical: z.number().int().min(0).max(500).default(0),
    maxNewHigh: z.number().int().min(0).max(500).default(0),
    maxNewMedium: z.number().int().min(0).max(500).default(10),
    requireEvidence: z.boolean().default(true),
    requireChangedLine: z.boolean().default(false),
    failOnIncompleteCoverage: z.boolean().default(false),
    onlyNewFindings: z.boolean().default(false),
    include: z.array(pathPattern).max(100).default([]),
    exclude: z.array(pathPattern).max(100).default([]),
    disabledRules: z.array(ruleName).max(200).default([]),
    severityOverrides: z
      .record(ruleName, z.enum(findingSeverityLevels))
      .default({}),
    sensitivePaths: z.array(pathPattern).max(100).default([]),
    generatedPaths: z.array(pathPattern).max(100).default([]),
    maxChunkTokens: z.number().int().min(256).max(100_000).default(8_000),
    maxChunkFiles: z.number().int().min(1).max(100).default(12),
  })
  .strict();

export type ReviewPolicy = z.infer<typeof reviewPolicySchema>;

/** 解析来自用户或配置文件的审查策略；未知字段会报错，不会默默失效。 */
export function parseReviewPolicy(value: unknown = {}): ReviewPolicy {
  const parsed = reviewPolicySchema.safeParse(value); // 默认值只在这一处定义。
  if (!parsed.success) {
    const detail = parsed.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(`审查策略无效：${detail.join("；")}`);
  }
  return parsed.data;
}

/** 严重度顺序在策略内统一，报告和质量门禁从同一个来源取值。 */
export function severityRank(level: FindingSeverity): number {
  return findingSeverityLevels.length - findingSeverityLevels.indexOf(level);
}

/** 把可持久化的策略规范化为 JSON，避免调用方自行遗漏默认值。 */
export function serializeReviewPolicy(policy: ReviewPolicy): string {
  return JSON.stringify(policy, null, 2); // 保留字段顺序，方便人工检查差异。
}

/** 与默认策略逐项对照，说明用户实际改了什么。 */
export function describeReviewPolicy(
  policy: ReviewPolicy,
): readonly { field: string; value: unknown }[] {
  const defaults = parseReviewPolicy();
  return Object.entries(policy)
    .filter(
      ([field, value]) =>
        JSON.stringify(value) !==
        JSON.stringify(defaults[field as keyof ReviewPolicy]),
    )
    .map(([field, value]) => ({ field, value }));
}
