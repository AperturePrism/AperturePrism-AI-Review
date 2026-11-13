/** 变更影响回归：从快照到受影响测试与契约检查的完整路径。 */
import { describe, expect, it } from "vitest";
import { analyzeChangeIntelligence } from "./intelligence.js";
import { comparePackageDependencies } from "./dependencies.js";
import { selectAffectedTests } from "./tests.js";
import { buildImportGraph } from "./imports.js";
import { analyzeChangeContracts } from "./contracts.js";
import { parseUnifiedDiff } from "./diff.js";

const diff = parseUnifiedDiff(`diff --git a/src/db.ts b/src/db.ts
--- a/src/db.ts
+++ b/src/db.ts
@@ -1 +1 @@
-export function query(id: number) { return id; }
+export function query(id: string) { return id; }
`);
const sources = [
  {
    path: "src/db.ts",
    content: "export function query(id: string) { return id; }",
  },
  {
    path: "src/api.ts",
    content: "import { query } from './db'; export const api = query;",
  },
  { path: "tests/api.test.ts", content: "import '../src/api';" },
];

describe("change intelligence", () => {
  it("connects a source change to dependent tests and a contract candidate", () => {
    const result = analyzeChangeIntelligence(diff, {
      sources,
      testRunner: "vitest",
    });
    expect(result.tests.selected[0]).toMatchObject({
      path: "tests/api.test.ts",
      reason: "imports_changed_code",
      confidence: "direct",
    });
    expect(result.tests.commands[0]?.args).toEqual([
      "vitest",
      "run",
      "./tests/api.test.ts",
    ]);
    expect(result.contracts.observations[0]).toMatchObject({
      kind: "export",
      name: "query",
      action: "changed",
      risk: "check_compatibility",
    });
    expect(result.changedFilesWithSnapshot).toBe(1);
    expect(
      result.warnings.some((warning) => warning.includes("源码快照")),
    ).toBe(true);
  });

  it("does not invent tests when the snapshot contains no tests", () => {
    const result = analyzeChangeIntelligence(diff, {
      sources: sources.slice(0, 2),
    });
    expect(result.tests.selected).toEqual([]);
    expect(result.tests.unassignedSources).toContain("src/db.ts");
    expect(
      result.tests.warnings.some((warning) => warning.includes("不能据此断言")),
    ).toBe(true);
  });

  it("uses same-name tests only as inferred suggestions", () => {
    const graph = buildImportGraph([
      { path: "src/db.ts", content: "export {};" },
      { path: "tests/db.test.ts", content: "test('db', () => {});" },
    ]);
    const result = selectAffectedTests(graph, ["src/db.ts"]);
    expect(result.selected[0]).toMatchObject({
      reason: "same_name",
      confidence: "inferred",
    });
  });

  it("accepts explicit source-to-test mappings", () => {
    const graph = buildImportGraph([
      { path: "src/db.ts", content: "export {};" },
      { path: "integration/storage.test.ts", content: "export {};" },
    ]);
    const result = selectAffectedTests(graph, ["src/db.ts"], {
      mappings: [
        {
          source: "src/db*",
          tests: ["integration/**"],
          reason: "存储集成覆盖",
        },
      ],
    });
    expect(result.selected[0]?.reason).toBe("configured_mapping");
  });

  it("keeps test commands as argument arrays, including filenames with spaces", () => {
    const graph = buildImportGraph([
      { path: "tests/name with space.test.ts", content: "export {};" },
    ]);
    const result = selectAffectedTests(
      graph,
      ["tests/name with space.test.ts"],
      { runner: "vitest" },
    );
    expect(result.commands[0]?.args.at(-1)).toBe(
      "./tests/name with space.test.ts",
    );
  });

  it("runs Go tests by package rather than a single file", () => {
    const graph = buildImportGraph([
      { path: "pkg/db/db_test.go", content: "package db" },
    ]);
    const result = selectAffectedTests(graph, ["pkg/db/db_test.go"], {
      runner: "go",
    });
    expect(result.commands[0]).toMatchObject({
      program: "go",
      args: ["test", "./pkg/db"],
    });
  });
});

