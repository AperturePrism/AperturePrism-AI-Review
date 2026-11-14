/**
 * 分批审查计划：风险高的文件先读，按文件/行预算切块，并明确哪些内容没读到。
 * 调用：const plan = buildReviewPlan(diff, policy); plan.chunks 每项可交给一个审查任务。
 * token 数是字符估算，不冒充具体 tokenizer 的精确结果。
 */
import type { DiffFile, DiffHunk, DiffLine, ParsedDiff } from "./diff.js";
import type { ReviewPolicy } from "./policy.js";
import { assessFileRisk } from "./risk.js";
import { matchPath } from "./utils/path.js";

export type PlannedFile = {
  path: string;
  risk: number;
  changedLines: number;
  disposition: "included" | "excluded" | "binary" | "generated" | "empty";
  reason: string;
};
export type ReviewChunk = {
  id: string;
  files: readonly string[];
  estimatedTokens: number;
  changedLines: number;
  text: string;
  segments: readonly {
    path: string;
    startLine: number;
    endLine: number;
    additions: number;
    deletions: number;
  }[];
};
export type ReviewPlan = {
  version: "review-plan/v1";
  files: readonly PlannedFile[];
  chunks: readonly ReviewChunk[];
  includedChangedLines: number;
  excludedChangedLines: number;
  estimatedTokens: number;
  warnings: readonly string[];
};

/** 中英文混合源码用字符估算预算；调用方应在真实模型请求时保留其上下文余量。 */
export function estimateReviewTokens(text: string): number {
  let units = 0;
  for (const char of text) units += char.codePointAt(0)! > 0x7f ? 1 : 0.3;
  return Math.ceil(units);
}

/** 把 diff 行渲染成带新文件行号的文本，模型可以直接引用正确 afterLine。 */
export function renderNumberedDiffLine(line: DiffLine): string {
  const sign = line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " ";
  return `${sign}${line.afterLine > 0 ? line.afterLine : "-"}| ${line.text}`;
}

/** 按整行切开过大的 hunk，不截断 UTF-16 字符或单行证据。 */
function splitHunk(
  file: DiffFile,
  hunk: DiffHunk,
  tokenLimit: number,
): ReviewChunk[] {
  const prefix = `### ${file.newPath}\n`;
  const chunks: ReviewChunk[] = [];
  let lines: DiffLine[] = [];
  let tokens = estimateReviewTokens(prefix);
  const finish = () => {
    if (!lines.length) return;
    const additions = lines.filter((line) => line.kind === "add").length;
    const deletions = lines.filter((line) => line.kind === "delete").length;
    const afterLines = lines
      .filter((line) => line.afterLine > 0)
      .map((line) => line.afterLine);
    const text = `${prefix}${lines.map(renderNumberedDiffLine).join("\n")}`;
    chunks.push({
      id: "",
      files: [file.newPath],
      estimatedTokens: estimateReviewTokens(text),
      changedLines: additions + deletions,
      text,
      segments: [
        {
          path: file.newPath,
          startLine: afterLines[0] ?? 0,
          endLine: afterLines.at(-1) ?? 0,
          additions,
          deletions,
        },
      ],
    });
    lines = [];
    tokens = estimateReviewTokens(prefix);
  };
  for (const line of hunk.lines) {
    const lineTokens = estimateReviewTokens(
      renderNumberedDiffLine(line) + "\n",
    );
    if (lines.length && tokens + lineTokens > tokenLimit) finish();
    lines.push(line);
    tokens += lineTokens;
  }
  finish();
  return chunks;
}

