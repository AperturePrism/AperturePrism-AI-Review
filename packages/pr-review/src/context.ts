import type { ParsedDiff, DiffFile, DiffHunk } from "./diff.js";

/** A parsed file that actually has text hunks (not binary, not empty). */
type TextDiffFile = DiffFile & { hunks: readonly DiffHunk[] };

export type PrSize = "small" | "medium" | "large" | "oversized";

/** Coarse size buckets used only to pick a degradation strategy. */
export function classifyPrSize(
  fileCount: number,
  additions: number,
  deletions: number,
): PrSize {
  const churn = additions + deletions;
  if (fileCount > 40 || churn > 5_000) return "oversized";
  if (fileCount > 20 || churn > 1_500) return "large";
  if (churn > 200) return "medium";
  return "small";
}

/** Adaptive review strategy: small PRs review fast, large ones go deep. */
export type ReviewMode = "quick" | "standard" | "deep";

/**
 * Picks the review strategy from PR size. Small PRs → quick (fewer findings,
 * terse summary); large/oversized → deep (key-path focus, may use tools);
 * anything else stays standard.
 */
export function selectReviewMode(rendered: RenderedPrContext): ReviewMode {
  const size = classifyPrSize(
    rendered.diff.files.length,
    rendered.diff.additions,
    rendered.diff.deletions,
  );
  if (size === "small") return "quick";
  if (size === "large" || size === "oversized") return "deep";
  return "standard";
}

export type PrReviewBudget = {
  /** Rough token ceiling for the rendered diff portion of the prompt. */
  maxTokens: number;
  /** Max files whose hunks are inlined; the rest are listed as names only. */
  maxInlineFiles: number;
  /** Max text lines kept per file (head + tail) to bound a single big diff. */
  maxLinesPerFile: number;
};

export const DEFAULT_PR_REVIEW_BUDGET: PrReviewBudget = {
  maxTokens: 12_000,
  maxInlineFiles: 25,
  maxLinesPerFile: 400,
};

export type RenderedPrContext = {
  diff: ParsedDiff;
  /** Budget retained for the later prompt-rendering step. */
  budget?: PrReviewBudget;
  keptFiles: readonly DiffFile[];
  /** Files mentioned by name only because they were not inlined. */
  listedFiles: readonly string[];
  /** Why the context was reduced, surfaced to the prompt so it stays honest. */
  degraded: readonly string[];
  /** Consolidated repo memory (rules/knowledge), rendered as reference text. */
  repoMemory?: string;
  /** 仓库 `.apertureprism/rules/` 目录下的审核规则（Sakura 式专属文件夹）。 */
  repoRules?: string;
  /** 变更文件原文（预读注入，供模型直接确认逻辑，无需依赖 read_file）。 */
  preloadedFiles?: readonly { path: string; content: string }[];
};

/**
 * Keeps the diff inside the token budget. Files beyond `maxInlineFiles` (by
 * churn) are reduced to their path names; individual files beyond
 * `maxLinesPerFile` are kept head+tail instead of a meaningless middle slice.
 * Binary files are never inlined. A large PR is never silently dropped to
 * nothing — it always degrades to a documented, reviewable subset.
 */
export function renderDiffForModel(
  diff: ParsedDiff,
  budget: PrReviewBudget = DEFAULT_PR_REVIEW_BUDGET,
): RenderedPrContext {
  const degraded: string[] = [];
  const textFiles: TextDiffFile[] = diff.files.filter(
    (f): f is TextDiffFile => f.hunks !== null && f.hunks.length > 0,
  );

  const byChurn = [...textFiles].sort(
    (a, b) =>
      b.additions + b.deletions - (a.additions + a.deletions),
  );

  const keptFiles: TextDiffFile[] = [];
  const listedFiles: string[] = [];

  for (const file of byChurn) {
    if (keptFiles.length < budget.maxInlineFiles) {
      keptFiles.push(file);
    } else {
      listedFiles.push(file.newPath);
    }
  }

  for (const file of diff.files) {
    if (!file.hunks || file.hunks.length === 0) {
      listedFiles.push(file.newPath);
    }
  }

  if (listedFiles.length > 0) degraded.push("some_files_listed_only");

  const limit = budget.maxLinesPerFile;
  const trimmed = keptFiles.map((file) => ({
    file,
    totalLines: file.hunks.reduce((sum, h) => sum + h.lines.length, 0),
  }));

  let kept = true;
  for (const entry of trimmed) {
    if (entry.totalLines > limit) {
      kept = false;
      break;
    }
  }
  if (!kept) degraded.push("large_file_head_tail_only");

  // Deduplicate listed files that also appear in keptFiles (defensive).
  const listed = [...new Set(listedFiles)];
  const context = { diff, keptFiles, listedFiles: listed, degraded, budget: { ...budget } };
  if (renderUnboundedHunksText(context, budget).length > budget.maxTokens * 4) {
    degraded.push("token_budget_exceeded");
  }
  return context;
}

/**
 * Renders the diff inside the rough token ceiling (four characters per token,
 * matching issue-analysis). Whole trailing lines are dropped when necessary;
 * the marker makes omitted context explicit and code fences remain balanced.
 */
export function renderHunksText(
  context: RenderedPrContext,
  budget: PrReviewBudget = context.budget ?? DEFAULT_PR_REVIEW_BUDGET,
): string {
  const text = renderUnboundedHunksText(context, budget);
  const maxChars = Math.max(0, Math.floor(budget.maxTokens * 4));
  if (text.length <= maxChars) return text;
  const marker = "\n\n注意：diff 已降级：token_budget_exceeded。";
  if (maxChars < marker.length + 4) return marker.trim().slice(0, maxChars);
  const prefix = text.slice(0, maxChars - marker.length - 4);
  const lastNewline = prefix.lastIndexOf("\n");
  const kept = lastNewline < 0 ? "" : prefix.slice(0, lastNewline);
  const openFence = kept.split("\n").filter((line) => line === "```").length % 2;
  return kept + (openFence ? "\n```" : "") + marker;
}

function renderUnboundedHunksText(
  context: RenderedPrContext,
  budget: PrReviewBudget,
): string {
  const chunks: string[] = [];
  for (const file of context.keptFiles) {
    if (!file.hunks) continue;
    const lines = file.hunks.flatMap((hunk) =>
      hunk.lines.map((entry) => `${entry.kind === "add" ? "+" : entry.kind === "delete" ? "-" : " "}${entry.text}`),
    );
    const body =
      lines.length > budget.maxLinesPerFile
        ? [...lines.slice(0, Math.floor(budget.maxLinesPerFile / 2)), "…", ...lines.slice(-Math.floor(budget.maxLinesPerFile / 2))].join("\n")
        : lines.join("\n");
    chunks.push(`### ${file.newPath}\n\`\`\`\n${body}\n\`\`\``);
  }
  if (context.listedFiles.length > 0) {
    chunks.push(`其他变更文件（仅列出）:\n${context.listedFiles.map((p) => `- ${p}`).join("\n")}`);
  }
  if (context.degraded.length > 0) {
    chunks.push(`注意：diff 已降级：${context.degraded.join("、")}。`);
  }
  return chunks.join("\n\n");
}