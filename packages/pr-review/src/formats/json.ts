/** JSON 报告：机器可读的评估摘要；调用统一的 renderReviewReport("json", input)。 */
import type { ReviewReportFormat } from "../report.js";
import { reportFindingFingerprint } from "../report.js";

const format: ReviewReportFormat = {
  extension: ".json",
  mediaType: "application/json; charset=utf-8",
  description: "包含门禁、风险、覆盖、基线和发现的结构化报告",
  render(input) {
    const assessment = input.assessment;
    const redactFinding = (finding: (typeof assessment.findings)[number]) => {
      const { evidence, ...rest } = finding;
      return input.includeEvidence === false ? rest : { ...rest, evidence };
    };
    return (
      JSON.stringify(
        {
          version: "review-report/v1",
          repository: input.repository,
          revision: input.revision,
          pullNumber: input.pullNumber ?? null,
          sourceUrl: input.sourceUrl ?? null,
          createdAt: assessment.createdAt,
          summary: assessment.review.summary,
          policy: {
            name: assessment.policy.name,
            version: assessment.policy.version,
          },
          gate: assessment.gate,
          risk: assessment.risk,
          coverage: assessment.coverage,
          baseline: {
            revision: assessment.baseline.baselineRevision,
            counts: assessment.baseline.counts,
          },
          findings: assessment.findings.map((finding) => ({
            fingerprint: reportFindingFingerprint(finding),
            state:
              assessment.baseline.current.find(
                (entry) =>
                  entry.fingerprint === reportFindingFingerprint(finding),
              )?.state ?? "new",
            ...redactFinding(finding),
          })),
          suppressed:
            input.includeSuppressed === false
              ? []
              : assessment.suppressions.suppressed.map((entry) => ({
                  fingerprint: entry.fingerprint,
                  finding: redactFinding(entry.finding),
                  suppression: entry.suppression,
                })),
          excluded: assessment.excluded.map((entry) => ({
            fingerprint: entry.fingerprint,
            rule: entry.finding.rule,
            file: entry.finding.file,
            reason: entry.reason,
          })),
          checks:
            input.includeEvidence === false
              ? {
                  ...assessment.checks,
                  observations: assessment.checks.observations.map(
                    ({ evidence: _evidence, ...rest }) => rest,
                  ),
                }
              : assessment.checks,
          owners: assessment.owners,
          intelligence: {
            snapshotFiles: assessment.intelligence.snapshotFiles,
            affectedPaths: assessment.intelligence.affectedPaths,
            cycles: assessment.intelligence.cycles,
            tests: assessment.intelligence.tests,
            contracts:
              input.includeEvidence === false
                ? {
                    ...assessment.intelligence.contracts,
                    observations:
                      assessment.intelligence.contracts.observations.map(
                        ({ before: _before, after: _after, ...rest }) => rest,
                      ),
                  }
                : assessment.intelligence.contracts,
            dependencies: assessment.intelligence.dependencies,
            graph: assessment.intelligence.graph,
          },
          warnings: assessment.warnings,
          plan: {
            chunks: assessment.plan.chunks.length,
            estimatedTokens: assessment.plan.estimatedTokens,
            includedChangedLines: assessment.plan.includedChangedLines,
            excludedChangedLines: assessment.plan.excludedChangedLines,
            files: assessment.plan.files,
          },
        },
        null,
        2,
      ) + "\n"
    );
  },
};
export default format;
