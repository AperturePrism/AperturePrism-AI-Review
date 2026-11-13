/**
 * 测试影响：从真实导入关系和同名测试推导建议检查的测试文件。
 * 调用：selectAffectedTests(graph, ["src/db.ts"], { runner: "vitest" })。
 * 结果只给出建议与依据；不会执行仓库脚本，也不把没选中的测试称为无关。
 */
import { posix } from "node:path";
import { affectedImportPaths, type ImportGraph } from "./imports.js";
import { matchPath, normalizeReviewPath } from "./utils/path.js";

export type TestMapping = {
  source: string;
  tests: readonly string[];
  reason: string;
};
export type AffectedTest = {
  path: string;
  reason:
    | "changed_test"
    | "imports_changed_code"
    | "same_name"
    | "configured_mapping";
  chain: readonly string[];
  confidence: "direct" | "inferred";
};
export type TestImpact = {
  selected: readonly AffectedTest[];
  unassignedSources: readonly string[];
  totalKnownTests: number;
  graphComplete: boolean;
  warnings: readonly string[];
  commands: readonly {
    program: string;
    args: readonly string[];
    description: string;
  }[];
};

/** 常见命名只用来建议，不因为名字像测试就断言它一定能被某个 runner 运行。 */
export function isTestPath(path: string): boolean {
  return (
    /(^|\/)(__tests__|tests?|specs?)(\/|$)/u.test(path) ||
    /\.(test|spec)\.[^.]+$/u.test(path) ||
    /(_test\.go|(^|\/)test_[^/]+\.py|[^/]+_spec\.rb)$/u.test(path)
  );
}

/** 忽略扩展名和常见测试前后缀，供同名文件的保守匹配。 */
function testStem(path: string): string {
  return posix
    .basename(path)
    .replace(/\.[^.]+$/u, "")
    .replace(/\.(test|spec)$/u, "")
    .replace(/^test_/u, "")
    .replace(/_(test|spec)$/u, "");
}

/** 选择受影响测试时每条都有可解释的原因和最短依赖链。 */
export function selectAffectedTests(
  graph: ImportGraph,
  changedPaths: readonly string[],
  options: {
    mappings?: readonly TestMapping[];
    runner?: "vitest" | "jest" | "pytest" | "go" | "none";
    maxDepth?: number;
  } = {},
): TestImpact {
  const changed = [...new Set(changedPaths.map(normalizeReviewPath))];
  const knownTests = graph.nodes.map((node) => node.path).filter(isTestPath);
  const impacted = affectedImportPaths(graph, changed, options.maxDepth ?? 20);
  const byPath = new Map<string, AffectedTest>();
  const coveredSources = new Set<string>();
  for (const entry of impacted) {
    if (!isTestPath(entry.path)) continue;
    byPath.set(entry.path, {
      path: entry.path,
      reason: entry.depth === 0 ? "changed_test" : "imports_changed_code",
      chain: entry.chain,
      confidence: "direct",
    });
    for (const source of entry.chain) coveredSources.add(source);
  }
  for (const source of changed.filter((path) => !isTestPath(path))) {
    for (const test of knownTests) {
      if (testStem(test) !== testStem(source)) continue;
      if (!byPath.has(test))
        byPath.set(test, {
          path: test,
          reason: "same_name",
          chain: [source, test],
          confidence: "inferred",
        });
      coveredSources.add(source);
    }
    for (const mapping of options.mappings ?? []) {
      if (!matchPath(mapping.source, source)) continue;
      for (const test of knownTests.filter((path) =>
        mapping.tests.some((pattern) => matchPath(pattern, path)),
      )) {
        if (!byPath.has(test))
          byPath.set(test, {
            path: test,
            reason: "configured_mapping",
            chain: [source, test],
            confidence: "inferred",
          });
        coveredSources.add(source);
      }
    }
  }
  const selected = [...byPath.values()].sort(
    (left, right) =>
      Number(right.confidence === "direct") -
        Number(left.confidence === "direct") ||
      left.path.localeCompare(right.path),
  );
  const unassignedSources = changed.filter(
    (path) => !isTestPath(path) && !coveredSources.has(path),
  );
  const warnings: string[] = [];
  if (!graph.complete) warnings.push("依赖图不完整，建议测试不能替代完整回归");
  if (unassignedSources.length)
    warnings.push(
      `${unassignedSources.length} 个修改文件没有找到直接关联的测试`,
    );
  if (!knownTests.length)
    warnings.push("当前源码快照没有测试文件；不能据此断言仓库没有测试");
  return {
    selected,
    unassignedSources,
    totalKnownTests: knownTests.length,
    graphComplete: graph.complete,
    warnings,
    commands: testCommands(selected, options.runner ?? "none"),
  };
}

/** 以 argv 返回命令，调用方不能把带空格或符号的文件名拼成 shell 字符串。 */
function testCommands(
  tests: readonly AffectedTest[],
  runner: "vitest" | "jest" | "pytest" | "go" | "none",
): TestImpact["commands"] {
  if (!tests.length || runner === "none") return [];
  if (runner === "vitest" || runner === "jest") {
    const paths = tests
      .filter((test) => /\.[cm]?[jt]sx?$/u.test(test.path))
      .map((test) => `./${test.path}`);
    return paths.length
      ? [
          {
            program: "npx",
            args: [
              runner,
              ...(runner === "vitest" ? ["run"] : ["--runInBand"]),
              ...paths,
            ],
            description:
              "运行选中的 JavaScript/TypeScript 测试；执行前确认仓库脚本可信",
          },
        ]
      : [];
  }
  if (runner === "pytest") {
    const paths = tests
      .filter((test) => test.path.endsWith(".py"))
      .map((test) => `./${test.path}`);
    return paths.length
      ? [
          {
            program: "python",
            args: ["-m", "pytest", "--", ...paths],
            description: "运行选中的 Python 测试",
          },
        ]
      : [];
  }
  const packages = [
    ...new Set(
      tests
        .filter((test) => test.path.endsWith("_test.go"))
        .map((test) => `./${posix.dirname(test.path)}`),
    ),
  ];
  return packages.length
    ? [
        {
          program: "go",
          args: ["test", ...packages],
          description: "Go 按包运行测试，不能只传一个 _test.go 文件",
        },
      ]
    : [];
}