describe("contract observations", () => {
  it("does not report a moved identical export as a changed signature", () => {
    const moved = parseUnifiedDiff(
      `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-export const x = 1;\n+export const x = 1;\n`,
    );
    expect(analyzeChangeContracts(moved).observations).toEqual([]);
  });

  it("shows destructive SQL as an explicit human review requirement", () => {
    const migration = parseUnifiedDiff(
      `diff --git a/migrations/drop.sql b/migrations/drop.sql\n--- a/migrations/drop.sql\n+++ b/migrations/drop.sql\n@@ -0,0 +1 @@\n+DROP TABLE accounts;\n`,
    );
    const result = analyzeChangeContracts(migration);
    expect(result.destructiveChanges).toBe(1);
    expect(result.observations[0]).toMatchObject({
      name: "accounts",
      risk: "destructive",
    });
    expect(result.compatibilityChecks[0]).toContain("回滚");
  });

  it("tracks route removal and environment introduction", () => {
    const change = parseUnifiedDiff(
      `diff --git a/server.ts b/server.ts\n--- a/server.ts\n+++ b/server.ts\n@@ -1 +1 @@\n-app.get('/legacy', oldHandler);\n+const token = process.env.API_TOKEN;\n`,
    );
    const result = analyzeChangeContracts(change);
    expect(result.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "http_route",
          name: "GET /legacy",
          action: "removed",
        }),
        expect.objectContaining({
          kind: "environment",
          name: "API_TOKEN",
          action: "added",
        }),
      ]),
    );
  });
});

describe("dependency changes", () => {
  it("separates upgrades, additions and removals by dependency section", () => {
    const result = comparePackageDependencies(
      JSON.stringify({ dependencies: { a: "^1.0.0", old: "1.0.0" } }),
      JSON.stringify({ dependencies: { a: "^2.0.0", fresh: "1.0.0" } }),
    );
    expect(result.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "a",
          action: "updated",
          majorChange: true,
        }),
        expect.objectContaining({ name: "old", action: "removed" }),
        expect.objectContaining({ name: "fresh", action: "added" }),
      ]),
    );
  });

  it("distinguishes explicit package sources and floating versions", () => {
    const result = comparePackageDependencies(
      "{}",
      JSON.stringify({
        dependencies: {
          git: "github:owner/repo#main",
          url: "https://example.com/pkg.tgz",
          local: "file:../pkg",
          floating: "latest",
          workspace: "workspace:*",
          alias: "npm:other@1.0.0",
        },
      }),
    );
    expect(
      result.changes.find((change) => change.name === "git")?.warnings[0],
    ).toContain("SHA");
    expect(
      result.changes.find((change) => change.name === "local")?.source,
    ).toBe("local");
    expect(
      result.changes.find((change) => change.name === "floating")?.warnings[0],
    ).toContain("浮动");
    expect(
      result.changes.find((change) => change.name === "alias")?.source,
    ).toBe("alias");
  });

  it("exposes lifecycle and runtime changes without executing them", () => {
    const result = comparePackageDependencies(
      "{}",
      JSON.stringify({
        scripts: { postinstall: "node setup.js" },
        engines: { node: ">=22" },
        packageManager: "npm@11",
      }),
    );
    expect(result.scripts[0]).toMatchObject({
      name: "postinstall",
      installLifecycle: true,
    });
    expect(result.runtimeChanges.map((item) => item.field)).toEqual([
      "packageManager",
      "engines.node",
    ]);
    expect(
      result.reviewChecks.some((check) => check.includes("生命周期")),
    ).toBe(true);
  });

  it("does not guess semantic version changes for complex ranges", () => {
    const result = comparePackageDependencies(
      '{"dependencies":{"a":">=1 <3"}}',
      '{"dependencies":{"a":">=2 <4"}}',
    );
    expect(result.changes[0]?.majorChange).toBeNull();
  });

  it("rejects invalid manifests instead of silently dropping dependencies", () => {
    expect(() => comparePackageDependencies("broken", "{}")).toThrow("JSON");
    expect(() =>
      comparePackageDependencies("{}", '{"dependencies":{"a":22}}'),
    ).toThrow("依赖字段");
  });
});
