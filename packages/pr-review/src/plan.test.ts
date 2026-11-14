/** 分块、覆盖和风险回归：验证预算边界与不丢行的计划。 */
import { describe, expect, it } from "vitest";
import {
  buildReviewPlan,
  completedPlanCoverage,
  estimateReviewTokens,
} from "./plan.js";
import { parseReviewPolicy } from "./policy.js";
import { parseUnifiedDiff, type ParsedDiff } from "./diff.js";
import { measureReviewCoverage } from "./coverage.js";
import { renderDiffForModel, renderHunksText } from "./context.js";
import { analyzeChangeRisk } from "./risk.js";

function diffFiles(paths: readonly string[], lines = 4): ParsedDiff {
  return parseUnifiedDiff(
    paths
      .map(
        (path) =>
          `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n${Array.from({ length: lines }, (_, index) => "+" + `const value${index} = '${path}';`).join("\n")}\n`,
      )
      .join(""),
  );
}

describe("review planning", () => {
  it("prioritizes sensitive code ahead of larger documentation", () => {
    const diff = diffFiles(["README.md", "src/auth.ts"]);
    const plan = buildReviewPlan(diff, parseReviewPolicy());
    expect(plan.chunks[0]?.files[0]).toBe("src/auth.ts");
    expect(plan.includedChangedLines).toBe(8);
  });

  it("splits a hunk without losing or duplicating any changed line", () => {
    const diff = diffFiles(["src/app.ts"], 150);
    const plan = buildReviewPlan(
      diff,
      parseReviewPolicy({ maxChunkTokens: 256 }),
    );
    expect(plan.chunks.length).toBeGreaterThan(1);
    expect(
      plan.chunks.reduce((sum, chunk) => sum + chunk.changedLines, 0),
    ).toBe(150);
    expect(plan.chunks.every((chunk) => chunk.estimatedTokens <= 256)).toBe(
      true,
    );
    for (let line = 1; line <= 150; line += 1) {
      expect(
        plan.chunks.filter((chunk) => chunk.text.includes(`+${line}| `)),
      ).toHaveLength(1);
    }
  });

  it("does not put more files than allowed in one chunk", () => {
    const plan = buildReviewPlan(
      diffFiles(["a.ts", "b.ts", "c.ts"]),
      parseReviewPolicy({ maxChunkFiles: 1 }),
    );
    expect(plan.chunks).toHaveLength(3);
    expect(plan.chunks.every((chunk) => chunk.files.length === 1)).toBe(true);
  });

  it("records exclusions and generated files explicitly", () => {
    const plan = buildReviewPlan(
      diffFiles(["src/app.ts", "generated/api.ts", "private/data.ts"]),
      parseReviewPolicy({ exclude: ["private/**"] }),
    );
    expect(
      plan.files.find((file) => file.path === "generated/api.ts")?.disposition,
    ).toBe("generated");
    expect(
      plan.files.find((file) => file.path === "private/data.ts")?.disposition,
    ).toBe("excluded");
    expect(plan.includedChangedLines).toBe(4);
    expect(plan.excludedChangedLines).toBe(8);
  });

  it("counts completed chunk IDs only once", () => {
    const plan = buildReviewPlan(
      diffFiles(["a.ts", "b.ts"]),
      parseReviewPolicy({ maxChunkFiles: 1 }),
    );
    const first = plan.chunks[0]!.id;
    const coverage = completedPlanCoverage(plan, [
      first,
      first,
      "does-not-exist",
    ]);
    expect(coverage.completedChunks).toBe(1);
    expect(coverage.ratio).toBe(0.5);
  });

  it("keeps a large indivisible source line and warns about the limit", () => {
    const diff = parseUnifiedDiff(
      `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+${"x".repeat(2_000)}\n`,
    );
    const plan = buildReviewPlan(
      diff,
      parseReviewPolicy({ maxChunkTokens: 256 }),
    );
    expect(plan.chunks[0]?.changedLines).toBe(1);
    expect(plan.warnings.some((warning) => warning.includes("单行"))).toBe(
      true,
    );
  });

  it("uses a higher estimate for Chinese characters than ASCII source", () => {
    expect(estimateReviewTokens("中文测试")).toBeGreaterThan(
      estimateReviewTokens("test"),
    );
  });
});

describe("actual input coverage", () => {
  it("measures exactly the lines retained after head/tail truncation", () => {
    const context = renderDiffForModel(diffFiles(["src/app.ts"], 10), {
      maxTokens: 12_000,
      maxInlineFiles: 10,
      maxLinesPerFile: 3,
    });
    const coverage = measureReviewCoverage(context);
    expect(coverage.visibleChangedLines).toBe(3);
    expect(coverage.changedLineRatio).toBe(0.3);
    expect(coverage.partialFiles).toBe(1);
    const rendered = renderHunksText(context);
    expect(rendered).toContain("+1| ");
    expect(rendered).toContain("+10| ");
    expect(rendered).not.toContain("+5| ");
  });

  it("honors the aggregate diff token budget", () => {
    const context = renderDiffForModel(
      diffFiles(["src/a.ts", "src/b.ts", "src/c.ts"], 20),
      { maxTokens: 70, maxInlineFiles: 10, maxLinesPerFile: 40 },
    );
    expect(context.degraded).toContain("diff_token_budget_reached");
    expect(measureReviewCoverage(context).visibleChangedLines).toBeLessThan(60);
    expect(
      estimateReviewTokens(renderHunksText(context).split("其他变更文件")[0]!),
    ).toBeLessThan(90);
  });

  it("a zero line budget does not accidentally expose the whole file", () => {
    const context = renderDiffForModel(diffFiles(["src/a.ts"]), {
      maxTokens: 12_000,
      maxInlineFiles: 10,
      maxLinesPerFile: 0,
    });
    expect(measureReviewCoverage(context).visibleChangedLines).toBe(0);
    expect(renderHunksText(context)).not.toContain("const value");
  });

  it("rejects negative and fractional budgets", () => {
    expect(() =>
      renderDiffForModel(diffFiles(["a.ts"]), {
        maxTokens: -1,
        maxInlineFiles: 1,
        maxLinesPerFile: 1,
      }),
    ).toThrow();
    expect(() =>
      renderDiffForModel(diffFiles(["a.ts"]), {
        maxTokens: 100,
        maxInlineFiles: 1.5,
        maxLinesPerFile: 1,
      }),
    ).toThrow();
  });
});

describe("risk explanation", () => {
  it("identifies source, tests, migration and sensitive files without claiming a vulnerability", () => {
    const risk = analyzeChangeRisk(
      diffFiles([
        "src/main.ts",
        "src/main.test.ts",
        "migrations/001.sql",
        "src/auth.ts",
      ]),
      parseReviewPolicy(),
    );
    expect(risk.files.map((file) => file.kind)).toEqual([
      "source",
      "test",
      "migration",
      "source",
    ]);
    expect(risk.files[3]?.reasons[0]?.code).toBe("sensitive_path");
    expect(risk.files[2]?.reasons[0]?.code).toBe("persistent_data");
    expect(risk.testToSourceRatio).toBe(0.5);
  });

  it("lets a repository identify its own sensitive paths", () => {
    const risk = analyzeChangeRisk(
      diffFiles(["src/business/ledger.ts"]),
      parseReviewPolicy({ sensitivePaths: ["src/business/**"] }),
    );
    expect(risk.files[0]?.securitySensitive).toBe(true);
  });
});
