/** SARIF 2.1.0 用标准定位和稳定指纹将发现交给代码扫描工具。 */
import type { ReportData } from "../types.js";

export const mimeType = "application/sarif+json; charset=utf-8";
export const extension = "sarif";

/** @example JSON.parse(render(reportData)).runs[0].results */
export function render(data: ReportData): string {
  const rules = new Map<
    string,
    { id: string; name: string; shortDescription: { text: string } }
  >();
  for (const finding of data.findings) {
    if (!rules.has(finding.ruleId))
      rules.set(finding.ruleId, {
        id: finding.ruleId,
        name: finding.ruleId,
        shortDescription: { text: finding.title },
      });
  }
  const indices = new Map([...rules.keys()].map((id, index) => [id, index]));
  const results = data.findings.map((finding) => ({
    ruleId: finding.ruleId,
    ruleIndex: indices.get(finding.ruleId),
    level: ["critical", "high"].includes(finding.severity)
      ? "error"
      : finding.severity === "medium"
        ? "warning"
        : "note",
    message: { text: `${finding.title}\n${finding.description}`.trim() },
    locations: [
      {
        physicalLocation: {
          artifactLocation: {
            uri: finding.path.split("/").map(encodeURIComponent).join("/"),
            uriBaseId: "%SRCROOT%",
          },
          region: { startLine: finding.line, endLine: finding.endLine },
        },
      },
    ],
    partialFingerprints: { "apertureprism/v1": finding.fingerprint },
    properties: {
      confidence: finding.confidence,
      severity: finding.severity,
      status: finding.status,
      assignee: finding.assignee,
      occurrences: finding.occurrences,
      reference: finding.reference,
    },
    ...(["false_positive", "accepted_risk"].includes(finding.status)
      ? {
          suppressions: [
            {
              kind: "external",
              status: "accepted",
              justification: finding.history.at(-1)?.reason ?? finding.status,
            },
          ],
        }
      : {}),
    baselineState: data.baselines.some(
      (baseline) =>
        baseline.active &&
        baseline.findings.some(
          (item) => item.fingerprint === finding.fingerprint,
        ),
    )
      ? "unchanged"
      : "new",
  }));
  return (
    JSON.stringify(
      {
        $schema: "https://json.schemastore.org/sarif-2.1.0.json",
        version: "2.1.0",
        runs: [
          {
            tool: {
              driver: {
                name: "AperturePrism AI Review",
                informationUri:
                  "https://github.com/AperturePrism/AperturePrism-AI-Review",
                rules: [...rules.values()],
              },
            },
            automationDetails: { id: `${data.repository}/workbench` },
            results,
            properties: {
              repository: data.repository,
              generatedAt: data.generatedAt,
              gate: data.summary.gate.decision,
            },
          },
        ],
      },
      null,
      2,
    ) + "\n"
  );
}