/** 计划只表示需要读取的内容，不把它当作模型已完成的审查覆盖。 */
export function buildReviewPlan(
  diff: ParsedDiff,
  policy: ReviewPolicy,
): ReviewPlan {
  const files: PlannedFile[] = [];
  const segments: ReviewChunk[] = [];
  const warnings: string[] = [];
  let includedChangedLines = 0;
  let excludedChangedLines = 0;
  const prioritized = [...diff.files].sort(
    (left, right) =>
      assessFileRisk(right, policy).score - assessFileRisk(left, policy).score,
  );
  for (const file of prioritized) {
    const risk = assessFileRisk(file, policy);
    const path = risk.path;
    const changedLines = file.additions + file.deletions;
    const outsideInclude =
      policy.include.length > 0 &&
      !policy.include.some((pattern) => matchPath(pattern, path));
    const excluded = policy.exclude.some((pattern) => matchPath(pattern, path));
    const disposition: PlannedFile["disposition"] =
      outsideInclude || excluded
        ? "excluded"
        : risk.kind === "generated"
          ? "generated"
          : file.hunks === null
            ? "binary"
            : !file.hunks.length
              ? "empty"
              : "included";
    const reason =
      disposition === "excluded"
        ? "审查策略排除了此路径"
        : disposition === "generated"
          ? "生成文件保留清单，但不重复审查生成结果"
          : disposition === "binary"
            ? "二进制变更没有可供模型读取的文本"
            : disposition === "empty"
              ? "diff 中没有文本块"
              : "纳入分批审查";
    files.push({ path, risk: risk.score, changedLines, disposition, reason });
    if (disposition !== "included") {
      excludedChangedLines += changedLines;
      continue;
    }
    includedChangedLines += changedLines;
    for (const hunk of file.hunks ?? [])
      segments.push(...splitHunk(file, hunk, policy.maxChunkTokens));
  }
  const chunks: ReviewChunk[] = [];
  for (const segment of segments) {
    const last = chunks.at(-1);
    const paths = new Set([...(last?.files ?? []), ...segment.files]);
    if (
      last &&
      last.estimatedTokens + segment.estimatedTokens + 1 <=
        policy.maxChunkTokens &&
      paths.size <= policy.maxChunkFiles
    ) {
      chunks[chunks.length - 1] = {
        ...last,
        files: [...paths],
        text: `${last.text}\n\n${segment.text}`,
        estimatedTokens: last.estimatedTokens + segment.estimatedTokens + 1,
        changedLines: last.changedLines + segment.changedLines,
        segments: [...last.segments, ...segment.segments],
      };
    } else {
      chunks.push({ ...segment, id: `chunk-${chunks.length + 1}` });
    }
    if (segment.estimatedTokens > policy.maxChunkTokens) {
      warnings.push(
        `文件 ${segment.files[0]} 中有单行内容超过 token 预算，需另行截断或专门审查`,
      );
    }
  }
  if (files.some((file) => file.disposition === "binary"))
    warnings.push("二进制文件需要人工或专门工具检查");
  return {
    version: "review-plan/v1",
    files,
    chunks,
    includedChangedLines,
    excludedChangedLines,
    estimatedTokens: chunks.reduce(
      (sum, chunk) => sum + chunk.estimatedTokens,
      0,
    ),
    warnings: [...new Set(warnings)],
  };
}

/** 对完成批次取并集，重复上报同一批次不会虚增覆盖行数。 */
export function completedPlanCoverage(
  plan: ReviewPlan,
  completedChunkIds: readonly string[],
): {
  completedChunks: number;
  totalChunks: number;
  completedChangedLines: number;
  totalChangedLines: number;
  ratio: number;
  pendingChunkIds: readonly string[];
} {
  const completed = new Set(completedChunkIds);
  const completedChunks = plan.chunks.filter((chunk) =>
    completed.has(chunk.id),
  );
  const completedChangedLines = completedChunks.reduce(
    (sum, chunk) => sum + chunk.changedLines,
    0,
  );
  return {
    completedChunks: completedChunks.length,
    totalChunks: plan.chunks.length,
    completedChangedLines,
    totalChangedLines: plan.includedChangedLines,
    ratio:
      plan.includedChangedLines === 0
        ? 1
        : completedChangedLines / plan.includedChangedLines,
    pendingChunkIds: plan.chunks
      .filter((chunk) => !completed.has(chunk.id))
      .map((chunk) => chunk.id),
  };
}
