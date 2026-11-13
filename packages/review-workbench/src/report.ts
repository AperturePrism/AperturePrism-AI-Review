/**
 * 报告格式放进 formats/ 即生效；扫描范围固定为随程序发布的代码。
 * @example const artifact = await renderReport(context, {format:'sarif'});
 */
import { readdir } from "node:fs/promises";
import { extname } from "node:path";
import type { ReportArtifact, ReportData, ReportWriter } from "./types.js";
import type { CommandContext } from "./audit.js";
import { evaluateCases } from "./evaluation.js";
import { summarizeWorkbench } from "./summary.js";
import { text, WorkbenchError } from "./utils/input.js";

/** 格式名来自文件名，不接受路径或任意模块 URL。 */
export async function reportFormats(): Promise<string[]> {
  const extension = extname(new URL(import.meta.url).pathname);
  const files = await readdir(new URL("./formats/", import.meta.url));
  return files
    .filter(
      (file) =>
        file.endsWith(extension) &&
        !file.includes(".test.") &&
        !file.endsWith(".d.ts"),
    )
    .map((file) => file.slice(0, -extension.length))
    .filter((name) => /^[a-z][a-z0-9-]*$/.test(name))
    .sort();
}

export function buildReportData(context: CommandContext): ReportData {
  const repository = context.repository;
  return {
    repository,
    generatedAt: context.now,
    summary: summarizeWorkbench(context),
    findings: context.data.findings.filter(
      (item) => item.repository === repository,
    ),
    baselines: context.data.baselines.filter(
      (item) => item.repository === repository,
    ),
    policies: context.data.policies.filter(
      (item) => item.repository === repository,
    ),
    suppressions: context.data.suppressions.filter(
      (item) => item.repository === repository,
    ),
    feedback: context.data.feedback.filter(
      (item) => item.repository === repository,
    ),
    budgets: context.data.budgets.filter(
      (item) => item.repository === repository,
    ),
    evaluations: context.data.evaluations
      .filter((item) => item.repository === repository)
      .map((item) => ({ ...item, result: evaluateCases(item) })),
  };
}

export async function renderReport(
  context: CommandContext,
  input: Record<string, unknown>,
): Promise<ReportArtifact> {
  const format = text(input.format ?? "json", "format", 50);
  const formats = await reportFormats();
  if (!formats.includes(format))
    throw new WorkbenchError(
      "unsupported_format",
      `报告格式可选：${formats.join(", ")}`,
    );
  const extension = extname(new URL(import.meta.url).pathname);
  const writer = (await import(
    new URL(`./formats/${format}${extension}`, import.meta.url).href
  )) as ReportWriter;
  if (
    typeof writer.render !== "function" ||
    typeof writer.mimeType !== "string" ||
    !/^[a-z0-9]+$/.test(writer.extension)
  ) {
    throw new WorkbenchError(
      "invalid_report_writer",
      `报告格式 ${format} 导出不完整`,
      500,
    );
  }
  const data = buildReportData(context);
  return {
    format,
    mimeType: writer.mimeType,
    filename: `${context.repository.replace("/", "-")}-review.${writer.extension}`,
    content: writer.render(data),
  };
}
