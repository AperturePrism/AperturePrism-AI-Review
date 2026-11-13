/**
 * 审查基线：保留上一次发现，以证据指纹识别新增、延续、变化和已解决问题。
 * 调用：const baseline = createReviewBaseline(review, { revision: "abc", now: new Date() });
 *       const comparison = compareReviewBaseline(next.findings, baseline);
 * 基线不自行落盘；调用方选择数据库或文件，并在受信边界调用 parseReviewBaseline。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { findingSchema, type Finding, type PrReviewContract } from "./types.js";
import { normalizeReviewPath } from "./utils/path.js";

export const BASELINE_VERSION = "review-baseline/v1" as const;
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().datetime({ offset: true });

export const reviewBaselineSchema = z
  .object({
    version: z.literal(BASELINE_VERSION),
    revision: z.string().trim().min(1).max(200),
    createdAt: timestampSchema,
    entries: z
      .array(
        z
          .object({
            fingerprint: fingerprintSchema,
            finding: findingSchema,
            firstSeenAt: timestampSchema,
            lastSeenAt: timestampSchema,
            occurrences: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
          })
          .strict(),
      )
      .max(10_000),
  })
  .strict();

export type ReviewBaseline = z.infer<typeof reviewBaselineSchema>;
export type BaselineEntry = ReviewBaseline["entries"][number];
export type FindingState = "new" | "existing" | "changed" | "resolved";
export type BaselineFinding = {
  fingerprint: string;
  state: FindingState;
  finding: Finding;
  previous: Finding | null;
  firstSeenAt: string | null;
};
export type BaselineComparison = {
  current: readonly BaselineFinding[];
  resolved: readonly BaselineFinding[];
  counts: Readonly<Record<FindingState, number>>;
  baselineRevision: string | null;
};

/** 指纹保留语义中的字母大小写，只合并空白；代码中的大小写可能有意义。 */
export function normalizeFindingEvidence(evidence: string): string {
  return evidence.replaceAll("\r\n", "\n").trim().replace(/\s+/gu, " ");
}

/**
 * 指纹不含行号、严重度和模型文案。前面插入代码、措辞调整不应制造新问题。
 * 同规则、同路径、同证据仍可能代表两个缺陷；基线采用计数匹配，保留重复出现次数。
 */
export function findingFingerprint(finding: Finding): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        finding.rule.trim().toLowerCase(),
        normalizeReviewPath(finding.file),
        normalizeFindingEvidence(finding.evidence),
      ]),
    )
    .digest("hex");
}

/** 从外部 JSON 恢复基线，并验证指纹确实对应记录中的发现。 */
export function parseReviewBaseline(value: unknown): ReviewBaseline {
  const parsed = reviewBaselineSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `审查基线无效：${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("；")}`,
    );
  }
  for (const entry of parsed.data.entries) {
    if (findingFingerprint(entry.finding) !== entry.fingerprint) {
      throw new Error(`审查基线指纹与发现不一致：${entry.finding.file}`);
    }
    if (Date.parse(entry.firstSeenAt) > Date.parse(entry.lastSeenAt)) {
      throw new Error("审查基线的首次发现时间不能晚于最后发现时间");
    }
  }
  return parsed.data;
}

/** 把完整审查保存成基线；已存在的问题延续首次发现时间。 */
export function createReviewBaseline(
  review: PrReviewContract,
  options: { revision: string; now?: Date; previous?: ReviewBaseline },
): ReviewBaseline {
  const now = (options.now ?? new Date()).toISOString();
  const previous = new Map<string, BaselineEntry[]>();
  for (const entry of options.previous?.entries ?? []) {
    const entries = previous.get(entry.fingerprint) ?? [];
    entries.push(entry);
    previous.set(entry.fingerprint, entries);
  }
  const entries = review.findings.map((finding): BaselineEntry => {
    const fingerprint = findingFingerprint(finding);
    const old = previous.get(fingerprint)?.shift(); // 同位置重复问题按次数一一延续。
    return {
      fingerprint,
      finding: structuredClone(finding),
      firstSeenAt: old?.firstSeenAt ?? now,
      lastSeenAt: now,
      occurrences: (old?.occurrences ?? 0) + 1,
    };
  });
  return parseReviewBaseline({
    version: BASELINE_VERSION,
    revision: options.revision,
    createdAt: now,
    entries,
  });
}

/** 逐条配对，避免用 Set 错误地合并同一文件里的重复证据。 */
export function compareReviewBaseline(
  findings: readonly Finding[],
  baseline?: ReviewBaseline,
): BaselineComparison {
  const available = new Map<string, BaselineEntry[]>();
  for (const entry of baseline?.entries ?? []) {
    const group = available.get(entry.fingerprint) ?? [];
    group.push(entry);
    available.set(entry.fingerprint, group);
  }
  const counts: Record<FindingState, number> = {
    new: 0,
    existing: 0,
    changed: 0,
    resolved: 0,
  };
  const current = findings.map((finding): BaselineFinding => {
    const fingerprint = findingFingerprint(finding);
    const candidates = available.get(fingerprint) ?? [];
    // 同证据出现多处时优先挑最近的旧行号，而不是靠输出顺序碰运气。
    candidates.sort(
      (left, right) =>
        Math.abs(left.finding.afterLine - finding.afterLine) -
        Math.abs(right.finding.afterLine - finding.afterLine),
    );
    const previous = candidates.shift();
    const state: FindingState = !previous
      ? "new"
      : previous.finding.severity !== finding.severity ||
          previous.finding.impact !== finding.impact
        ? "changed"
        : "existing";
    counts[state] += 1;
    return {
      fingerprint,
      state,
      finding,
      previous: previous?.finding ?? null,
      firstSeenAt: previous?.firstSeenAt ?? null,
    };
  });
  const resolved = [...available.values()]
    .flat()
    .map((entry): BaselineFinding => {
      counts.resolved += 1;
      return {
        fingerprint: entry.fingerprint,
        state: "resolved",
        finding: entry.finding,
        previous: entry.finding,
        firstSeenAt: entry.firstSeenAt,
      };
    });
  return {
    current,
    resolved,
    counts,
    baselineRevision: baseline?.revision ?? null,
  };
}

/** 生成便于检查及版本比较的基线 JSON。 */
export function serializeReviewBaseline(baseline: ReviewBaseline): string {
  return JSON.stringify(baseline, null, 2);
}

/** 显式重命名映射可把旧基线迁移到新路径；不推测重命名，避免误认同名问题。 */
export function renameBaselineFiles(
  baseline: ReviewBaseline,
  renames: Readonly<Record<string, string>>,
): ReviewBaseline {
  const mapping = new Map(
    Object.entries(renames).map(([oldPath, newPath]) => [
      normalizeReviewPath(oldPath),
      normalizeReviewPath(newPath),
    ]),
  );
  const entries = baseline.entries.map((entry) => {
    const nextPath = mapping.get(normalizeReviewPath(entry.finding.file));
    if (!nextPath) return structuredClone(entry);
    const finding = { ...entry.finding, file: nextPath };
    return { ...entry, finding, fingerprint: findingFingerprint(finding) };
  });
  return { ...baseline, entries };
}
