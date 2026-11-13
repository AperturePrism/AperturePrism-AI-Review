import { describe, expect, it } from "vitest";
import { classifyPrSize, renderDiffForModel, renderHunksText } from "./context.js";
import { parseUnifiedDiff } from "./diff.js";

describe("classifyPrSize", () => {
  it("classifies small, medium, large and oversized", () => {
    expect(classifyPrSize(3, 120, 40)).toBe("small");
    expect(classifyPrSize(10, 200, 50)).toBe("medium");
    expect(classifyPrSize(25, 800, 100)).toBe("large");
    expect(classifyPrSize(2, 6_000, 0)).toBe("oversized");
  });
});

describe("renderDiffForModel", () => {
  function makeDiff(fileCount: number, linesPerFile: number) {
    let text = "";
    for (let f = 0; f < fileCount; f += 1) {
      text += `diff --git a/src/f${f}.ts b/src/f${f}.ts\n--- a/src/f${f}.ts\n+++ b/src/f${f}.ts\n@@ -1,${linesPerFile} +1,${linesPerFile} @@\n`;
      for (let i = 0; i < linesPerFile; i += 1) text += `+line ${f}-${i}\n`;
    }
    return parseUnifiedDiff(text);
  }

  it("inlines files up to the cap and lists the rest by name", () => {
    const diff = makeDiff(30, 5);
    const ctx = renderDiffForModel(diff, { maxInlineFiles: 25, maxLinesPerFile: 400, maxTokens: 12000 });
    expect(ctx.keptFiles).toHaveLength(25);
    expect(ctx.listedFiles.length + ctx.keptFiles.length).toBe(30);
    expect(ctx.degraded).toContain("some_files_listed_only");
  });

  it("flags large files for head+tail rendering", () => {
    const diff = makeDiff(3, 500);
    const ctx = renderDiffForModel(diff, { maxInlineFiles: 25, maxLinesPerFile: 400, maxTokens: 12000 });
    expect(ctx.degraded).toContain("large_file_head_tail_only");
  });
});

it("enforces the diff token ceiling even for very long source lines", () => {
  const diff = parseUnifiedDiff(`diff --git a/data.ts b/data.ts\n--- a/data.ts\n+++ b/data.ts\n@@ -0,0 +1,2 @@\n+${"a".repeat(2000)}\n+tail\n`);
  const budget = { maxInlineFiles: 25, maxLinesPerFile: 400, maxTokens: 100 };
  const context = renderDiffForModel(diff, budget);
  const text = renderHunksText(context);
  expect(text.length).toBeLessThanOrEqual(budget.maxTokens * 4);
  expect(text).toContain("token_budget_exceeded");
  expect(context.degraded).toContain("token_budget_exceeded");
  expect(text.split("\n").filter((line) => line === "```")).toHaveLength(2);
});

it("retains a custom diff budget when the prompt renders it later", () => {
  const diff = parseUnifiedDiff(`diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,3 @@\n+first\n+middle\n+last\n`);
  const context = renderDiffForModel(diff, {
    maxInlineFiles: 1,
    maxLinesPerFile: 2,
    maxTokens: 100,
  });
  expect(renderHunksText(context)).toContain("+first\n…\n+last");
  expect(renderHunksText(context)).not.toContain("middle");
});
