/**
 * 人工标签数据集：JSONL 校验、稳定版本与跨划分泄漏检查只在此处实现。
 * @example
 * const dataset = parseDatasetJsonl(text, { id: "pr-review-v1" });
 * const leakage = inspectDatasetLeakage(dataset);
 *
 * 一行一个案例；input 是原始 diff/上下文，expected 是人工确认的正例或已知误报。
 * 数据集本身不会发送到网络，所有评估都只比较已有预测文件。
 */
import { createHash } from "node:crypto";

export const EVALUATION_SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as const;
export type EvaluationSeverity = (typeof EVALUATION_SEVERITIES)[number];
export type DatasetSplit = "train" | "validation" | "test";

export type ExpectedFinding = {
  id: string;
  ruleId: string;
  path: string;
  startLine: number;
  endLine: number;
  severity: EvaluationSeverity;
  label: "positive" | "negative";
};

export type ReviewCase = {
  version: 1;
  id: string;
  repository: string;
  revision: string;
  split: DatasetSplit;
  input: string;
  expected: ExpectedFinding[];
  /** 标签不参与输入指纹，防止同一 diff 换一组标签就绕过泄漏检测。 */
  inputHash: string;
};

export type ReviewDataset = {
  id: string;
  version: 1;
  hash: string;
  cases: ReviewCase[];
};

export type JsonlLimits = {
  maxBytes?: number;
  maxLineBytes?: number;
  maxRecords?: number;
  maxFindingsPerCase?: number;
};

export class EvaluationInputError extends Error {
  readonly line: number | null;
  readonly field: string | null;
  constructor(
    message: string,
    options: { line?: number; field?: string } = {},
  ) {
    super(
      `${options.line ? `line ${options.line}: ` : ""}${options.field ? `${options.field}: ` : ""}${message}`,
    );
    this.name = "EvaluationInputError";
    this.line = options.line ?? null;
    this.field = options.field ?? null;
  }
}

/** 用 Unicode 码位排序，版本哈希与固定 seed 比较不依赖机器的系统语言。 */
export function compareEvaluationText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 版本指纹按规范化数据计算，不受对象属性顺序、JSON 缩进或换行风格影响。 */
export function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .filter(([, nested]) => nested !== undefined)
          .sort(([left], [right]) => compareEvaluationText(left, right))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    return item;
  };
  return JSON.stringify(normalize(value));
}

export function evaluationHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** 外部 JSONL 的共同边界；错误只给行号，不把完整 diff 写到诊断中。 */
export function parseJsonl(
  text: string,
  limits: JsonlLimits = {},
): { value: unknown; line: number }[] {
  const maxBytes = limits.maxBytes ?? 64 * 1_048_576;
  const maxLineBytes = limits.maxLineBytes ?? 2 * 1_048_576;
  const maxRecords = limits.maxRecords ?? 20_000;
  for (const [name, value] of Object.entries({
    maxBytes,
    maxLineBytes,
    maxRecords,
  }))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError(`${name} must be a positive integer`);
  if (Buffer.byteLength(text) > maxBytes)
    throw new EvaluationInputError("JSONL exceeds its byte limit");
  const result: { value: unknown; line: number }[] = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const source = lines[index]!;
    if (!source.trim()) continue;
    const line = index + 1;
    if (Buffer.byteLength(source) > maxLineBytes)
      throw new EvaluationInputError("record exceeds its byte limit", { line });
    if (result.length >= maxRecords)
      throw new EvaluationInputError("too many records", { line });
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw new EvaluationInputError("record is not valid JSON", { line });
    }
    result.push({ value, line });
  }
  return result;
}

/** 仅用于外部格式边界，其余业务方法接收已校验的数据。 */
export function inputObject(
  value: unknown,
  line?: number,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new EvaluationInputError(
      "record must be an object",
      line ? { line } : {},
    );
  return value as Record<string, unknown>;
}

export function inputText(
  value: unknown,
  field: string,
  maxLength = 500,
  line?: number,
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maxLength ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new EvaluationInputError(
      `must be non-empty text of at most ${maxLength} characters`,
      { field, ...(line ? { line } : {}) },
    );
  return value.trim();
}

export function inputCount(
  value: unknown,
  field: string,
  line?: number,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new EvaluationInputError("must be a non-negative safe integer", {
      field,
      ...(line ? { line } : {}),
    });
  return value;
}

export function inputSeverity(
  value: unknown,
  line?: number,
): EvaluationSeverity {
  if (!(EVALUATION_SEVERITIES as readonly unknown[]).includes(value))
    throw new EvaluationInputError("unknown severity", {
      field: "severity",
      ...(line ? { line } : {}),
    });
  return value as EvaluationSeverity;
}

/** Git 路径只允许仓库内相对路径；统一 Windows 分隔符，拒绝逃出仓库的路径。 */
export function findingPath(value: unknown, line?: number): string {
  const path = inputText(value, "path", 1_024, line).replace(/\\/g, "/");
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((part) => part === ".." || part === "")
  )
    throw new EvaluationInputError("must be a repository-relative path", {
      field: "path",
      ...(line ? { line } : {}),
    });
  const normalized = path
    .split("/")
    .filter((part) => part !== ".")
    .join("/");
  if (!normalized)
    throw new EvaluationInputError("path must name a file", {
      field: "path",
      ...(line ? { line } : {}),
    });
  return normalized;
}

