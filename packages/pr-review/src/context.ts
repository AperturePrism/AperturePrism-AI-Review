/**
 * 模型上下文：把变更压进明确预算，并记录实际可见行供覆盖报告使用。
 * 调用：const context = renderDiffForModel(parseUnifiedDiff(diff));
 * maxTokens 是字符估算预算，真实请求仍应预留系统提示词和模型输出空间。
 */
import type { ParsedDiff, DiffFile, DiffHunk, DiffLine } from "./diff.js";
import { estimateReviewTokens, renderNumberedDiffLine } from "./plan.js";

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
  /** 记录实际渲染预算，报告使用同一份范围计算覆盖。 */
  renderBudget?: PrReviewBudget;
  /** 真正进入提示词的行，避免覆盖报告把截断部分误算为已读。 */
  visibleLines?: Readonly<Record<string, readonly DiffLine[]>>;
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
  if (
    ![budget.maxTokens, budget.maxInlineFiles, budget.maxLinesPerFile].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  ) {
    throw new Error("审查上下文预算必须是非负整数");
  }
  const degraded: string[] = [];
  const textFiles: TextDiffFile[] = diff.files.filter(
    (file): file is TextDiffFile =>
      file.hunks !== null && file.hunks.length > 0,
  );
  const byChurn = [...textFiles].sort(
    (left, right) =>
      right.additions + right.deletions - left.additions - left.deletions,
  );
  const keptFiles: TextDiffFile[] = [];
  const listedFiles: string[] = [];
  const visibleLines: Record<string, readonly DiffLine[]> = Object.create(
    null,
  ) as Record<string, readonly DiffLine[]>;
  let remaining = budget.maxTokens;
  for (const file of byChurn) {
    if (keptFiles.length >= budget.maxInlineFiles) {
      listedFiles.push(file.newPath);
      continue;
    }
    const allLines = file.hunks.flatMap((hunk) => hunk.lines);
    const candidates = truncateDiffLines(allLines, budget.maxLinesPerFile);
    if (candidates.length < allLines.length)
      degraded.push("large_file_head_tail_only");
    const selected: DiffLine[] = [];
    let tokens = estimateReviewTokens(`### ${file.newPath}\n\n`);
    for (const line of candidates) {
      const cost = estimateReviewTokens(renderNumberedDiffLine(line) + "\n");
      if (tokens + cost > remaining) break;
      selected.push(line);
      tokens += cost;
    }
    if (selected.length < candidates.length)
      degraded.push("diff_token_budget_reached");
    if (!selected.length) {
      listedFiles.push(file.newPath);
      continue;
    }
    keptFiles.push(file);
    visibleLines[file.newPath] = selected;
    remaining -= tokens;
  }
  for (const file of diff.files) {
    if (!file.hunks || file.hunks.length === 0) listedFiles.push(file.newPath);
  }
  if (listedFiles.length) degraded.push("some_files_listed_only");
  return {
    diff,
    renderBudget: { ...budget },
    visibleLines,
    keptFiles,
    listedFiles: [...new Set(listedFiles)],
    degraded: [...new Set(degraded)],
  };
}

/** Renders the kept hunks for the prompt, truncated per file head+tail. */
export function renderHunksText(
  context: RenderedPrContext,
  budget: PrReviewBudget = DEFAULT_PR_REVIEW_BUDGET,
): string {
  const chunks: string[] = [];
  const actualBudget = context.renderBudget ?? budget;
  for (const file of context.keptFiles) {
    if (!file.hunks) continue;
    const lines =
      context.visibleLines?.[file.newPath] ??
      truncateDiffLines(
        file.hunks.flatMap((hunk) => hunk.lines),
        actualBudget.maxLinesPerFile,
      );
    const body = lines.map(renderNumberedDiffLine).join("\n");
    // 行号保留真实 afterLine，分块中间的空缺不会被误认成连续源码。
    chunks.push(`### ${file.newPath}\n${body}`);
  }
  if (context.listedFiles.length > 0) {
    chunks.push(
      `其他变更文件（仅列出）:\n${context.listedFiles.map((p) => `- ${p}`).join("\n")}`,
    );
  }
  if (context.degraded.length > 0) {
    chunks.push(`注意：diff 已降级：${context.degraded.join("、")}。`);
  }
  return chunks.join("\n\n");
}

/** 按首尾保留完整行；预算不足两行时只保留开头，避免 slice(-0) 复制整份内容。 */
export function truncateDiffLines(
  lines: readonly DiffLine[],
  limit: number,
): readonly DiffLine[] {
  if (lines.length <= limit) return lines;
  if (limit === 0) return [];
  const head = Math.ceil(limit / 2);
  const tail = Math.floor(limit / 2);
  return [...lines.slice(0, head), ...(tail > 0 ? lines.slice(-tail) : [])];
}
