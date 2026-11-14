/**
 * Issue 证据：把模型引用逐条对回实际输入，并在明确开启时去掉无来源的判断。
 * 用法：groundIssueAnalysis(analysis, context, { mode: "enforce" })。
 * 它只验证「输入里有没有这句话」，不把报告者的陈述认证成已经证实的事实。
 */
import {
  applyGradingRules,
  type GradedIssueAnalysis,
  type IssueEvidence,
} from "../../../packages/contracts/src/index.js";
import type { IssueContext } from "./context.js";

export type EvidenceSource = {
  // 证据来源和模型引用分开保存，方便人工核对。
  kind: "title" | "body" | "comment" | "file";
  key: string;
  text: string;
};

export type EvidenceMatch = {
  evidence: IssueEvidence;
  verified: boolean;
  source: { kind: EvidenceSource["kind"]; key: string; line: number } | null;
};

export type GroundingPolicy = {
  mode: "report" | "enforce";
  /** 标准化后至少多少字符，防止用一个标点支撑高严重度。 */
  minimumExcerptLength?: number;
};

export type EvidenceAudit = {
  matches: EvidenceMatch[];
  verifiedCount: number;
  unverifiedCount: number;
  sourceCount: number;
  limitations: string[];
};

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim(); // 只容忍排版差别，不做模糊语义匹配。
}

/** 从本次真正交给模型的数据构造来源；仓库规则、模型记忆不属于原始证据。 */
export function issueEvidenceSources(context: IssueContext): EvidenceSource[] {
  return [
    { kind: "title", key: "issue.title", text: context.issue.title },
    { kind: "body", key: "issue.body", text: context.issue.body },
    ...context.comments.map((comment, index): EvidenceSource => ({
      kind: "comment",
      key: `comment:${index + 1}:${comment.createdAt}`,
      text: comment.body,
    })),
    ...(context.preloadedFiles ?? []).map((file): EvidenceSource => ({
      kind: "file",
      key: file.path,
      text: file.content,
    })),
  ];
}

/**
 * 对照引用与源文本。先精确找原文，再容忍换行/全角排版；不跨不同来源拼接。
 * @returns 每条引用的来源及行号；无法定位时明确返回 null。
 */
export function auditIssueEvidence(
  evidence: readonly IssueEvidence[],
  sources: readonly EvidenceSource[],
  minimumExcerptLength = 8,
): EvidenceAudit {
  if (
    !Number.isInteger(minimumExcerptLength) ||
    minimumExcerptLength < 1 ||
    minimumExcerptLength > 2000
  ) {
    throw new Error(
      "minimumExcerptLength must be an integer between 1 and 2000",
    );
  }
  const prepared = sources.map((source) => ({
    ...source,
    normalized: normalized(source.text),
  }));
  const matches = evidence.map((item): EvidenceMatch => {
    const excerpt = normalized(item.excerpt); // 空白和兼容字符只整理一次。
    if (excerpt.length < minimumExcerptLength)
      return { evidence: item, verified: false, source: null };
    const source = prepared.find((candidate) =>
      candidate.normalized.includes(excerpt),
    );
    if (!source) return { evidence: item, verified: false, source: null };
    const exactOffset = source.text.indexOf(item.excerpt);
    // 排版匹配没有可靠的原文偏移，只定位到包含引用开头的第一行。
    const start =
      exactOffset >= 0
        ? exactOffset
        : source.text.indexOf(item.excerpt.trim().split(/\s/u)[0] ?? "");
    const line =
      start >= 0 ? source.text.slice(0, start).split("\n").length : 1;
    return {
      evidence: item,
      verified: true,
      source: { kind: source.kind, key: source.key, line },
    };
  });
  const verifiedCount = matches.filter((match) => match.verified).length;
  return {
    matches,
    verifiedCount,
    unverifiedCount: matches.length - verifiedCount,
    sourceCount: sources.length,
    limitations: [
      "引用存在只说明报告者或源码中出现过该内容，不等于影响已经复现。",
    ],
  };
}

/**
 * 可选的强制模式把无来源证据去掉后重新执行现有严重度规则。
 * 原始对象不修改，审计保留所有被剔除的引用，便于用户理解降级原因。
 */
export function groundIssueAnalysis(
  analysis: GradedIssueAnalysis,
  context: IssueContext,
  policy: GroundingPolicy = { mode: "report" },
): { analysis: GradedIssueAnalysis; audit: EvidenceAudit } {
  const audit = auditIssueEvidence(
    analysis.result.evidence,
    issueEvidenceSources(context),
    policy.minimumExcerptLength,
  );
  if (policy.mode === "report") return { analysis, audit };
  const checked = applyGradingRules(
    {
      ...analysis.result,
      evidence: audit.matches
        .filter((match) => match.verified)
        .map((match) => match.evidence),
    },
    {
      exploredCode:
        context.preloadedFiles !== undefined &&
        context.preloadedFiles.length > 0,
    },
  );
  return {
    analysis: {
      ...checked,
      adjustments: [...analysis.adjustments, ...checked.adjustments],
    },
    audit,
  };
}
