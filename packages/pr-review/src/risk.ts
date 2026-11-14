/**
 * 变更风险：按路径与变更规模决定审查优先级，不把启发式分数当成漏洞结论。
 * 调用：const risk = analyzeChangeRisk(parseUnifiedDiff(diff), parseReviewPolicy());
 * 每项加分都有解释；配置可调整敏感路径与生成文件路径。
 */
import type { DiffFile, ParsedDiff } from "./diff.js";
import type { ReviewPolicy } from "./policy.js";
import { matchPath } from "./utils/path.js";

export type ChangeKind =
  | "source"
  | "test"
  | "documentation"
  | "dependency"
  | "configuration"
  | "migration"
  | "generated"
  | "binary";
export type RiskBand = "low" | "medium" | "high" | "critical";
export type RiskReason = { code: string; message: string; points: number };
export type FileRisk = {
  path: string;
  kind: ChangeKind;
  language: string | null;
  score: number;
  band: RiskBand;
  reasons: readonly RiskReason[];
  additions: number;
  deletions: number;
  securitySensitive: boolean;
  reviewable: boolean;
};
export type ChangeRisk = {
  score: number;
  band: RiskBand;
  files: readonly FileRisk[];
  reasons: readonly RiskReason[];
  changedLines: number;
  sourceLines: number;
  testLines: number;
  testToSourceRatio: number | null;
  suggestedMode: "quick" | "standard" | "deep";
};

const EXTENSIONS: Readonly<Record<string, string>> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  swift: "Swift",
  c: "C",
  h: "C",
  cpp: "C++",
  hpp: "C++",
  cs: "C#",
  rb: "Ruby",
  php: "PHP",
  sh: "Shell",
  bash: "Shell",
  sql: "SQL",
  vue: "Vue",
  svelte: "Svelte",
  dart: "Dart",
  ex: "Elixir",
  exs: "Elixir",
  scala: "Scala",
  clj: "Clojure",
  lua: "Lua",
  r: "R",
  jl: "Julia",
};

/** 识别文件类型；只根据路径分类，不声称理解程序语义。 */
export function classifyChangedFile(
  file: DiffFile,
  policy: ReviewPolicy,
): ChangeKind {
  const path =
    file.newPath === "/dev/null"
      ? (file.oldPath ?? file.newPath)
      : file.newPath;
  const lower = path.toLowerCase();
  if (policy.generatedPaths.some((pattern) => matchPath(pattern, path)))
    return "generated";
  if (
    /(^|\/)(vendor|node_modules|dist|build|coverage|generated|__generated__)(\/|$)/u.test(
      lower,
    )
  )
    return "generated";
  if (/\.(min\.(js|css)|generated\.[^.]+|g\.cs)$/u.test(lower))
    return "generated";
  if (
    /\.(test|spec)\.[^.]+$/u.test(lower) ||
    /(^|\/)(__tests__|tests?|specs?)(\/|$)/u.test(lower)
  )
    return "test";
  if (/(_test\.go|test_[^/]+\.py|[^/]+_spec\.rb)$/u.test(lower)) return "test";
  if (
    /\.(md|mdx|rst|txt|adoc)$/u.test(lower) ||
    /(^|\/)docs?(\/|$)/u.test(lower)
  )
    return "documentation";
  if (/(^|\/)(migrations?|schema)(\/|$)/u.test(lower) || /\.sql$/u.test(lower))
    return "migration";
  if (
    /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|go\.(mod|sum)|cargo\.(toml|lock)|requirements[^/]*\.txt|poetry\.lock|gemfile(\.lock)?|pom\.xml)$/u.test(
      lower,
    )
  )
    return "dependency";
  if (
    /(^|\/)(dockerfile[^/]*|docker-compose[^/]*|compose[^/]*\.ya?ml|\.env[^/]*|[^/]*config\.[^.]+)$/u.test(
      lower,
    )
  )
    return "configuration";
  if (
    /\.(ya?ml|toml|ini|conf|tf|tfvars)$/u.test(lower) ||
    lower.startsWith(".github/")
  )
    return "configuration";
  if (file.hunks === null) return "binary";
  return "source";
}

/** 分数区间只表示需要投入多少审查精力，不表示已发现的缺陷严重度。 */
export function riskBand(score: number): RiskBand {
  if (score >= 80) return "critical";
  if (score >= 55) return "high";
  if (score >= 25) return "medium";
  return "low";
}

