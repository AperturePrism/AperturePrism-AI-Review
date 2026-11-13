/**
 * 审查报告：扫描 formats/ 中的格式文件；添加一种格式只需放入一个文件。
 * 调用：await renderReviewReport("sarif", { assessment, repository: "owner/repo", revision: "abc" });
 * 格式名由文件名决定；所有格式接收相同输入，不自行访问网络或文件系统。
 */
import { readdir } from "node:fs/promises";
import type { ReviewAssessment } from "./assessment.js";
import { findingFingerprint } from "./baseline.js";
import type { Finding } from "./types.js";
import { redactCheckEvidence } from "./checks.js";
import { safeReportUrl, containsControlCharacters } from "./utils/path.js";

export type ReviewReportInput = {
  assessment: ReviewAssessment;
  repository: string;
  revision: string;
  pullNumber?: number;
  sourceUrl?: string;
  /** 报告默认附带证据；对外摘要可设 false 以减少源代码暴露。 */
  includeEvidence?: boolean;
  /** 报告默认保留有效抑制项，便于说明已接受的问题。 */
  includeSuppressed?: boolean;
};
export type ReviewReportFile = {
  format: string;
  filename: string;
  mediaType: string;
  content: string;
};
export type ReviewReportFormat = {
  extension: string;
  mediaType: string;
  description: string;
  render: (input: ReviewReportInput) => string;
};

const reportFingerprints = new WeakMap<object, string>(); // 脱敏改变摘录文字，但报告中的发现身份必须沿用原证据。

let formatsPromise:
  Promise<ReadonlyMap<string, ReviewReportFormat>> | undefined;

/** 只在启动后首次请求时扫描；测试可传入独立目录验证插件发现。 */
export async function discoverReviewReportFormats(
  directory = new URL("./formats/", import.meta.url),
): Promise<ReadonlyMap<string, ReviewReportFormat>> {
  const paths = (await readdir(directory)).filter(
    (file) => /\.(?:ts|js)$/u.test(file) && !/\.(?:d|test|spec)\./u.test(file),
  );
  const names = [
    ...new Set(paths.map((file) => file.replace(/\.(?:ts|js)$/u, ""))),
  ].sort();
  const formats = new Map<string, ReviewReportFormat>();
  for (const name of names) {
    // 构建目录可能同时保留 ts/js；运行时优先同入口扩展名，避免加载两遍同一种格式。
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const filename = paths.includes(`${name}.${extension}`)
      ? `${name}.${extension}`
      : paths.find((file) => file.startsWith(`${name}.`))!;
    const loaded = (await import(new URL(filename, directory).href)) as {
      default?: ReviewReportFormat;
    };
    const format = loaded.default;
    if (
      !format ||
      typeof format.render !== "function" ||
      !/^\.[a-z0-9.]+$/u.test(format.extension)
    ) {
      throw new Error(
        `审查报告格式 ${name} 没有导出有效的格式说明和 render 方法`,
      );
    }
    formats.set(name, format);
  }
  return formats;
}

/** 列出当前安装的全部格式；由文件夹自动决定，不维护第二份中央登记表。 */
export async function listReviewReportFormats(): Promise<
  readonly {
    name: string;
    extension: string;
    mediaType: string;
    description: string;
  }[]
> {
  const formats = await availableFormats();
  return [...formats].map(([name, format]) => ({
    name,
    extension: format.extension,
    mediaType: format.mediaType,
    description: format.description,
  }));
}

/** 检查外部报告元数据，再交给已发现的格式生成完整内容。 */
export async function renderReviewReport(
  formatName: string,
  input: ReviewReportInput,
): Promise<ReviewReportFile> {
  const repository = input.repository.trim();
  const revision = input.revision.trim();
  if (
    !repository ||
    repository.length > 300 ||
    containsControlCharacters(repository)
  )
    throw new Error("报告仓库名称无效");
  if (!revision || revision.length > 200 || containsControlCharacters(revision))
    throw new Error("报告提交标识无效");
  if (
    input.pullNumber !== undefined &&
    (!Number.isSafeInteger(input.pullNumber) || input.pullNumber <= 0)
  )
    throw new Error("报告 PR 编号必须是正整数");
  const sourceUrl = safeReportUrl(input.sourceUrl);
  const formats = await availableFormats();
  const format = formats.get(formatName);
  if (!format)
    throw new Error(
      `不支持的审查报告格式：${formatName}；可用格式：${[...formats.keys()].join(", ")}`,
    );
  const normalized = redactReportValues({
    ...input,
    repository,
    revision,
    ...(sourceUrl ? { sourceUrl } : {}),
  });
  const basename = `${repository.replace(/[^a-zA-Z0-9_.-]+/gu, "-")}-${revision.replace(/[^a-zA-Z0-9_.-]+/gu, "-")}`;
  return {
    format: formatName,
    filename: `review-${basename}${format.extension}`,
    mediaType: format.mediaType,
    content: format.render(normalized),
  };
}

async function availableFormats(): Promise<
  ReadonlyMap<string, ReviewReportFormat>
> {
  formatsPromise ??= discoverReviewReportFormats();
  return formatsPromise;
}

/** 在序列化之前递归脱敏文本；直接替换已序列化 JSON 会破坏引号结构。 */
function redactReportValues<T>(value: T): T {
  if (typeof value === "string") return redactCheckEvidence(value) as T;
  if (Array.isArray(value))
    return value.map((item: unknown) => redactReportValues(item)) as T;
  if (value !== null && typeof value === "object") {
    const clone = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactReportValues(item),
      ]),
    );
    const candidate = value as Partial<Finding>;
    if (
      typeof candidate.rule === "string" &&
      typeof candidate.file === "string" &&
      typeof candidate.evidence === "string" &&
      typeof candidate.afterLine === "number"
    ) {
      reportFingerprints.set(clone, findingFingerprint(candidate as Finding));
    }
    return clone as T;
  }
  return value;
}

/** 格式文件计算身份时使用此方法，脱敏前后的同一发现始终保持相同指纹。 */
export function reportFindingFingerprint(finding: Finding): string {
  return reportFingerprints.get(finding) ?? findingFingerprint(finding);
}
