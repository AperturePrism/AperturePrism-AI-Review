import type { LeasedTask } from "../../../packages/domain/src/index.js";
import { PrContextRevisionError } from "../../../packages/pr-review/src/context-build.js";
import { GitHubApiError } from "../../../packages/github-adapter/src/index.js";
import type {
  PrReviewContext,
  PrReviewOutcome,
  ReviewAssessment,
} from "../../../packages/pr-review/src/index.js";
import type { PrReviewContract } from "../../../packages/pr-review/src/types.js";
import type { TaskHandler } from "./loop.js";

/**
 * Everything the PR-review flow needs, injected by main so this module stays a
 * pure orchestration layer that is easy to test without GitHub or a database.
 */
export type PrReviewServices = {
  buildContext: (
    task: LeasedTask,
    signal: AbortSignal,
  ) => Promise<PrReviewContext>;
  review: (
    context: PrReviewContext,
    signal: AbortSignal,
  ) => Promise<PrReviewOutcome>;
  publishFinal: (
    task: LeasedTask,
    review: PrReviewContract,
    signal: AbortSignal,
    assessment?: ReviewAssessment,
  ) => Promise<void>;
  recordUsage: (task: LeasedTask, outcome: PrReviewOutcome) => Promise<void>;
  /**
   * Optional: creates an in-progress Check Run before review (best-effort,
   * failures are swallowed so a missing checks permission never fails review).
   */
  beginCheckRun?: (task: LeasedTask, context: PrReviewContext) => Promise<void>;
  /**
   * Optional: updates the Check Run to completed after publishing (best-effort).
   */
  finishCheckRun?: (
    task: LeasedTask,
    review: PrReviewContract,
    assessment?: ReviewAssessment,
  ) => Promise<void>;
  /**
   * Optional: persists a distilled memory reflection after the final publish.
   * Best-effort — injected implementations swallow failures; the handler only
   * guards so a memory failure can never fail the completed task.
   */
  recordMemory?: (task: LeasedTask, review: PrReviewContract) => Promise<void>;
};

/**
 * The vertical PR-review flow: context (PR + diff) -> review -> record usage ->
 * publish the review tied to the head SHA. Invalid contract output fails with
 * a retryable category; permanent GitHub problems are marked so the engine
 * does not retry them forever.
 */
export function createPrReviewHandler(services: PrReviewServices): TaskHandler {
  return async (task, signal, execution) => {
    try {
      if (task.taskType !== "pr_review")
        return { outcome: "failed", errorCategory: "unsupported_task_type" };

      signal.throwIfAborted();
      const context = await services.buildContext(task, signal);
      signal.throwIfAborted();
      // A Check Run surfaces the analysis state in the PR checks UI. It is
      // best-effort: a missing `checks: write` permission must never fail review.
      try {
        await services.beginCheckRun?.(task, context);
      } catch {
        signal.throwIfAborted();
        // Swallow: check-run support is optional.
      }
      signal.throwIfAborted();
      const outcome = await services.review(context, signal);
      signal.throwIfAborted();
      await services.recordUsage(task, outcome);
      signal.throwIfAborted();

      if (outcome.outcome === "invalid")
        return { outcome: "failed", errorCategory: "invalid_output" };

      // 在外发 GitHub review 前，先让队列确认租约仍属于本次执行。
      if (execution && !(await execution.beginPublishing()))
        throw new DOMException(
          "Task lease was lost before publication",
          "AbortError",
        );
      signal.throwIfAborted();
      await services.publishFinal(
        task,
        outcome.review,
        signal,
        outcome.assessment,
      );
      signal.throwIfAborted();
      try {
        await services.finishCheckRun?.(
          task,
          outcome.review,
          outcome.assessment,
        );
      } catch {
        signal.throwIfAborted();
        // Swallow: check-run support is optional.
      }
      signal.throwIfAborted();
      try {
        await services.recordMemory?.(task, outcome.review);
      } catch {
        signal.throwIfAborted();
        // Memory recording is best-effort; never blocks or fails the task.
      }
      return { outcome: "completed" };
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof PrContextRevisionError)
        return { outcome: "failed", errorCategory: "stale_revision" };
      if (error instanceof GitHubApiError) {
        if (error.category === "not_found")
          return { outcome: "failed", errorCategory: "github_not_found" };
        if (error.category === "authentication_failed")
          return { outcome: "failed", errorCategory: "github_auth_failed" };
      }
      throw error;
    }
  };
}
