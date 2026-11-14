/**
 * 模型输出契约：所有外部模型返回在这里校验，保留 v1 字段兼容已有消费者。
 * 调用：prReviewContractSchema.safeParse(JSON.parse(modelText))。
 */
import { z } from "zod";
import { containsControlCharacters } from "./utils/path.js";

/** Severity describes impact. The server policy re-checks it before publish. */
export const findingSeverityLevels = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as const;

export type FindingSeverity = (typeof findingSeverityLevels)[number];

export const findingSchema = z
  .object({
    /** Stable rule identifier so the same issue can be deduplicated, e.g. `missing-null-check`. */
    rule: z.string().min(1).max(120),
    severity: z.enum(findingSeverityLevels),
    /** New-file path the finding attaches to. */
    file: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine((value) => {
        const path = value.replaceAll("\\", "/");
        return (
          !path.startsWith("/") &&
          !/^[a-z]:/iu.test(path) &&
          !path.split("/").includes("..") &&
          !containsControlCharacters(path)
        );
      }, "文件必须是仓库内的相对路径"),
    message: z.string().min(1).max(2_000),
    /** Verbatim excerpt from the diff so a human can verify the claim. */
    evidence: z.string().min(1).max(2_000),
    impact: z.string().min(1).max(2_000),
    confidence: z.number().min(0).max(1),
    suggestion: z.string().min(1).max(2_000),
    /** After (new file) 1-based line the finding anchors to; 0 when unknown. */
    afterLine: z.number().int().min(0),
  })
  .strict();

export type Finding = z.infer<typeof findingSchema>;

export const overallToneLevels = [
  "approve",
  "changes_requested",
  "comment",
] as const;

export type OverallTone = (typeof overallToneLevels)[number];

/**
 * The structured PR review contract. It must be JSON and strict: the model is
 * not allowed to smuggle in extra fields that a board would later have to
 * ignore silently.
 */
export const prReviewContractSchema = z
  .object({
    contractVersion: z.literal("pr-review/v1"),
    summary: z.string().min(1).max(3_000),
    changedFileCount: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    overallTone: z.enum(overallToneLevels),
    findings: z.array(findingSchema).max(50).default([]),
  })
  .strict();

export type PrReviewContract = z.infer<typeof prReviewContractSchema>;