/** 给一个文件列出可解释的风险因素。 */
export function assessFileRisk(file: DiffFile, policy: ReviewPolicy): FileRisk {
  const path =
    file.newPath === "/dev/null"
      ? (file.oldPath ?? file.newPath)
      : file.newPath;
  const kind = classifyChangedFile(file, policy);
  const churn = file.additions + file.deletions;
  const reasons: RiskReason[] = [];
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const securitySensitive =
    /(^|\/)(auth[^/]*|sessions?|permissions?|tokens?|crypto[^/]*|secrets?|credentials?|payments?)(\/|\.)/iu.test(
      path,
    ) || policy.sensitivePaths.some((pattern) => matchPath(pattern, path));

  if (securitySensitive)
    reasons.push({
      code: "sensitive_path",
      message: "涉及认证、权限、密钥、支付或自定义敏感路径",
      points: 35,
    });
  if (kind === "migration")
    reasons.push({
      code: "persistent_data",
      message: "变更涉及持久化数据结构，需要检查升级和回滚",
      points: 30,
    });
  if (kind === "dependency")
    reasons.push({
      code: "dependency_change",
      message: "依赖版本或锁文件改变，需检查兼容性与来源",
      points: 15,
    });
  if (kind === "configuration")
    reasons.push({
      code: "runtime_configuration",
      message: "运行或发布配置改变，可能影响整个部署",
      points: 20,
    });
  if (churn > 1_000)
    reasons.push({
      code: "very_large_file",
      message: "单文件变动超过 1000 行，人工核对成本高",
      points: 25,
    });
  else if (churn > 300)
    reasons.push({
      code: "large_file",
      message: "单文件变动超过 300 行",
      points: 15,
    });
  else if (churn > 100)
    reasons.push({
      code: "moderate_file",
      message: "单文件变动超过 100 行",
      points: 8,
    });
  if (file.deletions > 0 && file.additions === 0 && kind === "source")
    reasons.push({
      code: "source_removal",
      message: "只删除源码，需要确认调用方和对外行为",
      points: 10,
    });
  if (kind === "source" && churn > 0)
    reasons.push({
      code: "source_change",
      message: "可执行源码发生变化",
      points: 10,
    });
  if (kind === "generated" || kind === "documentation" || kind === "test")
    reasons.push({
      code: "supporting_file",
      message: "辅助材料不单独提高运行风险分数",
      points: -10,
    });
  const score = Math.max(
    0,
    Math.min(
      100,
      reasons.reduce((sum, reason) => sum + reason.points, 0),
    ),
  );
  return {
    path,
    kind,
    language: EXTENSIONS[extension] ?? null,
    score,
    band: riskBand(score),
    reasons,
    additions: file.additions,
    deletions: file.deletions,
    securitySensitive,
    reviewable:
      file.hunks !== null && file.hunks.length > 0 && kind !== "generated",
  };
}

/** 汇总风险，优先保证敏感路径和数据变更不被大文件淹没。 */
export function analyzeChangeRisk(
  diff: ParsedDiff,
  policy: ReviewPolicy,
): ChangeRisk {
  const files = diff.files.map((file) => assessFileRisk(file, policy));
  const sourceLines = files
    .filter((file) => file.kind === "source")
    .reduce((sum, file) => sum + file.additions + file.deletions, 0);
  const testLines = files
    .filter((file) => file.kind === "test")
    .reduce((sum, file) => sum + file.additions + file.deletions, 0);
  const reasons: RiskReason[] = [];
  if (files.length > 30)
    reasons.push({
      code: "many_files",
      message: "跨越 30 个以上文件，需要检查跨文件契约",
      points: 15,
    });
  if (diff.additions + diff.deletions > 3_000)
    reasons.push({
      code: "large_change",
      message: "总变动超过 3000 行，建议分批审查",
      points: 15,
    });
  if (sourceLines > 200 && testLines === 0)
    reasons.push({
      code: "no_changed_tests",
      message: "源码变动较多，但本次 diff 没有测试变更；这不等于没有既有测试",
      points: 10,
    });
  const highest = files.reduce((score, file) => Math.max(score, file.score), 0);
  const score = Math.min(
    100,
    highest + reasons.reduce((sum, reason) => sum + reason.points, 0),
  );
  return {
    score,
    band: riskBand(score),
    files,
    reasons,
    changedLines: diff.additions + diff.deletions,
    sourceLines,
    testLines,
    testToSourceRatio:
      sourceLines > 0
        ? Math.round((testLines / sourceLines) * 1_000) / 1_000
        : null,
    suggestedMode: score >= 55 ? "deep" : score >= 25 ? "standard" : "quick",
  };
}
