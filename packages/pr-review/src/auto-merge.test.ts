import { describe, expect, it } from "vitest";
import { assessReview } from "./assessment.js";
import { renderDiffForModel } from "./context.js";
import { parseUnifiedDiff } from "./diff.js";
import { reviewAllowsAutoMerge } from "./auto-merge.js";
import type { PrReviewContract } from "./types.js";

function passed() {
  const review: PrReviewContract = {
    contractVersion: "pr-review/v1",
    summary: "变更正确",
    changedFileCount: 1,
    additions: 1,
    deletions: 1,
    overallTone: "approve",
    findings: [],
  };
  const context = renderDiffForModel(
    parseUnifiedDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`),
  );
  return { ...review, assessment: assessReview(review, context) };
}

describe("reviewAllowsAutoMerge", () => {
  it("accepts a complete passing server assessment", () => {
    expect(reviewAllowsAutoMerge(passed())).toBe(true);
  });
  it("rejects a model-only approval and unstructured data", () => {
    const { assessment: _assessment, ...modelOnly } = passed();
    expect(reviewAllowsAutoMerge(modelOnly)).toBe(false);
    for (const value of [null, undefined, "passed", [], { approved: true }])
      expect(reviewAllowsAutoMerge(value)).toBe(false);
  });
  it.each(["comment", "changes_requested"])(
    "requires explicit approval rather than %s",
    (tone) => {
      expect(reviewAllowsAutoMerge({ ...passed(), overallTone: tone })).toBe(
        false,
      );
    },
  );
  it("rejects any finding, including filtered or suppressed findings", () => {
    const hidden = passed();
    hidden.assessment.excluded = [{} as never];
    expect(reviewAllowsAutoMerge(hidden)).toBe(false);
    const suppressed = passed();
    suppressed.assessment.suppressions.suppressed = [{} as never];
    expect(reviewAllowsAutoMerge(suppressed)).toBe(false);
    const assessed = passed();
    assessed.assessment.findings = [{} as never];
    expect(reviewAllowsAutoMerge(assessed)).toBe(false);
  });
  it("rejects an assessment bound to a different review contract", () => {
    const mismatch = passed();
    mismatch.assessment.review = {
      ...mismatch.assessment.review,
      overallTone: "changes_requested",
    };
    expect(reviewAllowsAutoMerge(mismatch)).toBe(false);
  });
  it("rejects failed or missing gate and partial/unread/binary files", () => {
    const failed = passed();
    failed.assessment.gate.status = "failed";
    expect(reviewAllowsAutoMerge(failed)).toBe(false);
    const partial = passed();
    partial.assessment.coverage.changedLineRatio = 0.99;
    expect(reviewAllowsAutoMerge(partial)).toBe(false);
    const unread = passed();
    unread.assessment.coverage.completeFiles = 0;
    expect(reviewAllowsAutoMerge(unread)).toBe(false);
    const binary = passed();
    binary.assessment.coverage.binaryFiles = 1;
    expect(reviewAllowsAutoMerge(binary)).toBe(false);
    const empty = passed();
    empty.assessment.coverage.totalFiles = 0;
    empty.assessment.coverage.completeFiles = 0;
    expect(reviewAllowsAutoMerge(empty)).toBe(false);
  });
});
