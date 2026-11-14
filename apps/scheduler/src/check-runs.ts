import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  analysisTasks,
  externalPublications,
  subjectResults,
  type DatabaseClient,
} from "../../../packages/database/src/index.js";
import type { GitHubClient } from "../../../packages/github-adapter/src/index.js";
import { parsePrReviewTaskPayload } from "../../../packages/pr-review/src/payload.js";
import { prReviewContractSchema } from "../../../packages/pr-review/src/types.js";
import { reviewAllowsAutoMerge } from "../../../packages/pr-review/src/auto-merge.js";

type TerminalStatus = "completed" | "failed" | "canceled";
type CheckRunClient = Pick<GitHubClient, "getCheckRun" | "updateCheckRun">;
type Completion = Pick<
  Parameters<GitHubClient["updateCheckRun"]>[0],
  "conclusion" | "title" | "summary"
>;
const terminalStatuses: TerminalStatus[] = ["completed", "failed", "canceled"];
const batchSize = 20;
const requestTimeoutMs = 15_000;

export function terminalCheckRunOutput(
  status: TerminalStatus,
  result: unknown,
  errorCategory: string | null,
): Completion {
  if (status === "canceled") {
    return {
      conclusion: "cancelled",
      title: "AI 审核已取消",
      summary: "该审核任务已被取消。",
    };
  }
  if (status === "failed") {
    return {
      conclusion: "failure",
      title: "AI 审核失败",
      summary: `审核未完成（${(errorCategory ?? "unknown").slice(0, 200)}）。修复后可在 WebUI 重新入队。`,
    };
  }
  const saved =
    typeof result === "object" && result !== null && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : null;
  const { assessment, ...contract } = saved ?? {};
  const parsed = prReviewContractSchema.safeParse(saved ? contract : result);
  if (!parsed.success) {
    return {
      conclusion: "neutral",
      title: "AI 审核已结束",
      summary:
        "任务已完成，但未找到有效的结构化审查结果。请在 WebUI 查看任务详情。",
    };
  }
  const review = parsed.data;
  const findings = review.findings.length;
  if (
    findings === 0 &&
    assessment !== undefined &&
    !reviewAllowsAutoMerge(result)
  ) {
    const gate =
      typeof assessment === "object" &&
      assessment !== null &&
      "gate" in assessment
        ? assessment.gate
        : null;
    const failed =
      typeof gate === "object" &&
      gate !== null &&
      "status" in gate &&
      gate.status === "failed";
    return {
      conclusion: failed ? "failure" : "neutral",
      title: failed ? "AI 审查门禁未通过" : "AI 审查尚不完整",
      summary:
        "审查未明确批准、门禁未通过、覆盖不足或存在被过滤/抑制的发现；不能将其标记为成功。",
    };
  }
  return {
    conclusion: findings > 0 ? "failure" : "success",
    title: findings > 0 ? `发现 ${findings} 个问题` : "未发现明显问题",
    summary: `结论：${review.overallTone}；变更 ${review.changedFileCount} 个文件（+${review.additions}/-${review.deletions}）；findings ${findings}。`,
  };
}

export async function reconcileCheckRuns(input: {
  db: DatabaseClient["db"];
  github: CheckRunClient;
  signal: AbortSignal;
  onError: (error: unknown, publicationId: string) => void;
}): Promise<number> {
  const { db, github, signal } = input;
  const candidates = await db
    .select({
      id: externalPublications.id,
      taskId: externalPublications.taskId,
    })
    .from(externalPublications)
    .innerJoin(analysisTasks, eq(analysisTasks.id, externalPublications.taskId))
    .where(
      and(
        eq(externalPublications.channel, "check_run"),
        isNull(externalPublications.checkRunCompletedAt),
        isNotNull(externalPublications.externalObjectId),
        eq(analysisTasks.taskType, "pr_review"),
        inArray(analysisTasks.status, terminalStatuses),
      ),
    )
    .orderBy(asc(externalPublications.updatedAt), asc(externalPublications.id))
    .limit(batchSize);
  let finalized = 0;
  for (const candidate of candidates) {
    if (signal.aborted) break;
    try {
      const completed = await db.transaction(async (tx) => {
        // Rerun updates the task before its publication. Use that same lock order
        // and hold both through the bounded request so stale cleanup cannot win.
        const [task] = await tx
          .select({
            status: analysisTasks.status,
            payload: analysisTasks.payload,
            errorCategory: analysisTasks.lastErrorCategory,
          })
          .from(analysisTasks)
          .where(
            and(
              eq(analysisTasks.id, candidate.taskId),
              eq(analysisTasks.taskType, "pr_review"),
              inArray(analysisTasks.status, terminalStatuses),
            ),
          )
          .for("update", { skipLocked: true })
          .limit(1);
        if (!task) return false;
        const [publication] = await tx
          .select({
            externalObjectId: externalPublications.externalObjectId,
          })
          .from(externalPublications)
          .where(
            and(
              eq(externalPublications.id, candidate.id),
              eq(externalPublications.taskId, candidate.taskId),
              eq(externalPublications.channel, "check_run"),
              isNull(externalPublications.checkRunCompletedAt),
            ),
          )
          .for("update", { skipLocked: true })
          .limit(1);
        if (!publication) return false;

        // Rotate failures behind other pending rows; a bad installation must not
        // starve the rest of a bounded batch on every scheduler tick.
        await tx
          .update(externalPublications)
          .set({ updatedAt: new Date() })
          .where(eq(externalPublications.id, candidate.id));
        try {
          const payload = parsePrReviewTaskPayload(task.payload);
          const checkRunId = Number(publication.externalObjectId);
          const identity = payload?.repositoryFullName.split("/");
          const owner = identity?.[0];
          const name = identity?.[1];
          if (
            !payload ||
            identity?.length !== 2 ||
            !owner ||
            !name ||
            !Number.isSafeInteger(checkRunId) ||
            checkRunId <= 0
          ) {
            throw new Error("invalid Check Run publication identity");
          }
          const requestSignal = AbortSignal.any([
            signal,
            AbortSignal.timeout(requestTimeoutMs),
          ]);
          requestSignal.throwIfAborted();
          const check = {
            installationId: payload.installationId,
            owner,
            name,
            checkRunId,
          };
          // A 404 can also hide an inaccessible repository or installation;
          // only a confirmed completed run is acknowledged without a PATCH.
          const current = await github.getCheckRun(check, requestSignal);
          if (current.status !== "completed") {
            const [result] = await tx
              .select({ result: subjectResults.result })
              .from(subjectResults)
              .where(
                and(
                  eq(subjectResults.taskId, candidate.taskId),
                  eq(subjectResults.subjectType, "pr"),
                  eq(subjectResults.revision, payload.subjectRevision),
                ),
              )
              .limit(1);
            await github.updateCheckRun(
              {
                ...check,
                status: "completed",
                ...terminalCheckRunOutput(
                  task.status as TerminalStatus,
                  result?.result,
                  task.errorCategory,
                ),
              },
              requestSignal,
            );
          }
          requestSignal.throwIfAborted();
          await tx
            .update(externalPublications)
            .set({
              checkRunCompletedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(externalPublications.id, candidate.id),
                eq(externalPublications.taskId, candidate.taskId),
                eq(externalPublications.externalObjectId, String(checkRunId)),
                isNull(externalPublications.checkRunCompletedAt),
              ),
            );
          return true;
        } catch (error) {
          input.onError(error, candidate.id);
          return false;
        }
      });
      if (completed) finalized += 1;
    } catch (error) {
      input.onError(error, candidate.id);
    }
  }
  return finalized;
}
