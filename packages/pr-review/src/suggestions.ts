/**
 * 修复建议：把明确的文本编辑绑定到源码 SHA-256，生成可审阅补丁并校验过期/重叠编辑。
 * 调用：const proposal = createReviewSuggestion({ title, edits }, snapshots);
 *       const preview = previewReviewSuggestion(proposal, snapshots);
 * 本模块不写磁盘、不执行命令；应用到 GitHub 或仓库由有权限的调用方决定。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { SourceSnapshot } from "./imports.js";
import { normalizeReviewPath } from "./utils/path.js";

const positionSchema = z
  .object({ line: z.number().int().min(1), column: z.number().int().min(1) })
  .strict();
const editSchema = z
  .object({
    path: z.string().min(1).max(500),
    start: positionSchema,
    end: positionSchema,
    expected: z.string().max(200_000),
    replacement: z.string().max(200_000),
  })
  .strict();
const inputSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    explanation: z.string().trim().min(1).max(4_000),
    findingFingerprints: z
      .array(z.string().regex(/^[a-f0-9]{64}$/u))
      .max(100)
      .default([]),
    edits: z.array(editSchema).min(1).max(500),
  })
  .strict();
const suggestionSchema = z
  .object({
    version: z.literal("review-suggestion/v1"),
    id: z.string().regex(/^[a-f0-9]{64}$/u),
    createdAt: z.string().datetime({ offset: true }),
    title: z.string().min(1).max(300),
    explanation: z.string().min(1).max(4_000),
    findingFingerprints: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(100),
    files: z
      .array(
        z
          .object({
            path: z.string(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .strict(),
      )
      .min(1)
      .max(500),
    edits: z.array(editSchema).min(1).max(500),
  })
  .strict();

export type ReviewEdit = z.infer<typeof editSchema>;
export type ReviewSuggestion = z.infer<typeof suggestionSchema>;
export type SuggestionPreview = {
  suggestionId: string;
  files: readonly {
    path: string;
    before: string;
    after: string;
    beforeSha256: string;
    afterSha256: string;
    edits: number;
  }[];
  changedFiles: number;
  changedEdits: number;
  patch: string;
};

/** 使用原始字节语义的 UTF-8 文本摘要；CRLF 和 LF 视为不同快照。 */
export function sourceFingerprint(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** 行列按编辑器常用的 1 起 UTF-16 位置；不允许把代理对切成半个字符。 */
function sourceOffset(
  content: string,
  position: { line: number; column: number },
): number {
  let line = 1;
  let offset = 0;
  while (line < position.line) {
    const newline = content.indexOf("\n", offset);
    if (newline < 0)
      throw new Error(`修复建议行号 ${position.line} 超出源码范围`);
    offset = newline + 1;
    line += 1;
  }
  let end = content.indexOf("\n", offset);
  if (end < 0) end = content.length;
  if (end > offset && content[end - 1] === "\r") end -= 1;
  const result = offset + position.column - 1;
  if (result > end)
    throw new Error(
      `修复建议第 ${position.line} 行列号 ${position.column} 超出源码范围`,
    );
  const current = content.charCodeAt(result);
  const previous = content.charCodeAt(result - 1);
  if (
    current >= 0xdc00 &&
    current <= 0xdfff &&
    previous >= 0xd800 &&
    previous <= 0xdbff
  )
    throw new Error("修复建议不能从 Unicode 字符的中间切开");
  return result;
}

/** 按来源路径建立单一快照表，重复路径或越界路径在边界直接拒绝。 */
function sourceMap(sources: readonly SourceSnapshot[]): Map<string, string> {
  const result = new Map<string, string>();
  if (
    sources.reduce(
      (sum, source) => sum + Buffer.byteLength(source.content),
      0,
    ) > 30_000_000
  )
    throw new Error("修复建议的源码快照总大小超过 30 MB");
  for (const source of sources) {
    const path = normalizeReviewPath(source.path);
    if (result.has(path)) throw new Error(`修复建议源码快照重复：${path}`);
    result.set(path, source.content);
  }
  return result;
}

/** 计算编辑边界并检查前置文本，排序后可从后往前直接应用。 */
function checkedEdits(
  path: string,
  content: string,
  edits: readonly ReviewEdit[],
): readonly { start: number; end: number; replacement: string }[] {
  const ranges = edits
    .map((edit) => {
      const start = sourceOffset(content, edit.start);
      const end = sourceOffset(content, edit.end);
      if (end < start)
        throw new Error(`修复建议的结束位置早于开始位置：${path}`);
      if (content.slice(start, end) !== edit.expected)
        throw new Error(
          `修复建议的前置文本与当前源码不一致：${path}:${edit.start.line}`,
        );
      if (edit.expected === edit.replacement)
        throw new Error(
          `修复建议包含不改变文本的编辑：${path}:${edit.start.line}`,
        );
      return { start, end, replacement: edit.replacement };
    })
    .sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1]!;
    const current = ranges[index]!;
    if (current.start < previous.end || current.start === previous.start)
      throw new Error(`修复建议包含重叠或同点的编辑：${path}`);
  }
  return ranges;
}

