import { describe, expect, it } from "vitest";
import {
  applyGradingRules,
  type IssueAnalysisResult,
} from "../../../packages/contracts/src/index.js";
import type { IssueContext } from "./context.js";
import {
  auditIssueEvidence,
  groundIssueAnalysis,
  issueEvidenceSources,
} from "./evidence.js";

const context: IssueContext = {
  repository: { owner: "example", name: "project" },
  installationId: "1",
  issue: {
    number: 1,
    title: "Crash at startup",
    body: "1. Remove config.\n2. Start the app.\n3. App crashes.",
    state: "open",
    htmlUrl: "https://github.test/example/project/issues/1",
    author: "reporter",
    createdAt: "2026-11-13T00:00:00Z",
    updatedAt: "2026-11-13T00:00:00Z",
    labels: [],
  },
  comments: [
    {
      author: "reporter",
      body: "The error is ECONNREFUSED.",
      createdAt: "2026-11-13T00:01:00Z",
    },
  ],
  images: [],
  degraded: [],
  estimatedTokens: 100,
  preloadedFiles: [
    {
      path: "src/app.ts",
      content: "const config = readConfig();\nstart(config.port);",
    },
  ],
};
const result: IssueAnalysisResult = {
  contractVersion: "issue-analysis/v1",
  category: "bug",
  summary: "Crashes",
  severity: "S0",
  priority: "P0",
  quality: "complete",
  evidence: [
    { kind: "reproduction_steps", excerpt: "Imagined reproduction steps" },
  ],
  troubleshooting: [],
  proposedChanges: [],
  missingInformation: [],
  suggestedLabels: [],
  suggestedActions: [],
  confidence: { severity: 0.9, rootCause: 0.9, suggestion: 0.9 },
};

describe("issue evidence grounding", () => {
  it("locates an exact quote with its original source and line", () => {
    const audit = auditIssueEvidence(
      [{ kind: "reproduction_steps", excerpt: "2. Start the app." }],
      issueEvidenceSources(context),
    );
    expect(audit.matches[0]?.source).toEqual({
      kind: "body",
      key: "issue.body",
      line: 2,
    });
    expect(audit.verifiedCount).toBe(1);
  });

  it("allows whitespace differences without inventing semantic matches", () => {
    const audit = auditIssueEvidence(
      [
        {
          kind: "reproduction_steps",
          excerpt: "Remove config. 2. Start the app.",
        },
        {
          kind: "reproduction_steps",
          excerpt: "Delete the configuration, then launch.",
        },
      ],
      issueEvidenceSources(context),
    );
    expect(audit.matches.map((match) => match.verified)).toEqual([true, false]);
  });

  it("never joins a title with a comment to manufacture a quotation", () => {
    const audit = auditIssueEvidence(
      [
        {
          kind: "logs",
          excerpt: "Crash at startup The error is ECONNREFUSED.",
        },
      ],
      issueEvidenceSources(context),
    );
    expect(audit.unverifiedCount).toBe(1);
  });

  it("keeps memory and repository policy outside the evidence sources", () => {
    const sources = issueEvidenceSources({
      ...context,
      repoMemory: "All users lose data",
      repoRules: "Everything is critical",
    });
    const audit = auditIssueEvidence(
      [{ kind: "data_loss", excerpt: "All users lose data" }],
      sources,
    );
    expect(audit.verifiedCount).toBe(0);
  });

  it("rejects trivial short excerpts that cannot support a high grade", () => {
    const audit = auditIssueEvidence(
      [{ kind: "security_path", excerpt: "app" }],
      issueEvidenceSources(context),
    );
    expect(audit.verifiedCount).toBe(0);
  });

  it("can locate both a comment and a preloaded code line", () => {
    const audit = auditIssueEvidence(
      [
        { kind: "logs", excerpt: "The error is ECONNREFUSED." },
        { kind: "security_path", excerpt: "start(config.port);" },
      ],
      issueEvidenceSources(context),
    );
    expect(audit.matches[0]?.source?.kind).toBe("comment");
    expect(audit.matches[1]?.source).toEqual({
      kind: "file",
      key: "src/app.ts",
      line: 2,
    });
  });

  it("report mode leaves the original grade and object untouched", () => {
    const analysis = applyGradingRules(result);
    const checked = groundIssueAnalysis(analysis, context);
    expect(checked.analysis).toBe(analysis);
    expect(checked.audit.unverifiedCount).toBe(1);
    expect(analysis.result.severity).toBe("S0");
  });

  it("enforce mode regrades when invented evidence was the only justification", () => {
    const analysis = applyGradingRules(result);
    const checked = groundIssueAnalysis(analysis, context, { mode: "enforce" });
    expect(checked.analysis.result.evidence).toEqual([]);
    expect(checked.analysis.result.severity).toBe("unknown");
    expect(checked.analysis.result.priority).toBe("needs_triage");
    expect(analysis.result.evidence).toHaveLength(1);
  });

  it("preserves a grade supported by an actual quote", () => {
    const analysis = applyGradingRules({
      ...result,
      evidence: [{ kind: "reproduction_steps", excerpt: "2. Start the app." }],
    });
    const checked = groundIssueAnalysis(analysis, context, { mode: "enforce" });
    expect(checked.analysis.result.severity).toBe("S0");
    expect(checked.audit.unverifiedCount).toBe(0);
  });

  it.each([0, -1, 2001, 1.5, NaN, Infinity])(
    "rejects an invalid minimum length: %s",
    (minimum) => {
      expect(() => auditIssueEvidence([], [], minimum)).toThrow(
        "minimumExcerptLength",
      );
    },
  );
});
