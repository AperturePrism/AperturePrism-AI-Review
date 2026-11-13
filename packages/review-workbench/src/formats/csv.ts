/** CSV 导出用于人工表格筛选，前缀转义阻止公式在打开时被执行。 */
import type { ReportData } from "../types.js";

export const mimeType = "text/csv; charset=utf-8";
export const extension = "csv";

function cell(value: string | number): string {
  let content = String(value);
  if (/^[\s]*[=+\-@]/.test(content) || /^[\t\r]/.test(content))
    content = "'" + content;
  return `"${content.replaceAll('"', '""')}"`;
}

/** @example render(reportData) // 每个发现一行，所有字段均按 RFC 4180 加引号。 */
export function render(data: ReportData): string {
  const rows: (string | number)[][] = [
    [
      "repository",
      "id",
      "fingerprint",
      "rule",
      "severity",
      "confidence",
      "status",
      "path",
      "line",
      "endLine",
      "title",
      "description",
      "assignee",
      "occurrences",
      "lastSeenAt",
    ],
  ];
  for (const finding of data.findings) {
    rows.push([
      finding.repository,
      finding.id,
      finding.fingerprint,
      finding.ruleId,
      finding.severity,
      finding.confidence,
      finding.status,
      finding.path,
      finding.line,
      finding.endLine,
      finding.title,
      finding.description,
      finding.assignee,
      finding.occurrences,
      finding.lastSeenAt,
    ]);
  }
  return (
    "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n"
  );
}