/** 把用户明确给出的编辑变成不可静默漂移的修复提案。 */
export function createReviewSuggestion(
  raw: unknown,
  sources: readonly SourceSnapshot[],
  now = new Date(),
): ReviewSuggestion {
  const input = inputSchema.safeParse(raw);
  if (!input.success)
    throw new Error(
      `修复建议无效：${input.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("；")}`,
    );
  const snapshots = sourceMap(sources);
  const edits = input.data.edits.map((edit) => ({
    ...edit,
    path: normalizeReviewPath(edit.path),
  }));
  const paths = [...new Set(edits.map((edit) => edit.path))].sort();
  const files = paths.map((path) => {
    const content = snapshots.get(path);
    if (content === undefined)
      throw new Error(`修复建议没有对应的源码快照：${path}`);
    checkedEdits(
      path,
      content,
      edits.filter((edit) => edit.path === path),
    );
    return { path, sha256: sourceFingerprint(content) };
  });
  const identity = JSON.stringify({ title: input.data.title, files, edits });
  return {
    version: "review-suggestion/v1",
    id: sourceFingerprint(identity),
    createdAt: now.toISOString(),
    title: input.data.title,
    explanation: input.data.explanation,
    findingFingerprints: input.data.findingFingerprints,
    files,
    edits,
  };
}

/** 从外部恢复提案时验证摘要，避免 ID 不变但编辑内容已经被替换。 */
export function parseReviewSuggestion(raw: unknown): ReviewSuggestion {
  const result = suggestionSchema.safeParse(raw);
  if (!result.success)
    throw new Error("修复建议记录不符合 review-suggestion/v1");
  const suggestion = result.data;
  const expected = sourceFingerprint(
    JSON.stringify({
      title: suggestion.title,
      files: suggestion.files,
      edits: suggestion.edits,
    }),
  );
  if (suggestion.id !== expected)
    throw new Error("修复建议内容与提案 ID 不一致");
  for (const file of suggestion.files) normalizeReviewPath(file.path);
  const paths = new Set(suggestion.files.map((file) => file.path));
  if (paths.size !== suggestion.files.length)
    throw new Error("修复建议包含重复文件快照");
  if (
    suggestion.edits.some((edit) => !paths.has(normalizeReviewPath(edit.path)))
  )
    throw new Error("修复建议编辑了未声明的文件");
  return suggestion;
}

/** 仅生成内存中的前后文本和补丁；任何文件变动都会让过期提案失败。 */
export function previewReviewSuggestion(
  suggestion: ReviewSuggestion,
  sources: readonly SourceSnapshot[],
): SuggestionPreview {
  const snapshots = sourceMap(sources);
  const files: SuggestionPreview["files"][number][] = [];
  for (const file of suggestion.files) {
    const before = snapshots.get(file.path);
    if (before === undefined)
      throw new Error(`无法预览修复建议，缺少源码：${file.path}`);
    if (sourceFingerprint(before) !== file.sha256)
      throw new Error(`修复建议已经过期，源码发生变化：${file.path}`);
    const edits = suggestion.edits.filter((edit) => edit.path === file.path);
    const ranges = checkedEdits(file.path, before, edits);
    let after = before;
    for (const range of [...ranges].reverse())
      after =
        after.slice(0, range.start) +
        range.replacement +
        after.slice(range.end);
    files.push({
      path: file.path,
      before,
      after,
      beforeSha256: file.sha256,
      afterSha256: sourceFingerprint(after),
      edits: edits.length,
    });
  }
  return {
    suggestionId: suggestion.id,
    files,
    changedFiles: files.length,
    changedEdits: suggestion.edits.length,
    patch: files
      .map((file) => renderSuggestionPatch(file.path, file.before, file.after))
      .join(""),
  };
}

/** 保留整份文件作为补丁上下文，优先可核对和精确应用；超大文件应由调用方另行处理。 */
function renderSuggestionPatch(
  path: string,
  before: string,
  after: string,
): string {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  if (oldLines.at(-1) === "") oldLines.pop();
  if (newLines.at(-1) === "") newLines.pop();
  // 使用 Git 的 C 风格路径引号，文件名中的空格、引号不会变成补丁结构。
  const oldPath = JSON.stringify(`a/${path}`);
  const newPath = JSON.stringify(`b/${path}`);
  const lines = [
    `diff --git ${oldPath} ${newPath}`,
    `--- ${oldPath}`,
    `+++ ${newPath}`,
    `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@`,
  ];
  for (let index = 0; index < oldLines.length; index += 1) {
    lines.push(`-${oldLines[index]}`);
    if (index === oldLines.length - 1 && !before.endsWith("\n"))
      lines.push("\\ No newline at end of file");
  }
  for (let index = 0; index < newLines.length; index += 1) {
    lines.push(`+${newLines[index]}`);
    if (index === newLines.length - 1 && !after.endsWith("\n"))
      lines.push("\\ No newline at end of file");
  }
  return lines.join("\n") + "\n";
}
