/** SARIF 2.1.0 报告：可导入代码扫描工具；调用 renderReviewReport("sarif", input)。 */
import type { ReviewReportFormat } from "../report.js";
import type { Finding } from "../types.js";
import { reportFindingFingerprint } from "../report.js";
import { normalizeReviewPath } from "../utils/path.js";
import { severityRank } from "../policy.js";

/** SARIF 只有 error/warning/note，保留原始级别在 properties 中。 */
function level(finding: Finding): "error" | "warning" | "note" {
  return finding.severity === "critical" || finding.severity === "high"
    ? "error"
    : finding.severity === "medium"
      ? "warning"
      : "note";
}

const format: ReviewReportFormat = {
  extension: ".sarif",
  mediaType: "application/sarif+json; charset=utf-8",
  description: "SARIF 2.1.0，含稳定指纹、基线状态与有效抑制",
  render(input) {
    const assessment = input.assessment;
    const suppressed =
      input.includeSuppressed === false
        ? []
        : assessment.suppressions.suppressed;
    const all = [
      ...assessment.findings,
      ...suppressed.map((entry) => entry.finding),
    ];
    const byRule = new Map<string, Finding>();
    for (const finding of all) {
      const previous = byRule.get(finding.rule);
      if (
        !previous ||
        severityRank(finding.severity) > severityRank(previous.severity)
      )
        byRule.set(finding.rule, finding);
    }
    const ruleIds = [...byRule.keys()].sort();
    const results = all.map((finding, index) => {
      const fingerprint = reportFindingFingerprint(finding);
      const baseline = assessment.baseline.current.find(
        (entry) => entry.fingerprint === fingerprint,
      );
      const suppression =
        index >= assessment.findings.length
          ? suppressed[index - assessment.findings.length]!.suppression
          : null;
      const location = {
        physicalLocation: {
          artifactLocation: {
            uri: normalizeReviewPath(finding.file)
              .split("/")
              .map(encodeURIComponent)
              .join("/"),
            uriBaseId: "%SRCROOT%",
          },
          ...(finding.afterLine > 0
            ? {
                region: {
                  startLine: finding.afterLine,
                  ...(input.includeEvidence === false
                    ? {}
                    : { snippet: { text: finding.evidence } }),
                },
              }
            : {}),
        },
      };
      return {
        ruleId: finding.rule,
        ruleIndex: ruleIds.indexOf(finding.rule),
        level: level(finding),
        message: {
          text: `${finding.message}\n\n影响：${finding.impact}\n\n建议：${finding.suggestion}`,
        },
        locations: [location],
        partialFingerprints: { "apertureprism/v1": fingerprint },
        baselineState:
          baseline?.state === "existing"
            ? "unchanged"
            : baseline?.state === "changed"
              ? "updated"
              : "new",
        ...(suppression
          ? {
              suppressions: [
                {
                  kind: "external",
                  status: "accepted",
                  justification: `${suppression.reason}（${suppression.owner}，到期 ${suppression.expiresAt}）`,
                },
              ],
            }
          : {}),
        properties: {
          severity: finding.severity,
          confidence: finding.confidence,
          ...(input.includeEvidence === false
            ? {}
            : { evidence: finding.evidence }),
        },
      };
    });
    const rules = ruleIds.map((id) => {
      const finding = byRule.get(id)!;
      return {
        id,
        shortDescription: { text: id },
        defaultConfiguration: { level: level(finding) },
        help: { text: finding.suggestion },
        properties: { tags: ["ai-review", finding.severity] },
      };
    });
    const checkIds = [
      ...new Set(assessment.checks.executed.map((entry) => entry.checkId)),
    ];
    const checkRules = checkIds.map((id) => ({
      id,
      shortDescription: { text: `配置检查：${id}` },
      defaultConfiguration: { level: "warning" },
      properties: { tags: ["configuration-review", "requires-human-review"] },
    }));
    const checkResults = assessment.checks.observations.map((observation) => ({
      ruleId: observation.checkId,
      rule: {
        id: observation.checkId,
        index: checkIds.indexOf(observation.checkId),
        toolComponent: { name: "AperturePrism configuration checks", index: 0 },
      },
      kind: "review",
      level: observation.level === "warning" ? "warning" : "note",
      message: {
        text: `${observation.title}\n\n${observation.message}\n\n建议：${observation.recommendation}`,
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: {
              uri: normalizeReviewPath(observation.path)
                .split("/")
                .map(encodeURIComponent)
                .join("/"),
              uriBaseId: "%SRCROOT%",
            },
            ...(observation.line > 0
              ? {
                  region: {
                    startLine: observation.line,
                    ...(observation.endLine
                      ? { endLine: observation.endLine }
                      : {}),
                    ...(input.includeEvidence === false
                      ? {}
                      : { snippet: { text: observation.evidence } }),
                  },
                }
              : {}),
          },
        },
      ],
      partialFingerprints: {
        "apertureprism-config/v1": observation.fingerprint,
      },
      properties: {
        nature: observation.nature,
        category: observation.category,
        evidenceRedacted: observation.evidenceRedacted,
        validatedVulnerability: false,
      },
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
                  semanticVersion: "1.0.0",
                  informationUri:
                    "https://github.com/AperturePrism/AperturePrism-AI-Review",
                  rules,
                },
                extensions: [
                  {
                    name: "AperturePrism configuration checks",
                    rules: checkRules,
                  },
                ],
              },
              versionControlProvenance: [
                {
                  repositoryUri:
                    input.sourceUrl ?? `https://github.com/${input.repository}`,
                  revisionId: input.revision,
                },
              ],
              invocations: [
                { executionSuccessful: true, endTimeUtc: assessment.createdAt },
              ],
              results: [...results, ...checkResults],
              properties: {
                gate: assessment.gate.status,
                changedLineCoverage: assessment.coverage.changedLineRatio,
                baselineRevision: assessment.baseline.baselineRevision,
                warnings: assessment.warnings,
              },
            },
          ],
        },
        null,
        2,
      ) + "\n"
    );
  },
};
export default format;
