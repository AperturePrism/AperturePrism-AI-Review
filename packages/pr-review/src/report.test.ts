/** 报告端到端回归：真实评估 → 自动格式发现 → 机器和人工报告。 */
import { describe, expect, it } from "vitest";
import { assessReview } from "./assessment.js";
import { renderDiffForModel } from "./context.js";
import { parseUnifiedDiff } from "./diff.js";
import { findingFingerprint } from "./baseline.js";
import { listReviewReportFormats, renderReviewReport } from "./report.js";
import { parseSuppressions } from "./suppression.js";
import type { Finding, PrReviewContract } from "./types.js";

const finding: Finding = {
  rule: "unsafe-query",
  severity: "high",
  file: "src/a b.ts",
  afterLine: 1,
  evidence: "database.query(input);",
  confidence: 0.9,
  message: '=HYPERLINK("https://example.com")',
  impact: "<script>alert(1)</script>",
  suggestion: "使用参数化查询，并添加边界测试",
};
const review: PrReviewContract = {
  contractVersion: "pr-review/v1",
  changedFileCount: 1,
  additions: 1,
  deletions: 0,
  summary: "检查数据库查询",
  overallTone: "comment",
  findings: [finding],
};
const context = renderDiffForModel(
  parseUnifiedDiff(`diff --git a/src/a b.ts b/src/a b.ts
--- a/src/a b.ts
+++ b/src/a b.ts
@@ -0,0 +1 @@
+database.query(input);
`),
);
const assessment = assessReview(review, context, {
  now: new Date("2026-11-13T00:00:00Z"),
});
const input = { assessment, repository: "owner/repo", revision: "abc123" };

describe("review report formats", () => {
  it("discovers formats from the directory without a registry", async () => {
    const formats = await listReviewReportFormats();
    expect(formats.map((format) => format.name)).toEqual([
      "csv",
      "json",
      "markdown",
      "sarif",
    ]);
  });

  it("exports stable JSON with assessment outcomes and without all diff text", async () => {
    const result = await renderReviewReport("json", input);
    const parsed = JSON.parse(result.content);
    expect(parsed).toMatchObject({
      version: "review-report/v1",
      revision: "abc123",
      gate: { status: "failed" },
    });
    expect(parsed.findings[0].fingerprint).toBe(findingFingerprint(finding));
    expect(parsed.plan.chunks).toBe(1);
    expect(parsed.plan.text).toBeUndefined();
    expect(result.filename).toBe("review-owner-repo-abc123.json");
  });

  it("emits SARIF 2.1.0 locations, rules, baselines and stable fingerprints", async () => {
    const report = JSON.parse(
      (await renderReviewReport("sarif", input)).content,
    );
    expect(report.version).toBe("2.1.0");
    const run = report.runs[0];
    expect(run.tool.driver.rules[0].id).toBe(finding.rule);
    expect(run.results[0]).toMatchObject({
      ruleId: finding.rule,
      ruleIndex: 0,
      level: "error",
      baselineState: "new",
    });
    expect(run.results[0].locations[0].physicalLocation).toMatchObject({
      artifactLocation: { uri: "src/a%20b.ts" },
      region: { startLine: 1 },
    });
    expect(run.results[0].partialFingerprints["apertureprism/v1"]).toBe(
      findingFingerprint(finding),
    );
  });

  it("does not create an invalid SARIF zero line", async () => {
    const unanchored = assessReview(
      { ...review, findings: [{ ...finding, afterLine: 0 }] },
      context,
    );
    const report = JSON.parse(
      (await renderReviewReport("sarif", { ...input, assessment: unanchored }))
        .content,
    );
    expect(
      report.runs[0].results[0].locations[0].physicalLocation.region,
    ).toBeUndefined();
  });

  it("neutralizes spreadsheet formulas and follows CSV newline escaping", async () => {
    const report = await renderReviewReport("csv", input);
    expect(report.content).toContain('"\'=HYPERLINK(""https://example.com"")"');
    expect(report.content.endsWith("\r\n")).toBe(true);
  });

  it("renders untrusted HTML as text in a readable Markdown report", async () => {
    const report = await renderReviewReport("markdown", input);
    expect(report.content).not.toContain("<script>");
    expect(report.content).toContain("&lt;script&gt;");
    expect(report.content).toContain("模型输入覆盖");
    expect(report.content).toContain("### unsafe");
    expect(report.content).toContain(finding.evidence);
  });

  it.each(["json", "csv", "markdown", "sarif"])(
    "can omit code evidence from %s reports",
    async (format) => {
      const report = await renderReviewReport(format, {
        ...input,
        includeEvidence: false,
      });
      expect(report.content).not.toContain(finding.evidence);
    },
  );

  it("preserves accepted suppression metadata in SARIF", async () => {
    const suppressions = parseSuppressions([
      {
        id: "ok-1",
        fingerprint: findingFingerprint(finding),
        reason: "等待维护窗口集中修复",
        owner: "@team",
        expiresAt: "2027-01-01T00:00:00Z",
      },
    ]);
    const accepted = assessReview(review, context, {
      suppressions,
      now: new Date("2026-11-13T00:00:00Z"),
    });
    const report = JSON.parse(
      (await renderReviewReport("sarif", { ...input, assessment: accepted }))
        .content,
    );
    expect(report.runs[0].results[0].suppressions[0]).toMatchObject({
      kind: "external",
      status: "accepted",
    });
    const excluded = JSON.parse(
      (
        await renderReviewReport("sarif", {
          ...input,
          assessment: accepted,
          includeSuppressed: false,
        })
      ).content,
    );
    expect(excluded.runs[0].results).toEqual([]);
  });

  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://user:pass@example.com",
  ])("rejects unsafe source URL %s", async (sourceUrl) => {
    await expect(
      renderReviewReport("json", { ...input, sourceUrl }),
    ).rejects.toThrow();
  });

  it("rejects unknown formats and malformed identifiers", async () => {
    await expect(renderReviewReport("html", input)).rejects.toThrow("不支持");
    await expect(
      renderReviewReport("json", { ...input, revision: " " }),
    ).rejects.toThrow("提交标识");
    await expect(
      renderReviewReport("json", { ...input, pullNumber: 0 }),
    ).rejects.toThrow("PR 编号");
  });
});
