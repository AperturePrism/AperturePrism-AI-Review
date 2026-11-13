/** 审查评估的回归测试：使用真实 diff，不访问 GitHub 或外部模型。 */
import { describe, expect, it } from "vitest";
import { assessReview, assessedReview } from "./assessment.js";
import { createReviewBaseline, findingFingerprint } from "./baseline.js";
import { renderDiffForModel } from "./context.js";
import { parseUnifiedDiff } from "./diff.js";
import { parseSuppressions } from "./suppression.js";
import type { Finding, PrReviewContract } from "./types.js";

const now = new Date("2026-11-13T00:00:00Z");
const finding: Finding = {
  rule: "permission-check",
  severity: "high",
  file: "src/auth.ts",
  afterLine: 2,
  message: "写操作缺少权限检查",
  evidence: "return account.update(input);",
  impact: "普通用户可能修改其他账户",
  suggestion: "写操作前确认当前用户拥有目标账户",
  confidence: 0.95,
};
const diff = parseUnifiedDiff(`diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,2 +1,2 @@
 export function update(input) {
-  return account.read(input);
+  return account.update(input);
`);
const context = renderDiffForModel(diff);
const review: PrReviewContract = {
  contractVersion: "pr-review/v1",
  summary: "需要补全权限检查",
  changedFileCount: 1,
  additions: 1,
  deletions: 1,
  overallTone: "comment",
  findings: [finding],
};

describe("assessReview", () => {
  it("runs evidence, risk, plan, baseline and gate in one assessment", () => {
    const result = assessReview(review, context, {
      now,
      codeOwners: "/src/** @security\n",
    });
    expect(result.version).toBe("review-assessment/v1");
    expect(result.evidence[0]).toMatchObject({
      verified: true,
      changedLine: true,
      source: "diff",
    });
    expect(result.risk.files[0]?.securitySensitive).toBe(true);
    expect(result.baseline.counts.new).toBe(1);
    expect(result.gate.status).toBe("failed");
    expect(result.gate.newCounts.high).toBe(1);
    expect(result.coverage.changedLineRatio).toBe(1);
    expect(result.owners[0]?.owner).toBe("@security");
    expect(result.plan.chunks[0]?.text).toContain(
      "+2|   return account.update(input);",
    );
    expect(assessedReview(result).overallTone).toBe("changes_requested");
  });

  it("keeps the old contract and caller objects immutable", () => {
    const before = structuredClone(review);
    const result = assessReview(review, context, {
      now,
      policy: { severityOverrides: { "permission-check": "medium" } },
    });
    expect(result.findings[0]?.severity).toBe("medium");
    expect(result.review.findings[0]?.severity).toBe("high");
    expect(review).toEqual(before);
  });

  it("rejects unverified model claims from the assessed publication", () => {
    const result = assessReview(
      { ...review, findings: [{ ...finding, evidence: "made up source" }] },
      context,
      { now },
    );
    expect(result.findings).toEqual([]);
    expect(result.excluded[0]?.reason).toBe("unverified_evidence");
    expect(result.review.findings).toHaveLength(1);
    expect(result.gate.status).toBe("passed");
  });

  it("can keep unverified findings when an operator explicitly changes policy", () => {
    const result = assessReview(
      { ...review, findings: [{ ...finding, evidence: "made up source" }] },
      context,
      { now, policy: { requireEvidence: false } },
    );
    expect(result.findings).toHaveLength(1);
    expect(result.evidence[0]?.verified).toBe(false);
  });

  it.each([
    [{ exclude: ["src/**"] }, "excluded_path"],
    [{ include: ["other/**"] }, "excluded_path"],
    [{ disabledRules: ["permission-check"] }, "disabled_rule"],
    [{ minimumConfidence: 0.99 }, "low_confidence"],
    [{ minimumSeverity: "critical" }, "low_severity"],
    [{ maxFindings: 0 }, "finding_limit"],
  ] as const)("records the reason for policy %j", (policy, reason) => {
    const result = assessReview(review, context, { now, policy });
    expect(result.excluded[0]?.reason).toBe(reason);
    expect(result.findings).toHaveLength(0);
  });

  it("does not hide a blocking issue merely because the presentation limit is zero", () => {
    const result = assessReview(review, context, {
      now,
      policy: { maxFindings: 0 },
    });
    expect(result.gate.status).toBe("failed");
    expect(
      result.warnings.some((warning) => warning.includes("数量上限")),
    ).toBe(true);
  });

  it("accepts a justified suppression and keeps its audit record", () => {
    const suppressions = parseSuppressions([
      {
        id: "accepted-1",
        fingerprint: findingFingerprint(finding),
        reason: "该功能尚未开放，发布前修复",
        owner: "@owner",
        expiresAt: "2026-12-01T00:00:00Z",
      },
    ]);
    const result = assessReview(review, context, { now, suppressions });
    expect(result.findings).toEqual([]);
    expect(result.suppressions.suppressed[0]?.suppression.id).toBe(
      "accepted-1",
    );
    expect(result.gate.status).toBe("passed");
  });

  it("does not re-block unchanged problems accepted by the previous baseline", () => {
    const baseline = createReviewBaseline(review, { revision: "old", now });
    const result = assessReview(review, context, { now, baseline });
    expect(result.gate.newCounts.high).toBe(0);
    expect(result.gate.status).toBe("passed");
    expect(result.findings).toHaveLength(1);
  });

  it("can publish only new findings without deleting the original record", () => {
    const baseline = createReviewBaseline(review, { revision: "old", now });
    const result = assessReview(review, context, {
      now,
      baseline,
      policy: { onlyNewFindings: true },
    });
    expect(result.excluded[0]?.reason).toBe("existing_finding");
    expect(result.findings).toEqual([]);
    expect(result.review.findings).toHaveLength(1);
  });

  it("marks partial input as incomplete and avoids automatic approval", () => {
    const limited = renderDiffForModel(diff, {
      maxTokens: 20,
      maxInlineFiles: 0,
      maxLinesPerFile: 0,
    });
    const result = assessReview(
      { ...review, findings: [], overallTone: "approve" },
      limited,
      { now },
    );
    expect(result.coverage.changedLineRatio).toBe(0);
    expect(result.gate.status).toBe("incomplete");
    expect(assessedReview(result).overallTone).toBe("comment");
  });

  it("warns about expired suppressions and still publishes the finding", () => {
    const suppressions = parseSuppressions([
      {
        id: "expired",
        rule: finding.rule,
        path: finding.file,
        reason: "等待下一个发布窗口",
        owner: "@owner",
        expiresAt: now.toISOString(),
      },
    ]);
    const result = assessReview(review, context, { now, suppressions });
    expect(result.findings).toHaveLength(1);
    expect(result.suppressions.expired).toHaveLength(1);
    expect(result.warnings.some((warning) => warning.includes("到期"))).toBe(
      true,
    );
  });
});
