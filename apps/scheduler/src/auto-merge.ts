/**
 * 自动合并唯一写入口：任务、审查、工作台、GitHub 检查与当前 SHA 均通过后才合并。
 * 每个请求持有仓库和任务锁到 GitHub 回应；重启通过远端 merged 状态恢复。
 */
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  analysisTasks,
  AUTO_MERGE_SETTING_KEYS,
  outboxEvents,
  parseAutoMergeSettings,
  pullRequestAutoMerges,
  repositories,
  repositorySettings,
  subjectResults,
  type DatabaseClient,
} from "../../../packages/database/src/index.js";
import type { GitHubClient } from "../../../packages/github-adapter/src/index.js";
import { parsePrReviewTaskPayload } from "../../../packages/pr-review/src/payload.js";
import { reviewAllowsAutoMerge } from "../../../packages/pr-review/src/auto-merge.js";

type MergeClient = Pick<
  GitHubClient,
  | "getPullRequestMergeState"
  | "getCommitChecks"
  | "listPullRequestReviewStates"
  | "mergePullRequest"
>;
type Check = Awaited<
  ReturnType<MergeClient["getCommitChecks"]>
>["checks"][number];
type Review = Awaited<
  ReturnType<MergeClient["listPullRequestReviewStates"]>
>[number];
type MergeRow = typeof pullRequestAutoMerges.$inferSelect;
export type AutoMergeDecision = {
  status: "waiting" | "blocked" | "canceled";
  reason: string;
  message: string;
};
const activeStatuses = ["pending", "waiting", "blocked"] as const;
const retryBaseMs = 30_000;
const retryMaxMs = 10 * 60_000;
const maxAttempts = 40;
const exhaustedReason = "retry_exhausted";
const requestTimeoutMs = 20_000;
const batchSize = 20;
const recoveryTopic = "review.auto_merge_recovery";
const recoveryRetryMs = 60_000;

/** 指数退避：30s 起翻倍，封顶 10 分钟。 */
export function autoMergeRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(exponent, 30));
}

/** 429/403 二级限流携带 Retry-After 时按该值等待。 */
function rateLimitDelayMs(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "retryAfterMs" in error &&
    typeof (error as { retryAfterMs?: unknown }).retryAfterMs === "number" &&
    Number.isFinite((error as { retryAfterMs: number }).retryAfterMs) &&
    (error as { retryAfterMs: number }).retryAfterMs >= 0
  )
    return Math.min(
      retryMaxMs,
      (error as { retryAfterMs: number }).retryAfterMs,
    );
  return undefined;
}

