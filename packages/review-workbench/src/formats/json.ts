/** JSON 报告保留可供其它系统读取的完整工作台结果。 */
import type { ReportData } from "../types.js";

export const mimeType = "application/json; charset=utf-8";
export const extension = "json";

/** @example JSON.parse(render(reportData)).summary.gate.decision */
export function render(data: ReportData): string {
  return (
    JSON.stringify(
      { format: "apertureprism-review-report", version: 1, ...data },
      null,
      2,
    ) + "\n"
  );
}
