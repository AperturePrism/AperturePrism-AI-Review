/**
 * 变更影响主线：依赖图 → 反向影响 → 相关测试 → 契约候选 → 依赖清单变更。
 * 调用：analyzeChangeIntelligence(diff, { sources: snapshots, sourceChanges: [...] })。
 * 默认可用预读的少量源码启动；结果始终说明这是快照范围，不能替代完整构建。
 */
import type { ParsedDiff } from "./diff.js";
import {
  buildImportGraph,
  affectedImportPaths,
  importCycles,
  type ImportGraph,
  type ImportGraphOptions,
  type SourceSnapshot,
} from "./imports.js";
import {
  selectAffectedTests,
  type TestImpact,
  type TestMapping,
} from "./tests.js";
import { analyzeChangeContracts, type ChangeContracts } from "./contracts.js";
import {
  comparePackageDependencies,
  type PackageDependencyChanges,
} from "./dependencies.js";

export type SourceChange = { path: string; before: string; after: string };
export type ChangeIntelligenceOptions = {
  sources?: readonly SourceSnapshot[];
  sourceChanges?: readonly SourceChange[];
  imports?: ImportGraphOptions;
  testMappings?: readonly TestMapping[];
  testRunner?: "vitest" | "jest" | "pytest" | "go" | "none";
};
export type ChangeIntelligence = {
  graph: ImportGraph;
  affectedPaths: ReturnType<typeof affectedImportPaths>;
  cycles: readonly (readonly string[])[];
  tests: TestImpact;
  contracts: ChangeContracts;
  dependencies: readonly { path: string; changes: PackageDependencyChanges }[];
  snapshotFiles: number;
  changedFilesWithSnapshot: number;
  warnings: readonly string[];
};

/** 接收调用方已经读取的内容，不从审查服务的本机路径擅自读取仓库。 */
export function analyzeChangeIntelligence(
  diff: ParsedDiff,
  options: ChangeIntelligenceOptions = {},
): ChangeIntelligence {
  const sources = options.sources ?? [];
  const graph = buildImportGraph(sources, options.imports);
  const changedPaths = diff.files
    .map((file) =>
      file.newPath === "/dev/null"
        ? (file.oldPath ?? file.newPath)
        : file.newPath,
    )
    .filter((path) => path !== "/dev/null");
  const affectedPaths = affectedImportPaths(graph, changedPaths);
  const tests = selectAffectedTests(graph, changedPaths, {
    ...(options.testMappings ? { mappings: options.testMappings } : {}),
    ...(options.testRunner ? { runner: options.testRunner } : {}),
  });
  const contracts = analyzeChangeContracts(diff);
  const dependencies = (options.sourceChanges ?? [])
    .filter((change) => /(^|\/)package\.json$/u.test(change.path))
    .map((change) => ({
      path: change.path,
      changes: comparePackageDependencies(change.before, change.after),
    }));
  const snapshots = new Set(sources.map((source) => source.path));
  const changedFilesWithSnapshot = changedPaths.filter((path) =>
    snapshots.has(path),
  ).length;
  const warnings = [...tests.warnings];
  warnings.push(
    "依赖与测试影响仅覆盖调用方提供的源码快照，不代表整个仓库的完整依赖图",
  );
  if (changedFilesWithSnapshot < changedPaths.length)
    warnings.push(
      `${changedPaths.length - changedFilesWithSnapshot} 个变更文件没有完整源码快照`,
    );
  if (graph.warnings.length)
    warnings.push(`${graph.warnings.length} 处静态依赖关系未能完整解析`);
  return {
    graph,
    affectedPaths,
    cycles: importCycles(graph),
    tests,
    contracts,
    dependencies,
    snapshotFiles: sources.length,
    changedFilesWithSnapshot,
    warnings: [...new Set(warnings)],
  };
}