/** 便于扩展字段时直接告诉接手者拼错了哪里，而非悄悄忽略。 */
export function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  line?: number,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown)
    throw new EvaluationInputError("unknown field", {
      field: unknown,
      ...(line ? { line } : {}),
    });
}

function expectedFinding(value: unknown, line: number): ExpectedFinding {
  const item = inputObject(value, line);
  rejectUnknownFields(
    item,
    ["id", "ruleId", "path", "startLine", "endLine", "severity", "label"],
    line,
  );
  const startLine = inputCount(item.startLine, "startLine", line);
  const endLine = inputCount(item.endLine ?? startLine, "endLine", line);
  if (startLine < 1 || endLine < startLine)
    throw new EvaluationInputError(
      "line range must start at 1 and end after its start",
      { line },
    );
  if (item.label !== "positive" && item.label !== "negative")
    throw new EvaluationInputError("label must be positive or negative", {
      line,
    });
  return {
    id: inputText(item.id, "finding.id", 128, line),
    ruleId: inputText(item.ruleId, "ruleId", 200, line),
    path: findingPath(item.path, line),
    startLine,
    endLine,
    severity: inputSeverity(item.severity, line),
    label: item.label,
  };
}

/** 读取人工标签并给整个版本计算稳定哈希。案例顺序不改变版本，内容或标签变化会改变。 */
export function parseDatasetJsonl(
  text: string,
  options: JsonlLimits & { id: string },
): ReviewDataset {
  const id = inputText(options.id, "dataset.id", 128);
  const records = parseJsonl(text, options);
  if (!records.length)
    throw new EvaluationInputError("dataset must contain at least one case");
  const seen = new Set<string>();
  const cases = records.map(({ value, line }): ReviewCase => {
    const item = inputObject(value, line);
    rejectUnknownFields(
      item,
      ["version", "id", "repository", "revision", "split", "input", "expected"],
      line,
    );
    if (item.version !== 1)
      throw new EvaluationInputError("unsupported dataset version", {
        line,
        field: "version",
      });
    const caseId = inputText(item.id, "case.id", 128, line);
    if (seen.has(caseId))
      throw new EvaluationInputError("duplicate case id", {
        line,
        field: "id",
      });
    seen.add(caseId);
    const repository = inputText(
      item.repository,
      "repository",
      300,
      line,
    ).toLowerCase();
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository))
      throw new EvaluationInputError("repository must be owner/name", { line });
    const revision = inputText(item.revision, "revision", 200, line);
    if (
      item.split !== "train" &&
      item.split !== "validation" &&
      item.split !== "test"
    )
      throw new EvaluationInputError(
        "split must be train, validation, or test",
        { line },
      );
    if (typeof item.input !== "string" || !item.input.trim())
      throw new EvaluationInputError("input must contain review context", {
        line,
      });
    if (
      !Array.isArray(item.expected) ||
      item.expected.length > (options.maxFindingsPerCase ?? 500)
    )
      throw new EvaluationInputError(
        "expected must be an array within its finding limit",
        { line },
      );
    const expected = item.expected.map((finding: unknown) =>
      expectedFinding(finding, line),
    );
    if (new Set(expected.map((finding) => finding.id)).size !== expected.length)
      throw new EvaluationInputError("duplicate expected finding id", { line });
    const normalizedInput = item.input.replace(/\r\n/g, "\n");
    return {
      version: 1,
      id: caseId,
      repository,
      revision,
      split: item.split,
      input: normalizedInput,
      expected,
      inputHash: evaluationHash(normalizedInput),
    };
  });
  const hashCases = cases
    .map((item) => ({
      ...item,
      expected: [...item.expected].sort((left, right) =>
        compareEvaluationText(left.id, right.id),
      ),
    }))
    .sort((left, right) => compareEvaluationText(left.id, right.id));
  return {
    id,
    version: 1,
    hash: evaluationHash({ version: 1, cases: hashCases }),
    cases,
  };
}

export type LeakageGroup = {
  reason: "duplicate_input" | "duplicate_revision";
  caseIds: string[];
  splits: DatasetSplit[];
  crossesSplits: boolean;
};

/** 相同上下文或同一仓库修订出现在多个划分里，会让测试成绩虚高。 */
export function inspectDatasetLeakage(dataset: ReviewDataset): {
  clean: boolean;
  groups: LeakageGroup[];
} {
  const groups: LeakageGroup[] = [];
  for (const reason of ["duplicate_input", "duplicate_revision"] as const) {
    const byKey = new Map<string, ReviewCase[]>();
    for (const item of dataset.cases) {
      const key =
        reason === "duplicate_input"
          ? item.inputHash
          : canonicalJson([item.repository, item.revision]);
      const cases = byKey.get(key) ?? [];
      cases.push(item);
      byKey.set(key, cases);
    }
    for (const cases of byKey.values()) {
      if (cases.length < 2) continue;
      const splits = [...new Set(cases.map((item) => item.split))].sort();
      groups.push({
        reason,
        caseIds: cases.map((item) => item.id).sort(),
        splits,
        crossesSplits: splits.length > 1,
      });
    }
  }
  return { clean: !groups.some((group) => group.crossesSplits), groups };
}

/** 导出规范 JSONL；不会把内部 inputHash 重复存一份给人维护。 */
export function datasetJsonl(dataset: ReviewDataset): string {
  return (
    dataset.cases
      .map(({ inputHash: _hash, ...item }) => JSON.stringify(item))
      .join("\n") + "\n"
  );
}
