/** CSV 报告：供表格工具筛选；调用 renderReviewReport("csv", input)，防止公式注入。 */
import type { ReviewReportFormat } from "../report.js";
import { reportFindingFingerprint } from "../report.js";

/** 引号与换行按 RFC 4180 转义，电子表格公式前加单引号。 */
function cell(value: unknown): string {
  const raw = String(value ?? "");
  const safe =
    /^[\s]*[=+\-@]/u.test(raw) || /^[\t\r]/u.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

const format: ReviewReportFormat = {
  extension: ".csv",
  mediaType: "text/csv; charset=utf-8",
  description: "便于表格筛选的发现清单，包含状态、指纹和抑制原因",
  render(input) {
    const assessment = input.assessment;
    const rows: unknown[][] = [
      [
        "repository",
        "revision",
        "fingerprint",
        "state",
        "severity",
        "rule",
        "file",
        "line",
        "confidence",
        "message",
        "impact",
        "suggestion",
        "evidence",
        "suppression_id",
        "suppression_reason",
        "suppression_owner",
        "suppression_expires",
      ],
    ];
    for (const finding of assessment.findings) {
      const fingerprint = reportFindingFingerprint(finding);
      const state =
        assessment.baseline.current.find(
          (entry) => entry.fingerprint === fingerprint,
        )?.state ?? "new";
      rows.push([
        input.repository,
        input.revision,
        fingerprint,
        state,
        finding.severity,
        finding.rule,
        finding.file,
        finding.afterLine,
        finding.confidence,
        finding.message,
        finding.impact,
        finding.suggestion,
        input.includeEvidence === false ? "" : finding.evidence,
        "",
        "",
        "",
        "",
      ]);
    }
    if (input.includeSuppressed !== false) {
      for (const entry of assessment.suppressions.suppressed) {
        const finding = entry.finding;
        const suppression = entry.suppression;
        rows.push([
          input.repository,
          input.revision,
          entry.fingerprint,
          "suppressed",
          finding.severity,
          finding.rule,
          finding.file,
          finding.afterLine,
          finding.confidence,
          finding.message,
          finding.impact,
          finding.suggestion,
          input.includeEvidence === false ? "" : finding.evidence,
          suppression.id,
          suppression.reason,
          suppression.owner,
          suppression.expiresAt,
        ]);
      }
    }
    return rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
  },
};
export default format;
