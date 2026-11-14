import { describe, expect, it } from "vitest";
import { applyGradingRules } from "./grading.js";
import { evidenceSchema, type IssueAnalysisResult } from "./issue-analysis.js";

const analysis: IssueAnalysisResult = {
  contractVersion: "issue-analysis/v1",
  category: "bug",
  summary: "failure",
  severity: "S0",
  priority: "P0",
  quality: "actionable",
  evidence: [],
  missingInformation: [],
  suggestedLabels: [],
  suggestedActions: [],
  troubleshooting: [],
  proposedChanges: [],
  confidence: { severity: 0.9, rootCause: 0.9, suggestion: 0.9 },
};

describe("evidence must contain a verifiable excerpt", () => {
  it.each([" ", "\t\n", "\u2003"])(
    "rejects a whitespace-only excerpt %j",
    (excerpt) => {
      expect(evidenceSchema.safeParse({ kind: "logs", excerpt }).success).toBe(
        false,
      );
    },
  );

  it.each([
    "reproduction_steps",
    "logs",
    "stack_trace",
    "data_loss",
    "security_path",
  ] as const)(
    "does not grade %s whitespace as substantive evidence",
    (kind) => {
      const { result } = applyGradingRules({
        ...analysis,
        evidence: [{ kind, excerpt: " \n\t" }],
      });
      expect(result.severity).toBe("unknown");
      expect(result.priority).toBe("needs_triage");
    },
  );

  it("preserves indentation and line breaks in a real excerpt", () => {
    const excerpt = "  throw new Error('failure');\n";
    expect(evidenceSchema.parse({ kind: "logs", excerpt }).excerpt).toBe(
      excerpt,
    );
    const { result } = applyGradingRules({
      ...analysis,
      evidence: [{ kind: "logs", excerpt }],
    });
    expect(result.severity).toBe("S0");
    expect(result.priority).toBe("P0");
  });
});
