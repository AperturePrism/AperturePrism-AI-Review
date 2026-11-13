/** 依赖图回归：支持的导入语法、路径解析、循环和不完整信号。 */
import { describe, expect, it } from "vitest";
import {
  affectedImportPaths,
  buildImportGraph,
  importCycles,
} from "./imports.js";

const common = [
  { path: "src/db.ts", content: "export const db = 1;" },
  {
    path: "src/api.ts",
    content: "import { db } from './db.js'; export { db };",
  },
  { path: "tests/api.test.ts", content: "import '../src/api';" },
];

describe("source import graph", () => {
  it("resolves emitted JavaScript specifiers to source TypeScript", () => {
    const graph = buildImportGraph(common);
    expect(
      graph.edges.find((edge) => edge.source === "src/api.ts"),
    ).toMatchObject({
      target: "src/db.ts",
      resolution: "resolved",
      kind: "static",
    });
    expect(graph.complete).toBe(true);
  });

  it("ignores imports written inside comments and ordinary strings", () => {
    const graph = buildImportGraph([
      {
        path: "src/a.ts",
        content: `// import './fake';\nconst text = "import './also-fake'";\n/* require('./other') */\nimport './b';`,
      },
      { path: "src/b.ts", content: "export {};" },
    ]);
    expect(graph.edges.map((edge) => edge.specifier)).toEqual(["./b"]);
  });

  it("supports static, re-export, literal dynamic and require imports", () => {
    const graph = buildImportGraph([
      {
        path: "a.ts",
        content: `export { value } from './b';\nconst load = () => import('./b');\nconst other = require('./b');\nimport './b';`,
      },
      { path: "b.ts", content: "export const value = 1;" },
    ]);
    expect(graph.edges.map((edge) => edge.kind)).toEqual([
      "static",
      "dynamic",
      "require",
      "static",
    ]);
    expect(graph.edges.every((edge) => edge.target === "b.ts")).toBe(true);
  });

  it("marks dynamic import expressions as incomplete", () => {
    const graph = buildImportGraph([
      {
        path: "a.ts",
        content:
          "const x = import(moduleName); const y = import(`./${target}`);",
      },
    ]);
    expect(graph.edges).toEqual([]);
    expect(graph.complete).toBe(false);
    expect(graph.warnings).toHaveLength(2);
  });

  it("resolves directory indexes and explicit aliases", () => {
    const graph = buildImportGraph(
      [
        { path: "src/a.ts", content: "import '@/db';" },
        { path: "src/db/index.ts", content: "export {};" },
      ],
      { aliases: { "@/": "src/" } },
    );
    expect(graph.edges[0]?.target).toBe("src/db/index.ts");
  });

  it("distinguishes external packages from missing relative imports", () => {
    const graph = buildImportGraph([
      { path: "src/a.ts", content: "import 'react'; import './missing';" },
    ]);
    expect(graph.edges[0]?.resolution).toBe("external");
    expect(graph.edges[1]?.resolution).toBe("unresolved");
    expect(graph.complete).toBe(false);
  });

  it("reads Python absolute and relative module dependencies", () => {
    const graph = buildImportGraph([
      {
        path: "app/api.py",
        content:
          "from .db import query\nimport requests\nfrom app.helpers import run\n",
      },
      { path: "app/db.py", content: "def query(): pass" },
      { path: "app/helpers.py", content: "def run(): pass" },
    ]);
    expect(graph.edges.find((edge) => edge.specifier === ".db")?.target).toBe(
      "app/db.py",
    );
    expect(
      graph.edges.find((edge) => edge.specifier === "requests")?.resolution,
    ).toBe("external");
    expect(
      graph.edges.find((edge) => edge.specifier === "app.helpers")?.target,
    ).toBe("app/helpers.py");
  });

  it("reads Go import blocks without interpreting aliases as paths", () => {
    const graph = buildImportGraph([
      {
        path: "main.go",
        content:
          'package main\nimport (\n "fmt"\n alias "example.com/client"\n)\n',
      },
    ]);
    expect(graph.edges.map((edge) => edge.specifier)).toEqual([
      "fmt",
      "example.com/client",
    ]);
    expect(graph.edges.every((edge) => edge.resolution === "external")).toBe(
      true,
    );
  });

  it("reads Rust module declarations and crate dependencies", () => {
    const graph = buildImportGraph([
      { path: "src/lib.rs", content: "mod db; use crate::db;" },
      { path: "src/db.rs", content: "pub fn query() {}" },
    ]);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges.every((edge) => edge.target === "src/db.rs")).toBe(true);
  });

  it("tracks the shortest reverse dependency chain", () => {
    const affected = affectedImportPaths(buildImportGraph(common), [
      "src/db.ts",
    ]);
    expect(affected).toEqual([
      { path: "src/db.ts", depth: 0, chain: ["src/db.ts"] },
      { path: "src/api.ts", depth: 1, chain: ["src/db.ts", "src/api.ts"] },
      {
        path: "tests/api.test.ts",
        depth: 2,
        chain: ["src/db.ts", "src/api.ts", "tests/api.test.ts"],
      },
    ]);
  });

  it("respects traversal depth without looping forever", () => {
    const graph = buildImportGraph([
      { path: "a.ts", content: "import './b';" },
      { path: "b.ts", content: "import './a';" },
      { path: "c.ts", content: "import './b';" },
    ]);
    expect(
      affectedImportPaths(graph, ["a.ts"], 1).map((entry) => entry.path),
    ).toEqual(["a.ts", "b.ts"]);
    expect(importCycles(graph)).toEqual([["a.ts", "b.ts"]]);
  });

  it("does not overflow the call stack on a long dependency chain", () => {
    const graph = buildImportGraph(
      Array.from({ length: 3_000 }, (_, index) => ({
        path: `f${index}.ts`,
        content: index === 2_999 ? "export {};" : `import './f${index + 1}';`,
      })),
    );
    expect(importCycles(graph)).toEqual([]);
    expect(affectedImportPaths(graph, ["f2999.ts"], 1_000)).toHaveLength(1_001);
  });

  it("records unsupported or oversized files as incomplete", () => {
    const graph = buildImportGraph(
      [
        { path: "readme.md", content: "# hello" },
        { path: "a.ts", content: "export const x = 1;" },
      ],
      { maxFileBytes: 10 },
    );
    expect(graph.complete).toBe(false);
    expect(graph.nodes.every((node) => !node.parsed)).toBe(true);
  });

  it("rejects duplicates, traversal and excessive input before parsing", () => {
    expect(() => buildImportGraph([common[0]!, common[0]!])).toThrow(
      "重复路径",
    );
    expect(() =>
      buildImportGraph([{ path: "../x.ts", content: "" }]),
    ).toThrow();
    expect(() => buildImportGraph(common, { maxFiles: 1 })).toThrow("文件数");
  });
});