/** journal 使用独立连接提交；即使连接池繁忙也不能无限等待，更不能未记账就外发。 */
async function beforeDeadline<T>(
  work: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const canceled = new Promise<never>((_resolve, reject) => {
    abort = () =>
      reject(signal.reason ?? new Error("auto merge journal timed out"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work, canceled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** 只接受服务器保存的完整、无隐藏发现的明确批准；没有 assessment 不能视为通过。 */
export function autoMergeReviewDecision(
  result: unknown,
): AutoMergeDecision | null {
  if (!reviewAllowsAutoMerge(result))
    return {
      status: "blocked",
      reason: "review_incomplete",
      message: "审查门禁未通过、覆盖不完整，或存在被过滤/抑制的发现",
    };
  return null;
}

const passingConclusions = new Set(["success", "neutral", "skipped"]);

/** 不把空列表、跳过、中性或缺失的必需检查当成成功。 */
export function autoMergeChecksDecision(
  checks: readonly Check[],
  requiredChecks: readonly string[],
): AutoMergeDecision | null {
  if (!checks.length)
    return {
      status: "waiting",
      reason: "no_checks",
      message: "等待 GitHub 上报至少一项检查",
    };
  const names = new Set(checks.map((check) => check.name));
  const missing = requiredChecks.filter((name) => !names.has(name));
  if (missing.length)
    return {
      status: "waiting",
      reason: "required_checks_missing",
      message: `等待必需检查：${missing.join("、").slice(0, 1000)}`,
    };
  // GitHub 语义：required checks 的 neutral/skipped 视为通过；仅明确失败才阻塞。
  const failed = checks.filter(
    (check) =>
      check.status === "completed" &&
      !passingConclusions.has(String(check.conclusion)),
  );
  if (failed.length)
    return {
      status: "blocked",
      reason: "checks_failed",
      message: `检查尚未成功：${failed
        .map((check) => check.name)
        .join("、")
        .slice(0, 1000)}`,
    };
  if (checks.some((check) => check.status !== "completed"))
    return {
      status: "waiting",
      reason: "checks_pending",
      message: "等待全部 GitHub 检查完成",
    };
  return null;
}

/** COMMENTED 不撤销先前的 APPROVED/CHANGES_REQUESTED，DISMISSED 才明确撤销。 */
export function autoMergeReviewsDecision(
  reviews: readonly Review[],
): AutoMergeDecision | null {
  const latest = new Map<string, Review>();
  for (const review of [...reviews].sort((a, b) =>
    a.submittedAt.localeCompare(b.submittedAt),
  )) {
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state))
      latest.set(review.user.toLowerCase(), review);
  }
  if (
    [...latest.values()].some((review) => review.state === "CHANGES_REQUESTED")
  )
    return {
      status: "blocked",
      reason: "changes_requested",
      message: "仍有审查者要求修改，等待该审查被批准或撤销",
    };
  return null;
}

export async function reconcilePullRequestAutoMerges(input: {
  db: DatabaseClient["db"];
  /** 生产使用独立 journal client，避免 DATABASE_POOL_MAX=1 时嵌套等待。 */
  journalDb?: DatabaseClient["db"];
  github: MergeClient;
  signal: AbortSignal;
  workbenchGate?: (
    repository: string,
    signal: AbortSignal,
  ) => Promise<{ decision: string }>;
  onError: (error: unknown, requestId: string) => void;
  now?: () => Date;
}): Promise<number> {
  const { db, github, signal } = input;
  const now = input.now ?? (() => new Date());
  const candidates = await db
    .select({
      id: pullRequestAutoMerges.id,
      taskId: pullRequestAutoMerges.taskId,
      repositoryId: pullRequestAutoMerges.repositoryId,
    })
    .from(pullRequestAutoMerges)
    .leftJoin(
      outboxEvents,
      and(
        eq(outboxEvents.id, pullRequestAutoMerges.id),
        eq(outboxEvents.topic, recoveryTopic),
      ),
    )
    .where(
      or(
        and(
          inArray(pullRequestAutoMerges.status, [...activeStatuses]),
          ne(pullRequestAutoMerges.reason, exhaustedReason),
          lte(pullRequestAutoMerges.nextAttemptAt, now()),
        ),
        and(
          isNotNull(outboxEvents.id),
          isNull(outboxEvents.publishedAt),
          lte(outboxEvents.availableAt, now()),
        ),
      ),
    )
    .orderBy(
      asc(pullRequestAutoMerges.nextAttemptAt),
      asc(pullRequestAutoMerges.id),
    )
    .limit(batchSize);
  let merged = 0;
  for (const candidate of candidates) {
    if (signal.aborted) break;
    try {
      const completed = await db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        // 排队和设置修改也先锁仓库；同仓库两个不同 task 不会并发提交合并。
        const [repository] = await tx
          .select()
          .from(repositories)
          .where(eq(repositories.id, candidate.repositoryId))
          .for("update", { skipLocked: true })
          .limit(1);
        if (!repository) return false;
        const [task] = await tx
          .select()
          .from(analysisTasks)
          .where(eq(analysisTasks.id, candidate.taskId))
          .for("update", { skipLocked: true })
          .limit(1);
        if (!task) return false;
        const [request] = await tx
          .select()
          .from(pullRequestAutoMerges)
          .where(eq(pullRequestAutoMerges.id, candidate.id))
          .for("update", { skipLocked: true })
          .limit(1);
        if (!request) return false;
        const requestId = request.id;
        let [recovery] = await tx
          .select()
          .from(outboxEvents)
          .where(
            and(
              eq(outboxEvents.id, requestId),
              eq(outboxEvents.topic, recoveryTopic),
              isNull(outboxEvents.publishedAt),
            ),
          )
          .limit(1);
        const active = ([...activeStatuses] as string[]).includes(
          request.status,
        );
        if (
          (!active || request.nextAttemptAt > now()) &&
          (!recovery || recovery.availableAt > now())
        )
          return false;
        const requestSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(requestTimeoutMs),
        ]);
        let mergeMethod = request.method;
        const save = async (
          decision: AutoMergeDecision,
          retryAfter?: number,
        ) => {
          const timestamp = now();
          const attempt = request.attempts + 1;
          const retryable =
            decision.status === "waiting" || decision.status === "blocked";
          // 只对仍在等待/重试的请求计数；合并、取消等终态不再占用重试额度。
          const exhausted = retryable && attempt >= maxAttempts;
          const effective = exhausted
            ? {
                status: "blocked" as const,
                reason: exhaustedReason,
                message: `重试 ${attempt} 次后仍未满足条件（最后原因：${decision.reason}），已停止自动重试，请人工检查`,
              }
            : decision;
          const delay = exhausted
            ? 0
            : (retryAfter ?? autoMergeRetryDelayMs(attempt));
          await tx
            .update(pullRequestAutoMerges)
            .set({
              ...effective,
              attempts: sql`${pullRequestAutoMerges.attempts} + 1`,
              updatedAt: timestamp,
              nextAttemptAt: new Date(timestamp.getTime() + delay),
              completedAt: effective.status === "canceled" ? timestamp : null,
            })
            .where(eq(pullRequestAutoMerges.id, requestId));
          if (recovery)
            await tx
              .update(outboxEvents)
              .set({
                availableAt: new Date(timestamp.getTime() + recoveryRetryMs),
              })
              .where(
                and(
                  eq(outboxEvents.id, requestId),
                  eq(outboxEvents.topic, recoveryTopic),
                  isNull(outboxEvents.publishedAt),
                ),
              );
          return false;
        };
        const latestTask = async () => {
          const [newer] = await tx
            .select({ id: analysisTasks.id })
            .from(analysisTasks)
            .where(
              and(
                eq(analysisTasks.repositoryId, request.repositoryId),
                eq(analysisTasks.taskType, "pr_review"),
                eq(analysisTasks.subjectNumber, request.pullNumber),
                ne(analysisTasks.id, request.taskId),
                // 在数据库内比较微秒；JS Date 截断后会把当前任务也错判为更新。
                sql`${analysisTasks.createdAt} >= (select created_at from analysis_tasks where id = ${request.taskId}::uuid)`,
              ),
            )
            .limit(1);
          return !newer;
        };
        try {
          requestSignal.throwIfAborted();
          // 只读恢复先于任何未来写资格：已关闭开关、任务失败或门禁变化，
          // 都不能抹去 GitHub 已经确认完成的合并。没有 marker 的取消请求不会查询。
          if (recovery) {
            const marker = recovery.payload as Record<string, unknown>;
            if (
              !marker ||
              marker.requestId !== request.id ||
              marker.taskId !== request.taskId ||
              marker.headSha !== request.headSha ||
              marker.repositoryFullName !== request.repositoryFullName ||
              marker.installationId !== request.installationId ||
              marker.pullNumber !== request.pullNumber ||
              !["merge", "squash", "rebase"].includes(String(marker.method))
            )
              return save({
                status: "blocked",
                reason: "recovery_mismatch",
                message: "历史合并请求的版本绑定不一致，停止新的合并并等待核对",
              });
            const [owner, name] = request.repositoryFullName.split("/");
            if (!owner || !name)
              return save({
                status: "blocked",
                reason: "recovery_mismatch",
                message: "历史合并请求的仓库身份无效",
              });
            const remote = await github.getPullRequestMergeState(
              {
                installationId: request.installationId,
                owner,
                name,
                pullNumber: request.pullNumber,
              },
              requestSignal,
            );
            if (remote.headSha === request.headSha && remote.merged) {
              mergeMethod = marker.method as MergeRow["method"];
              await finishMerged(
                remote.mergeCommitSha,
                "已只读确认此前请求的版本已在 GitHub 合并；未再次发起合并",
              );
              return true;
            }
            if (remote.headSha !== request.headSha || remote.state !== "open") {
              await tx
                .update(outboxEvents)
                .set({ publishedAt: now() })
                .where(
                  and(
                    eq(outboxEvents.id, requestId),
                    eq(outboxEvents.topic, recoveryTopic),
                  ),
                );
              recovery = undefined;
              return save({
                status: "canceled",
                reason:
                  remote.headSha !== request.headSha
                    ? "stale_head"
                    : "pr_closed",
                message: "已确认旧合并请求没有合并此版本，PR 已更新或关闭",
              });
            }
            if (!active)
              return save({
                status: "canceled",
                reason: "recovery_pending",
                message:
                  "自动合并已取消；仅定时确认此前请求的远端结果，不会再次发起合并",
              });
          }
          const settingsRows = await tx
            .select({
              key: repositorySettings.key,
              value: repositorySettings.value,
            })
            .from(repositorySettings)
            .where(
              and(
                eq(repositorySettings.repositoryId, request.repositoryId),
                inArray(repositorySettings.key, [...AUTO_MERGE_SETTING_KEYS]),
              ),
            )
            .for("share");
          const settings = parseAutoMergeSettings(
            new Map(settingsRows.map((row) => [row.key, row.value])),
          );
          if (!settings.enabled)
            return save({
              status: "canceled",
              reason: "disabled",
              message: "仓库已关闭自动合并，或配置无效",
            });
          mergeMethod = settings.method;
          const payload = parsePrReviewTaskPayload(task.payload);
          const identity = request.repositoryFullName.split("/");
          const owner = identity[0];
          const name = identity[1];
          if (
            !payload ||
            identity.length !== 2 ||
            !owner ||
            !name ||
            task.taskType !== "pr_review" ||
            task.repositoryId !== request.repositoryId ||
            task.subjectNumber !== request.pullNumber ||
            task.subjectRevision !== request.headSha ||
            payload.subjectRevision !== request.headSha ||
            payload.subjectNumber !== request.pullNumber ||
            payload.installationId !== request.installationId ||
            payload.repositoryFullName.toLowerCase() !==
              request.repositoryFullName.toLowerCase() ||
            `${repository.owner}/${repository.name}`.toLowerCase() !==
              request.repositoryFullName.toLowerCase() ||
            repository.installationId !== request.installationId
          )
            return save({
              status: "canceled",
              reason: "invalid_identity",
              message: "审查任务与仓库、安装或 PR 版本不一致",
            });
          if (!(await latestTask()))
            return save({
              status: "canceled",
              reason: "review_superseded",
              message: "已有更新的 PR 审查任务，本次请求不再合并",
            });
          if (task.status === "failed" || task.status === "canceled")
            return save({
              status: "canceled",
              reason: "review_failed",
              message: "审查任务失败或已取消",
            });
          if (task.status !== "completed")
            return save({
              status: "waiting",
              reason: "waiting_task",
              message: "等待当前审查任务完成",
            });
          const [result] = await tx
            .select({ result: subjectResults.result })
            .from(subjectResults)
            .where(
              and(
                eq(subjectResults.taskId, request.taskId),
                eq(subjectResults.subjectType, "pr"),
                eq(subjectResults.subjectNumber, request.pullNumber),
                eq(subjectResults.revision, request.headSha),
                eq(subjectResults.published, true),
                sql`lower(${subjectResults.repositoryFullName}) = ${request.repositoryFullName.toLowerCase()}`,
              ),
            )
            .limit(1);
          const reviewDecision = autoMergeReviewDecision(result?.result);
          if (reviewDecision) return save(reviewDecision);
          // 重跑可能留下同一 task 的旧 outbox；同时绑定当前 SHA，任一未交付都先等待。
          const deliveries = await tx
            .select({ publishedAt: outboxEvents.publishedAt })
            .from(outboxEvents)
            .where(
              and(
                eq(outboxEvents.aggregateId, request.taskId),
                eq(outboxEvents.topic, "review.workbench"),
                sql`${outboxEvents.payload}->>'reference' = ${request.headSha}`,
              ),
            );
          if (
            !deliveries.length ||
            deliveries.some((entry) => entry.publishedAt === null)
          )
            return save({
              status: "waiting",
              reason: "workbench_pending",
              message: "等待本次审查结果持久交付到工作台",
            });
          if (
            !input.workbenchGate ||
            (
              await input.workbenchGate(
                request.repositoryFullName,
                requestSignal,
              )
            ).decision !== "pass"
          )
            return save({
              status: "blocked",
              reason: "workbench_blocked",
              message: "当前工作台质量门禁尚未通过",
            });
          const prIdentity = {
            installationId: request.installationId,
            owner,
            name,
            pullNumber: request.pullNumber,
          };
          const current = await github.getPullRequestMergeState(
            prIdentity,
            requestSignal,
          );
          const currentDecision = mergeStateDecision(current, request);
          if (currentDecision) return save(currentDecision);
          if (current.merged) {
            await finishMerged(
              current.mergeCommitSha,
              "GitHub 已确认该版本合并",
            );
            return true;
          }
          const checks = await github.getCommitChecks(
            {
              installationId: request.installationId,
              owner,
              name,
              ref: request.headSha,
            },
            requestSignal,
          );
          const checksDecision = autoMergeChecksDecision(
            checks.checks,
            settings.requiredChecks,
          );
          if (checksDecision) return save(checksDecision);
          const reviewsDecision = autoMergeReviewsDecision(
            await github.listPullRequestReviewStates(prIdentity, requestSignal),
          );
          if (reviewsDecision) return save(reviewsDecision);
          // 在检查完成后再次读取 PR 与最新任务；GitHub 最终 sha 条件阻止这之后的新提交。
          const final = await github.getPullRequestMergeState(
            prIdentity,
            requestSignal,
          );
          const finalDecision = mergeStateDecision(final, request);
          if (finalDecision) return save(finalDecision);
          if (!(await latestTask()))
            return save({
              status: "canceled",
              reason: "review_superseded",
              message: "检查期间出现新审查，等待新结果",
            });
          if (
            (
              await input.workbenchGate(
                request.repositoryFullName,
                requestSignal,
              )
            ).decision !== "pass"
          )
            return save({
              status: "blocked",
              reason: "workbench_blocked",
              message: "检查期间工作台质量门禁发生变化",
            });
          requestSignal.throwIfAborted();
          if (final.merged) {
            await finishMerged(final.mergeCommitSha, "GitHub 已确认该版本合并");
            return true;
          }
          const marker = {
            requestId,
            taskId: request.taskId,
            headSha: request.headSha,
            repositoryFullName: request.repositoryFullName,
            installationId: request.installationId,
            pullNumber: request.pullNumber,
            method: settings.method,
          };
          // 独立 auto-commit，不引用已锁行的外键：先持久记录“可能已经外发”，
          // 再 PUT。即使进程在远端成功后退出，主事务回滚也不会丢掉恢复标记。
          await beforeDeadline(
            (input.journalDb ?? db)
              .insert(outboxEvents)
              .values({
                id: requestId,
                topic: recoveryTopic,
                aggregateId: request.taskId,
                payload: marker,
                availableAt: new Date(now().getTime() + recoveryRetryMs),
              })
              .onConflictDoUpdate({
                target: outboxEvents.id,
                setWhere: eq(outboxEvents.topic, recoveryTopic),
                set: {
                  payload: marker,
                  publishedAt: null,
                  availableAt: new Date(now().getTime() + recoveryRetryMs),
                },
              }),
            requestSignal,
          );
          [recovery] = await tx
            .select()
            .from(outboxEvents)
            .where(
              and(
                eq(outboxEvents.id, requestId),
                eq(outboxEvents.topic, recoveryTopic),
              ),
            )
            .limit(1);
          if (!recovery)
            throw new Error("auto merge write-ahead marker was not committed");
          requestSignal.throwIfAborted();
          const response = await github.mergePullRequest(
            {
              ...prIdentity,
              expectedHeadSha: request.headSha,
              method: settings.method,
            },
            requestSignal,
          );
          if (!response.merged)
            return save({
              status: "blocked",
              reason: "github_merge_refused",
              message: "GitHub 暂未允许合并，将在后续检查中重试",
            });
          await finishMerged(
            response.sha,
            "AI 审查、质量门禁和全部 GitHub 检查通过，已自动合并",
          );
          return true;
        } catch (error) {
          input.onError(error, request.id);
          const retryAfter = rateLimitDelayMs(error);
          return save(
            {
              status: active ? "waiting" : "canceled",
              reason: active ? "github_error" : "recovery_pending",
              message: active
                ? "检查或合并请求暂时失败，将自动重试；未绕过任何检查"
                : "自动合并已取消，仅重试只读确认此前请求的结果",
            },
            retryAfter,
          );
        }
        async function finishMerged(
          sha: string | null,
          message: string,
        ): Promise<void> {
          const timestamp = now();
          await tx
            .update(pullRequestAutoMerges)
            .set({
              status: "merged",
              reason: "merged",
              message,
              mergeCommitSha: sha,
              method: mergeMethod,
              attempts: sql`${pullRequestAutoMerges.attempts} + 1`,
              completedAt: timestamp,
              updatedAt: timestamp,
            })
            .where(eq(pullRequestAutoMerges.id, requestId));
          await tx
            .update(outboxEvents)
            .set({ publishedAt: timestamp })
            .where(
              and(
                eq(outboxEvents.id, requestId),
                eq(outboxEvents.topic, recoveryTopic),
              ),
            );
        }
      });
      if (completed) merged += 1;
    } catch (error) {
      input.onError(error, candidate.id);
    }
  }
  return merged;
}

function mergeStateDecision(
  current: Awaited<ReturnType<MergeClient["getPullRequestMergeState"]>>,
  request: MergeRow,
): AutoMergeDecision | null {
  if (current.headSha !== request.headSha)
    return {
      status: "canceled",
      reason: "stale_head",
      message: "PR 已有新提交，等待新版本审查",
    };
  if (current.merged) return null;
  if (current.state !== "open")
    return { status: "canceled", reason: "pr_closed", message: "PR 已关闭" };
  if (current.draft)
    return {
      status: "blocked",
      reason: "draft",
      message: "草稿 PR 不自动合并",
    };
  if (current.mergeable === null || current.mergeableState === "unknown")
    return {
      status: "waiting",
      reason: "mergeability_pending",
      message: "等待 GitHub 计算可合并状态",
    };
  if (!current.mergeable || current.mergeableState !== "clean")
    return {
      status: "blocked",
      reason: "branch_blocked",
      message: "GitHub 分支保护、冲突或合并条件尚未满足",
    };
  return null;
}
