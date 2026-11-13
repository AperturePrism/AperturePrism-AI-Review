/**
 * 上下文覆盖：解释本次模型能看到哪些变更，避免“没发现问题”等于“全部已检查”。
 * 调用：const coverage = measureReviewCoverage(renderedContext);
 * 这是输入覆盖，不证明模型逐行理解；预读原文另列，不夸大为完整变更审查。
 */
import {
  DEFAULT_PR_REVIEW_BUDGET,
  truncateDiffLines,
  type PrReviewBudget,
  type RenderedPrContext,
} from "./context.js";
import type { DiffFile, DiffLine } from "./diff.js";

export type FileCoverage = {
  path: string;
  totalChangedLines: number;
  visibleChangedLines: number;
  visibleTextLines: number;
  totalTextLines: number;
  ratio: number;
  state: "complete" | "partial" | "listed_only" | "binary" | "empty";
  preloaded: boolean;
};
export type ReviewCoverage = {
  scope: "model_input";
  totalFiles: number;
  completeFiles: number;
  partialFiles: number;
  unreadFiles: number;
  binaryFiles: number;
  totalChangedLines: number;
  visibleChangedLines: number;
  changedLineRatio: number;
  fileRatio: number;
  files: readonly FileCoverage[];
  limitations: readonly string[];
};

/** 文件截断规则与 renderHunksText 共用，覆盖统计不会另造一套范围。 */
export function visibleDiffLines(
  file: DiffFile,
  budget: PrReviewBudget,
): readonly DiffLine[] {
  return truncateDiffLines(
    file.hunks?.flatMap((hunk) => hunk.lines) ?? [],
    budget.maxLinesPerFile,
  );
}

/** 统计实际进入提示词的 diff 行，二进制文件单列，不被当作已读。 */
export function measureReviewCoverage(
  context: RenderedPrContext,
  budget: PrReviewBudget = context.renderBudget ?? DEFAULT_PR_REVIEW_BUDGET,
): ReviewCoverage {
  const kept = new Map(context.keptFiles.map((file) => [file.newPath, file]));
  const files = context.diff.files.map((file): FileCoverage => {
    const visible = kept.get(file.newPath);
    const visibleLines = visible
      ? (context.visibleLines?.[file.newPath] ??
        visibleDiffLines(visible, budget))
      : [];
    const totalTextLines =
      file.hunks?.reduce((sum, hunk) => sum + hunk.lines.length, 0) ?? 0;
    const totalChangedLines = file.additions + file.deletions;
    const visibleChangedLines = visibleLines.filter(
      (line) => line.kind !== "context",
    ).length;
    const state: FileCoverage["state"] =
      file.hunks === null
        ? "binary"
        : totalTextLines === 0
          ? "empty"
          : !visible
            ? "listed_only"
            : visibleLines.length >= totalTextLines
              ? "complete"
              : "partial";
    return {
      path: file.newPath,
      totalChangedLines,
      visibleChangedLines,
      visibleTextLines: visibleLines.length,
      totalTextLines,
      ratio:
        totalChangedLines > 0
          ? Math.min(1, visibleChangedLines / totalChangedLines)
          : state === "complete" || state === "empty"
            ? 1
            : 0,
      state,
      preloaded:
        context.preloadedFiles?.some((entry) => entry.path === file.newPath) ??
        false,
    };
  });
  const textFiles = files.filter((file) => file.state !== "binary");
  const totalChangedLines = textFiles.reduce(
    (sum, file) => sum + file.totalChangedLines,
    0,
  );
  const visibleChangedLines = textFiles.reduce(
    (sum, file) => sum + file.visibleChangedLines,
    0,
  );
  const completeFiles = files.filter(
    (file) => file.state === "complete" || file.state === "empty",
  ).length;
  const partialFiles = files.filter((file) => file.state === "partial").length;
  const unreadFiles = files.filter(
    (file) => file.state === "listed_only",
  ).length;
  const binaryFiles = files.filter((file) => file.state === "binary").length;
  const limitations = [...context.degraded];
  if (binaryFiles) limitations.push("binary_files_require_separate_review");
  if (unreadFiles) limitations.push("listed_only_files_not_reviewed");
  if (partialFiles) limitations.push("truncated_files_not_fully_reviewed");
  return {
    scope: "model_input",
    totalFiles: files.length,
    completeFiles,
    partialFiles,
    unreadFiles,
    binaryFiles,
    totalChangedLines,
    visibleChangedLines,
    changedLineRatio: totalChangedLines
      ? Math.min(1, visibleChangedLines / totalChangedLines)
      : 1,
    fileRatio: textFiles.length ? completeFiles / textFiles.length : 1,
    files,
    limitations: [...new Set(limitations)],
  };
}
