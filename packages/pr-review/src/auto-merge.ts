/** 自动合并资格只来自服务器保存的审查评估，不能由模型单独声明通过。 */
import { prReviewContractSchema } from "./types.js";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 与 worker 排队及 scheduler 执行共享；空结果、过滤发现、覆盖不足均拒绝。 */
export function reviewAllowsAutoMerge(result: unknown): boolean {
  const saved = object(result);
  if (!saved) return false;
  const { assessment: rawAssessment, ...contract } = saved;
  const parsed = prReviewContractSchema.safeParse(contract);
  if (
    !parsed.success ||
    parsed.data.overallTone !== "approve" ||
    parsed.data.findings.length
  )
    return false;
  const assessment = object(rawAssessment);
  const assessedReview = prReviewContractSchema.safeParse(assessment?.review);
  const coverage = object(assessment?.coverage);
  const gate = object(assessment?.gate);
  const suppressions = object(assessment?.suppressions);
  return (
    assessment?.version === "review-assessment/v1" &&
    assessedReview.success &&
    JSON.stringify(assessedReview.data) === JSON.stringify(parsed.data) &&
    gate?.status === "passed" &&
    coverage?.changedLineRatio === 1 &&
    Number.isInteger(coverage?.totalFiles) &&
    Number(coverage?.totalFiles) > 0 &&
    coverage?.completeFiles === coverage?.totalFiles &&
    coverage?.fileRatio === 1 &&
    coverage?.partialFiles === 0 &&
    coverage?.unreadFiles === 0 &&
    coverage?.binaryFiles === 0 &&
    Array.isArray(assessment?.findings) &&
    assessment.findings.length === 0 &&
    Array.isArray(assessment?.excluded) &&
    assessment.excluded.length === 0 &&
    Array.isArray(suppressions?.suppressed) &&
    suppressions.suppressed.length === 0
  );
}
