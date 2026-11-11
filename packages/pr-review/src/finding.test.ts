import { describe, expect, it } from "vitest";
import {
  applySeverityRules,
  dedupeFindings,
  shouldPublishFinding,
} from "./finding.js";
import type { Finding } from "./types.js";

function finding(partial: Partial<Finding>): Finding {
  return {
    rule: "missing-null-check",
    severity: "medium",
    file: "src/a.ts",
    message: "m",
    evidence: "const x = obj.field",
    impact: "i",
    confidence: 0.8,
    suggestion: "s",
    afterLine: 10,
    ...partial,
  };
}

describe("dedupeFindings", () => {
  it("collapses same-rule same-file findings within line proximity", () => {
    const result = dedupeFindings([
      finding({ severity: "high", afterLine: 10 }),
      finding({ severity: "low", afterLine: 12, file: "other.ts" }),
      finding({ severity: "info", afterLine: 0, rule: "style-naming" }),
    ]);
    expect(result).toHaveLength(3);
  });

  it("keeps the strongest finding of a collapsed group", () => {
    const result = dedupeFindings([
      finding({ severity: "low", confidence: 0.6, afterLine: 10 }),
      finding({ severity: "high", confidence: 0.9, afterLine: 14 }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.severity).toBe("high");
  });
});

describe("shouldPublishFinding", () => {
  it("suppresses low severity style nits", () => {
    expect(
      shouldPublishFinding(finding({ severity: "info", confidence: 0.9 })),
    ).toBe(false);
    expect(
      shouldPublishFinding(finding({ severity: "low", confidence: 0.9 })),
    ).toBe(false);
    expect(
      shouldPublishFinding(finding({ severity: "medium", confidence: 0.9 })),
    ).toBe(true);
  });

  it("suppresses low confidence findings", () => {
    expect(
      shouldPublishFinding(finding({ severity: "high", confidence: 0.3 })),
    ).toBe(false);
  });

  it.each(["low", "info"] as const)(
    "publishes %s meaningless changes without lowering the confidence threshold",
    (severity) => {
      expect(
        shouldPublishFinding(
          finding({ rule: "meaningless-change", severity, confidence: 0.9 }),
        ),
      ).toBe(true);
      expect(
        shouldPublishFinding(
          finding({ rule: "meaningless-change", severity, confidence: 0.5 }),
        ),
      ).toBe(true);
      expect(
        shouldPublishFinding(
          finding({ rule: "meaningless-change", severity, confidence: 0.49 }),
        ),
      ).toBe(false);
    },
  );

  it.each([
    "style-naming",
    "meaningless-change-other",
    "other-meaningless-change",
  ])("does not exempt %s from the severity threshold", (rule) => {
    for (const severity of ["low", "info"] as const) {
      expect(
        shouldPublishFinding(finding({ rule, severity, confidence: 1 })),
      ).toBe(false);
    }
  });
});

describe("applySeverityRules", () => {
  it("downgrades high severity without evidence or a line anchor", () => {
    expect(
      applySeverityRules(finding({ severity: "critical", afterLine: 0 }))
        .severity,
    ).toBe("medium");
    expect(
      applySeverityRules(finding({ severity: "high", evidence: "x" })).severity,
    ).toBe("medium");
    expect(
      applySeverityRules(
        finding({
          severity: "high",
          afterLine: 10,
          evidence: "real diff text",
        }),
      ).severity,
    ).toBe("high");
  });
});
