/**
 * 只读确定性检查：自动发现 checks/ 的检查文件，运行于已经读到的源码和变更行。
 * 调用：await runReviewChecks(diff, { sources: preloadedFiles })。
 * 输出是带精确证据的检查提醒，默认不当作漏洞、不触发阻止合并；代码不会被执行。
 */
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import type { ParsedDiff } from "./diff.js";
import type { SourceSnapshot } from "./imports.js";
import { normalizeReviewPath } from "./utils/path.js";

export type CheckLine = { number: number; text: string; changed: boolean };
export type FileCheckContext = {
  path: string;
  lines: readonly CheckLine[];
  /** 只包含调用方提供的源码，不会自动读取本地文件。 */
  content: string | null;
  hasSourceSnapshot: boolean;
  additions: number;
  deletions: number;
};
export type CheckObservationInput = {
  path: string;
  line: number;
  endLine?: number;
  level: "warning" | "info";
  title: string;
  message: string;
  evidence: string;
  recommendation: string;
  category:
    "workflow" | "container" | "dependency" | "migration" | "secret" | "access";
  /** 不作漏洞验证；当前检查均保留这个明确标签。 */
  nature: "configuration_fact" | "heuristic" | "review_reminder";
};
export type CheckObservation = CheckObservationInput & {
  checkId: string;
  fingerprint: string;
  evidenceRedacted: boolean;
};
export type ReviewCheck = {
  description: string;
  matches: (path: string) => boolean;
  run: (file: FileCheckContext) => readonly CheckObservationInput[];
};
export type ReviewChecksResult = {
  status: "completed" | "not_run";
  executed: readonly { checkId: string; files: number; observations: number }[];
  observations: readonly CheckObservation[];
  filesWithSource: number;
  filesFromDiffOnly: number;
  warnings: readonly string[];
};
export type ReviewChecksOptions = {
  sources?: readonly SourceSnapshot[];
  enabled?: readonly string[];
  maxObservations?: number;
};

let checksPromise: Promise<ReadonlyMap<string, ReviewCheck>> | undefined;

/** 新检查只需向 checks/ 放入一个遵守 ReviewCheck 的文件，无需修改中央列表。 */
export async function discoverReviewChecks(
  directory = new URL("./checks/", import.meta.url),
): Promise<ReadonlyMap<string, ReviewCheck>> {
  const files = (await readdir(directory)).filter(
    (file) => /\.(?:js|ts)$/u.test(file) && !/\.(?:d|test|spec)\./u.test(file),
  );
  const names = [
    ...new Set(files.map((file) => file.replace(/\.(?:js|ts)$/u, ""))),
  ].sort();
  const result = new Map<string, ReviewCheck>();
  for (const name of names) {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const file = files.includes(`${name}.${extension}`)
      ? `${name}.${extension}`
      : files.find((candidate) => candidate.startsWith(`${name}.`))!;
    const loaded = (await import(new URL(file, directory).href)) as {
      default?: ReviewCheck;
    };
    if (
      !loaded.default ||
      typeof loaded.default.matches !== "function" ||
      typeof loaded.default.run !== "function"
    )
      throw new Error(`检查文件 ${name} 没有导出 matches 与 run`);
    result.set(name, loaded.default);
  }
  return result;
}

