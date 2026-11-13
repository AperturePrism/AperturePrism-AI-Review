/**
 * 发现证据：检查模型引用是否真的出现在变更或预读源码里。
 * 调用：const evidence = checkFindingEvidence(finding, renderedContext);
 * 结果是可核对性评估，不是对缺陷本身的自动验证。
 */
import type { RenderedPrContext } from "./context.js";
import type { Finding } from "./types.js";
import { normalizeFindingEvidence } from "./baseline.js";

export type EvidenceIssue =
  | "file_not_changed"
  | "evidence_not_found"
  | "unknown_line"
  | "line_outside_diff"
  | "line_not_changed"
  | "weak_evidence";
export type EvidenceCheck = {
  finding: Finding;
  verified: boolean;
  source: "diff" | "preloaded" | "none";
  lineInDiff: boolean;
  changedLine: boolean;
  issues: readonly EvidenceIssue[];
  score: number;
};

/** 检查同一个发现的路径、摘录与行号是否互相对应。 */
export function checkFindingEvidence(
  finding: Finding,
  context: RenderedPrContext,
): EvidenceCheck {
  const issues: EvidenceIssue[] = [];
  const file = context.diff.files.find(
    (candidate) => candidate.newPath === finding.file,
  );
  if (!file) issues.push("file_not_changed");
  const diffLines = file?.hunks?.flatMap((hunk) => hunk.lines) ?? [];
  const diffText = diffLines.map((line) => line.text).join("\n");
  const preloaded =
    context.preloadedFiles?.find((candidate) => candidate.path === finding.file)
      ?.content ?? "";
  const evidence = finding.evidence.trim();
  const source =
    evidence && diffText.includes(evidence)
      ? "diff"
      : evidence && preloaded.includes(evidence)
        ? "preloaded"
        : "none";
  if (source === "none") issues.push("evidence_not_found");
  const lineInDiff =
    finding.afterLine > 0 &&
    diffLines.some((line) => line.afterLine === finding.afterLine);
  const changedLine =
    finding.afterLine > 0 &&
    diffLines.some(
      (line) => line.kind === "add" && line.afterLine === finding.afterLine,
    );
  if (finding.afterLine === 0) issues.push("unknown_line");
  else if (!lineInDiff) issues.push("line_outside_diff");
  else if (!changedLine) issues.push("line_not_changed");
  if (normalizeFindingEvidence(evidence).length < 8)
    issues.push("weak_evidence");
  const score = Math.max(
    0,
    Math.min(
      100,
      (source !== "none" ? 60 : 0) +
        (file ? 15 : 0) +
        (lineInDiff ? 10 : 0) +
        (changedLine ? 10 : 0) +
        (evidence.length >= 8 ? 5 : 0),
    ),
  );
  return {
    finding,
    verified: source !== "none" && Boolean(file),
    source,
    lineInDiff,
    changedLine,
    issues,
    score,
  };
}

/** 整体证据质量保留每条发现的理由，界面可以直接展示缺在哪里。 */
export function reviewEvidence(
  context: RenderedPrContext,
  findings: readonly Finding[],
): {
  checks: readonly EvidenceCheck[];
  verifiedCount: number;
  unverifiedCount: number;
  meanScore: number | null;
} {
  const checks = findings.map((finding) =>
    checkFindingEvidence(finding, context),
  );
  const verifiedCount = checks.filter((check) => check.verified).length;
  return {
    checks,
    verifiedCount,
    unverifiedCount: checks.length - verifiedCount,
    meanScore: checks.length
      ? Math.round(
          checks.reduce((sum, check) => sum + check.score, 0) / checks.length,
        )
      : null,
  };
}
