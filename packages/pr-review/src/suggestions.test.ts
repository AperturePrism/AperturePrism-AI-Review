/** 修复提案回归：精确应用、Unicode、过期快照和补丁可审阅性。 */
import { describe, expect, it } from "vitest";
import {
  createReviewSuggestion,
  parseReviewSuggestion,
  previewReviewSuggestion,
} from "./suggestions.js";

const sources = [
  { path: "src/a.ts", content: "const value = 1;\nconsole.log(value);\n" },
];
const input = {
  title: "更新默认值",
  explanation: "默认值由 1 改为 2，保持其余文本不变。",
  edits: [
    {
      path: "src/a.ts",
      start: { line: 1, column: 15 },
      end: { line: 1, column: 16 },
      expected: "1",
      replacement: "2",
    },
  ],
};

describe("review suggestions", () => {
  it("creates a snapshot-bound proposal and previews exact text changes", () => {
    const suggestion = createReviewSuggestion(input, sources);
    const result = previewReviewSuggestion(suggestion, sources);
    expect(result.files[0]?.after).toBe(
      "const value = 2;\nconsole.log(value);\n",
    );
    expect(result.patch).toContain("-const value = 1;");
    expect(result.patch).toContain("+const value = 2;");
    expect(sources[0]?.content).toContain("= 1;");
  });

  it("does not drift when another source edit moves the target line", () => {
    const suggestion = createReviewSuggestion(input, sources);
    expect(() =>
      previewReviewSuggestion(suggestion, [
        { ...sources[0]!, content: "// new\n" + sources[0]!.content },
      ]),
    ).toThrow("已经过期");
  });

  it("rejects incorrect expected text and out-of-bounds positions", () => {
    expect(() =>
      createReviewSuggestion(
        { ...input, edits: [{ ...input.edits[0]!, expected: "9" }] },
        sources,
      ),
    ).toThrow("前置文本");
    expect(() =>
      createReviewSuggestion(
        {
          ...input,
          edits: [{ ...input.edits[0]!, start: { line: 50, column: 1 } }],
        },
        sources,
      ),
    ).toThrow("行号");
    expect(() =>
      createReviewSuggestion(
        {
          ...input,
          edits: [{ ...input.edits[0]!, end: { line: 1, column: 200 } }],
        },
        sources,
      ),
    ).toThrow("列号");
  });

  it("rejects overlapping edits and ambiguous same-point insertions", () => {
    expect(() =>
      createReviewSuggestion(
        { ...input, edits: [input.edits[0], input.edits[0]] },
        sources,
      ),
    ).toThrow("重叠");
    const insertion = {
      ...input.edits[0]!,
      start: { line: 1, column: 1 },
      end: { line: 1, column: 1 },
      expected: "",
      replacement: "// ",
    };
    expect(() =>
      createReviewSuggestion(
        { ...input, edits: [insertion, insertion] },
        sources,
      ),
    ).toThrow("同点");
  });

  it("applies disjoint edits in reverse offset order", () => {
    const second = {
      ...input.edits[0]!,
      start: { line: 2, column: 1 },
      end: { line: 2, column: 8 },
      expected: "console",
      replacement: "logger",
    };
    const result = previewReviewSuggestion(
      createReviewSuggestion(
        { ...input, edits: [input.edits[0], second] },
        sources,
      ),
      sources,
    );
    expect(result.files[0]?.after).toBe(
      "const value = 2;\nlogger.log(value);\n",
    );
    expect(result.changedEdits).toBe(2);
  });

  it("preserves CRLF line endings and a missing final newline", () => {
    const source = [{ path: "a.txt", content: "first\r\nlast" }];
    const edit = {
      path: "a.txt",
      start: { line: 2, column: 1 },
      end: { line: 2, column: 5 },
      expected: "last",
      replacement: "next",
    };
    const result = previewReviewSuggestion(
      createReviewSuggestion({ ...input, edits: [edit] }, source),
      source,
    );
    expect(result.files[0]?.after).toBe("first\r\nnext");
    expect(result.patch).toContain("\\ No newline at end of file");
  });

  it("rejects a position in the middle of a Unicode surrogate pair", () => {
    const source = [{ path: "a.txt", content: "猫🐱尾巴" }];
    const edit = {
      path: "a.txt",
      start: { line: 1, column: 3 },
      end: { line: 1, column: 3 },
      expected: "",
      replacement: "x",
    };
    expect(() =>
      createReviewSuggestion({ ...input, edits: [edit] }, source),
    ).toThrow("Unicode");
  });

  it("rejects a modified proposal that keeps the previous ID", () => {
    const suggestion = createReviewSuggestion(input, sources);
    expect(
      parseReviewSuggestion(JSON.parse(JSON.stringify(suggestion))),
    ).toEqual(suggestion);
    suggestion.edits[0]!.replacement = "200";
    expect(() => parseReviewSuggestion(suggestion)).toThrow("ID 不一致");
  });

  it("never edits files missing from the declared snapshots", () => {
    expect(() =>
      createReviewSuggestion(
        { ...input, edits: [{ ...input.edits[0]!, path: "other.ts" }] },
        sources,
      ),
    ).toThrow("没有对应");
    expect(() =>
      createReviewSuggestion(
        { ...input, edits: [{ ...input.edits[0]!, path: "../other.ts" }] },
        sources,
      ),
    ).toThrow();
  });
});