/** 不把密钥内容写入报告；同时处理常见令牌形状、PEM 与键值式凭据。 */
export function redactCheckEvidence(value: string): string {
  return value
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/gu,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/gu,
      "[REDACTED TOKEN]",
    )
    .replace(
      /((?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\s*[=:]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}]+)/giu,
      "$1[REDACTED]",
    )
    .replace(
      /((?:["']?[A-Za-z0-9_]*(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)[A-Za-z0-9_]*["']?)\s*[=:]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}]+)/giu,
      "$1[REDACTED]",
    )
    .replace(
      /((?:ARG|ENV)\s+[A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|PRIVATE_KEY|API_KEY)[A-Za-z0-9_]*\s+).*/giu,
      "$1[REDACTED]",
    )
    .replace(/(https?:\/\/)[^\s/:]+:[^\s/@]+@/giu, "$1[REDACTED]@");
}

/** 将已有 diff 和源码快照合并，行号始终使用新文件的真实 afterLine。 */
export function reviewCheckFiles(
  diff: ParsedDiff,
  sources: readonly SourceSnapshot[] = [],
): readonly FileCheckContext[] {
  const snapshots = new Map(
    sources.map((source) => [normalizeReviewPath(source.path), source.content]),
  );
  const result: FileCheckContext[] = [];
  for (const file of diff.files) {
    const path =
      file.newPath === "/dev/null"
        ? (file.oldPath ?? file.newPath)
        : file.newPath;
    if (path === "/dev/null") continue;
    const normalized = normalizeReviewPath(path);
    const content = snapshots.get(normalized) ?? null;
    const changed = new Set(
      file.hunks?.flatMap((hunk) =>
        hunk.lines
          .filter((line) => line.kind === "add")
          .map((line) => line.afterLine),
      ) ?? [],
    );
    const lines: CheckLine[] =
      content !== null
        ? content
            .replaceAll("\r\n", "\n")
            .split("\n")
            .map((text, index) => ({
              number: index + 1,
              text,
              changed: changed.has(index + 1),
            }))
        : (file.hunks?.flatMap((hunk) =>
            hunk.lines
              .filter((line) => line.kind !== "delete" && line.afterLine > 0)
              .map((line) => ({
                number: line.afterLine,
                text: line.text,
                changed: line.kind === "add",
              })),
          ) ?? []);
    result.push({
      path: normalized,
      content,
      lines,
      hasSourceSnapshot: content !== null,
      additions: file.additions,
      deletions: file.deletions,
    });
  }
  return result;
}

/** 检查只在候选文件上执行；不在报告内保留原始源码或未脱敏的异常。 */
export async function runReviewChecks(
  diff: ParsedDiff,
  options: ReviewChecksOptions = {},
): Promise<ReviewChecksResult> {
  const maxObservations = options.maxObservations ?? 500;
  if (
    !Number.isSafeInteger(maxObservations) ||
    maxObservations < 1 ||
    maxObservations > 5_000
  )
    throw new Error("检查结果上限必须在 1 到 5000 之间");
  if (
    (options.sources ?? []).reduce(
      (sum, source) => sum + Buffer.byteLength(source.content),
      0,
    ) > 20_000_000
  )
    throw new Error("检查源码快照总大小不能超过 20 MB");
  checksPromise ??= discoverReviewChecks();
  const checks = await checksPromise;
  const files = reviewCheckFiles(diff, options.sources);
  const enabled = options.enabled ? new Set(options.enabled) : null;
  if (enabled)
    for (const name of enabled)
      if (!checks.has(name)) throw new Error(`没有安装名为 ${name} 的审查检查`);
  const observations: CheckObservation[] = [];
  const executed: { checkId: string; files: number; observations: number }[] =
    [];
  let omitted = 0;
  for (const [checkId, check] of checks) {
    if (enabled && !enabled.has(checkId)) continue;
    const candidates = files.filter((file) => check.matches(file.path));
    let observed = 0;
    for (const file of candidates) {
      for (const observation of check.run(file)) {
        observed += 1;
        if (observations.length >= maxObservations) {
          omitted += 1;
          continue;
        }
        const evidence = redactCheckEvidence(observation.evidence).slice(
          0,
          2_000,
        );
        const safe = {
          ...observation,
          title: redactCheckEvidence(observation.title),
          message: redactCheckEvidence(observation.message),
          recommendation: redactCheckEvidence(observation.recommendation),
          evidence,
        };
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify([
              checkId,
              safe.path,
              safe.line,
              safe.title,
              safe.evidence,
            ]),
          )
          .digest("hex");
        observations.push({
          ...safe,
          checkId,
          fingerprint,
          evidenceRedacted:
            evidence !== observation.evidence || evidence.includes("[REDACTED"),
        });
      }
    }
    executed.push({
      checkId,
      files: candidates.length,
      observations: observed,
    });
  }
  const filesWithSource = files.filter((file) => file.hasSourceSnapshot).length;
  const warnings = ["这些确定性检查输出配置事实和审查提醒，不代表已验证漏洞"];
  if (filesWithSource < files.length)
    warnings.push("部分检查只有 diff 片段；跨行或文件级关系可能不完整");
  if (omitted) warnings.push(`${omitted} 项检查提醒因结果上限未写入报告`);
  return {
    status: "completed",
    executed,
    observations,
    filesWithSource,
    filesFromDiffOnly: files.length - filesWithSource,
    warnings,
  };
}
