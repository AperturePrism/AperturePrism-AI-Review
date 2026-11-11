import type { Finding, FindingSeverity } from "./types.js";

/**
 * Two findings are the same issue when they share a rule, a file, and start
 * within `MAX_SEPARATION` after-lines of each other. This collapses a model's
 * repeated statements about one defect without removing distinct defects.
 */
export const MAX_SEPARATION_LINES = 12;

/** Findings below this confidence are not published, regardless of rule. */
export const MIN_CONFIDENCE_PUBLISH = 0.5;

/** Low-severity style opinions are not published on the board by default. */
export const MIN_PUBLISH_SEVERITY: FindingSeverity = "medium";

/** Higher severity = larger weight (critical 4 … info 0). */
const SEVERITY_WEIGHT: Record<FindingSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

function severityWeight(level: FindingSeverity): number {
  return SEVERITY_WEIGHT[level];
}

export function sameLocation(a: Finding, b: Finding): boolean {
  if (a.rule !== b.rule) return false;
  if (a.file !== b.file) return false;
  return Math.abs(a.afterLine - b.afterLine) <= MAX_SEPARATION_LINES;
}

/**
 * Stable ordering so dedupe keeps the strongest finding (highest severity,
 * then confidence, then earliest line) and does not depend on model output
 * order.
 */
function rank(finding: Finding): number {
  return severityWeight(finding.severity) * 10_000 + finding.confidence * 100;
}

export function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const sorted = [...findings].sort((a, b) => rank(b) - rank(a));
  const kept: Finding[] = [];
  for (const finding of sorted) {
    if (kept.some((keep) => sameLocation(keep, finding))) continue;
    kept.push(finding);
  }
  return kept;
}

/**
 * Low/info meaningless changes are actionable cleanup, not style nits. They
 * retain the confidence requirement without inflating their severity.
 */
export function shouldPublishFinding(finding: Finding): boolean {
  return (
    finding.confidence >= MIN_CONFIDENCE_PUBLISH &&
    (finding.rule === "meaningless-change" ||
      severityWeight(finding.severity) >= severityWeight(MIN_PUBLISH_SEVERITY))
  );
}

/**
 * Server-side severity policy, mirroring the issue grading rules: a claim is
 * only trusted as high impact when the diff evidence supports it. The model
 * cannot self-certify `critical`/`high` on vague text.
 */
export function applySeverityRules(finding: Finding): Finding {
  let severity = finding.severity;
  const evidential = finding.evidence.trim().length >= 8;
  if (
    (severity === "critical" || severity === "high") &&
    (!evidential || finding.afterLine <= 0)
  ) {
    severity = "medium";
  }
  return { ...finding, severity };
}
