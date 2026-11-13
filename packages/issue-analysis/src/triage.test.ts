import { describe, expect, it } from "vitest";
import type { IssueContext } from "./context.js";
import {
  assessIssueTriage,
  issueTriageText,
  renderIssueTriage,
} from "./triage.js";

function context(body: string): IssueContext {
  return {
    repository: { owner: "example", name: "project" },
    installationId: "1",
    issue: {
      number: 1,
      title: "Application issue",
      body,
      state: "open",
      htmlUrl: "https://github.test/example/project/issues/1",
      author: "reporter",
      createdAt: "2026-11-13T00:00:00Z",
      updatedAt: "2026-11-13T00:00:00Z",
      labels: [],
    },
    comments: [],
    images: [],
    degraded: [],
    estimatedTokens: 100,
  };
}

describe("explainable issue triage", () => {
  it("recognizes an actionable report and keeps severity out of the score", () => {
    const triage = assessIssueTriage(
      context(
        "Steps to reproduce:\n1. Start application\nExpected result: starts\nActual output: crash\nUbuntu 24.04\nVersion v1.2.3\n```text\nError: ENOENT\n```",
      ),
    );
    expect(triage.score).toBe(100);
    expect(triage.readiness).toBe("ready");
    expect(triage.missing).toEqual([]);
    expect(triage.facts.every((fact) => fact.source === "issue")).toBe(true);
  });

  it("recognizes a Chinese report", () => {
    const triage = assessIssueTriage(
      context(
        "复现步骤：先启动\n预期结果：成功\n实际结果：报错\n操作系统：Linux\n版本：1.2.3\n日志：ECONNREFUSED",
      ),
    );
    expect(triage.score).toBe(100);
  });

  it("does not count empty template sections as provided information", () => {
    const triage = assessIssueTriage(
      context(
        "### Steps to reproduce\n_No response_\n\n### Expected result\n\n### Actual output\n_No response_\n",
      ),
    );
    expect(triage.score).toBe(0);
    expect(triage.missing).toEqual(["reproduction", "expected", "actual"]);
  });

  it("does not use an HTML template instruction as report evidence", () => {
    const triage = assessIssueTriage(
      context(
        "<!-- Steps to reproduce; Expected output; Actual output; Windows 1.2.3 -->\nIt does not work",
      ),
    );
    expect(triage.score).toBe(0);
  });

  it("finds information supplied later in a comment", () => {
    const input = context("Actual output: crash");
    input.comments = [
      {
        author: "reporter",
        body: "Steps to reproduce: start app. Expected output: normal exit",
        createdAt: "2026-11-13T00:01:00Z",
      },
    ];
    const triage = assessIssueTriage(input);
    expect(triage.readiness).toBe("ready");
    expect(
      triage.facts.find((fact) => fact.field === "reproduction")?.source,
    ).toBe("comment:1");
  });

  it("routes by explicit repository rule priority with stable ties", () => {
    const input = context("Docker network times out");
    input.issue.labels = ["Backend"];
    const triage = assessIssueTriage(input, {
      rules: [
        { id: "fallback", labels: ["backend"], queue: "backend", priority: 1 },
        { id: "network", words: ["network"], queue: "network", priority: 10 },
        {
          id: "same-priority",
          words: ["Docker"],
          queue: "container",
          priority: 10,
        },
      ],
    });
    expect(triage.queue).toBe("network");
    expect(triage.matchedRules).toEqual([
      "network",
      "same-priority",
      "fallback",
    ]);
  });

  it("allows feature reports to use their own required information", () => {
    const triage = assessIssueTriage(
      context("Expected result: support another export format"),
      { requiredFields: ["expected"] },
    );
    expect(triage.readiness).toBe("ready");
  });

  it("signals sensitive content for human review without making external changes", () => {
    const triage = assessIssueTriage(
      context("I found a vulnerability that exposes a secret token"),
    );
    expect(triage.sensitive).toBe(true);
    expect(triage.queue).toBe("security-triage");
    expect(triage.warnings.join(" ")).toContain("脱敏");
  });

  it("retains the loss-of-context limitation after truncation", () => {
    const input = context("Actual output: crash");
    input.degraded = ["comments_dropped"];
    expect(assessIssueTriage(input).warnings.join(" ")).toContain("裁剪");
  });

  it("limits displayed excerpts without losing the extracted fact", () => {
    const triage = assessIssueTriage(
      context(`Actual output: ${"x".repeat(1000)}`),
      { maxExcerptChars: 30 },
    );
    const actual = triage.facts.find((fact) => fact.field === "actual");
    expect(actual?.found).toBe(true);
    expect(actual?.excerpt?.length).toBeLessThanOrEqual(30);
  });

  it("renders questions and limitations for a human without automatic actions", () => {
    const markdown = renderIssueTriage(assessIssueTriage(context("Failure")));
    expect(markdown).toContain("待补信息");
    expect(markdown).toContain("不能代替复现");
    expect(markdown).not.toContain("自动关闭");
  });

  it("keeps nonempty Markdown sections when another section is empty", () => {
    expect(
      issueTriageText(
        "### Steps to reproduce\n1. Start\n### Expected output\n_No response_\n",
      ),
    ).toContain("Steps to reproduce");
    expect(
      issueTriageText(
        "### Steps to reproduce\n1. Start\n### Expected output\n_No response_\n",
      ),
    ).not.toContain("Expected output");
  });

  it("rejects duplicate routing rules and unbounded configuration", () => {
    expect(() =>
      assessIssueTriage(context(""), {
        rules: [
          { id: "x", queue: "a", words: ["a"] },
          { id: "x", queue: "b", words: ["b"] },
        ],
      }),
    ).toThrow("unique");
    expect(() =>
      assessIssueTriage(context(""), { maxExcerptChars: Infinity }),
    ).toThrow("maxExcerptChars");
    expect(() =>
      assessIssueTriage(context(""), {
        rules: [{ id: "x", queue: "a", words: [""] }],
      }),
    ).toThrow("labels or words");
  });
});
