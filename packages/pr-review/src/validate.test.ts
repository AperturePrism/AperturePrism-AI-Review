import { describe, expect, it } from "vitest";
import { parsePrReviewJson, validatePrReview } from "./validate.js";

const valid = {
  contractVersion: "pr-review/v1",
  summary: "small improvement, one issue",
  changedFileCount: 1,
  additions: 2,
  deletions: 1,
  overallTone: "changes_requested",
  findings: [
    {
      rule: "missing-null-check",
      severity: "high",
      file: "src/a.ts",
      message: "should guard",
      evidence: "const x = obj.field",
      impact: "could crash",
      confidence: 0.9,
      afterLine: 4,
      suggestion: "guard the dereference",
    },
    {
      rule: "missing-null-check",
      severity: "high",
      file: "src/a.ts",
      message: "duplicate",
      evidence: "const x = obj.field",
      impact: "same",
      confidence: 0.8,
      afterLine: 5,
      suggestion: "guard the dereference",
    },
    {
      rule: "style-naming",
      severity: "info",
      file: "src/a.ts",
      message: "rename",
      evidence: "abc",
      impact: "cosmetic",
      confidence: 0.9,
      afterLine: 6,
      suggestion: "use a better name",
    },
  ],
};

describe("validatePrReview", () => {
  it("accepts a valid contract and filters policy-suppressed findings", () => {
    const result = validatePrReview(valid);
    expect(result.outcome).toBe("valid");
    if (result.outcome !== "valid") return;
    // info severity is suppressed; duplicate high finding is collapsed.
    expect(result.review.findings).toHaveLength(1);
    expect(result.review.findings[0]!.rule).toBe("missing-null-check");
  });

  it.each(["low", "info"] as const)(
    "retains %s meaningless changes through JSON parsing and policy filtering",
    (severity) => {
      const meaninglessChange = {
        ...valid.findings[0],
        rule: "meaningless-change",
        severity,
        confidence: 0.5,
      };
      const result = parsePrReviewJson(
        JSON.stringify({
          ...valid,
          overallTone: "comment",
          findings: [
            meaninglessChange,
            { ...meaninglessChange, confidence: 0.9, afterLine: 5 },
            { ...meaninglessChange, confidence: 0.49, file: "src/other.ts" },
            { ...meaninglessChange, rule: "style-naming", confidence: 1 },
          ],
        }),
      );
      expect(result.outcome).toBe("valid");
      if (result.outcome !== "valid") return;
      expect(result.review.findings).toEqual([
        { ...meaninglessChange, confidence: 0.9, afterLine: 5 },
      ]);
      expect(result.review.overallTone).toBe("comment");
    },
  );

  it("rejects non-conforming output with structured issues", () => {
    const result = validatePrReview({ contractVersion: "bogus" });
    expect(result.outcome).toBe("invalid");
  });

  it("handles non-JSON text", () => {
    const result = parsePrReviewJson("not json{");
    expect(result.outcome).toBe("invalid");
  });
});
