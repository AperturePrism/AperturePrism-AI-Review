/**
 * 队列运维：从真实任务表取得预览、审计时间线和带授权范围的批量动作。
 *
 * @example
 * const report = await listQueuePreview(db, { repositoryIds: allowedRepositories, now: new Date() });
 * const outcome = await operateTasks(db, { operation: "cancel", ids, repositoryIds: allowedRepositories, reason: "PR 已过期" });
 *
 * repositoryIds 是调用方已经核实的可见范围。undefined 仅供系统管理员；空数组
 * 表示没有仓库权限。此主体不会自行推断 HTTP 用户身份。
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../../database/src/schema.js";
import type { TaskType } from "../../domain/src/index.js";
import { cancelTask, resetTaskToQueued } from "./index.js";
import {
  previewQueue,
  summarizeQueue,
  type QueuePolicy,
  type QueueTask,
} from "./queue.js";
import { inspectTaskTimeline } from "./timeline.js";

type Database = PostgresJsDatabase<typeof schema>;
export type TaskScope = {
  repositoryIds?: readonly string[];
  includeGlobal?: boolean;
};

/** SQL 的空范围必须生成 false，不能因数组为空而省略授权条件。 */
export function taskScopeCondition(scope: TaskScope) {
  if (scope.repositoryIds === undefined) return sql`true`;
  const ids = [...new Set(scope.repositoryIds)];
  const repositories = ids.length
    ? inArray(schema.analysisTasks.repositoryId, ids)
    : sql`false`;
  return scope.includeGlobal
    ? sql`(${repositories} or ${schema.analysisTasks.repositoryId} is null)`
    : repositories;
}

/**
 * 读取有界任务快照并返回公平排序建议。limited 表示窗口被截断，统计不能当成
 * 整个库的精确总计；接口明确返回此标志，避免大库监控误报为零积压。
 */
export async function listQueuePreview(
  db: Database,
  input: TaskScope & {
    now?: Date;
    limit?: number;
    sampleLimit?: number;
    policy?: Partial<QueuePolicy>;
  } = {},
) {
  const now = input.now ?? new Date();
  const sampleLimit = input.sampleLimit ?? 5_000;
  if (
    !Number.isSafeInteger(sampleLimit) ||
    sampleLimit < 1 ||
    sampleLimit > 50_000
  )
    throw new RangeError("sampleLimit must be between 1 and 50000");
  const rows = await db
    .select({
      id: schema.analysisTasks.id,
      repositoryId: schema.analysisTasks.repositoryId,
      taskType: schema.analysisTasks.taskType,
      status: schema.analysisTasks.status,
      priority: schema.analysisTasks.priority,
      createdAt: schema.analysisTasks.createdAt,
      nextAttemptAt: schema.analysisTasks.nextAttemptAt,
      attemptCount: schema.analysisTasks.attemptCount,
      maxAttempts: schema.analysisTasks.maxAttempts,
      leaseOwner: schema.analysisTasks.leaseOwner,
      leaseExpiresAt: schema.analysisTasks.leaseExpiresAt,
    })
    .from(schema.analysisTasks)
    .where(
      and(
        taskScopeCondition(input),
        inArray(schema.analysisTasks.status, [
          "queued",
          "leased",
          "running",
          "publishing",
          "retry_wait",
        ]),
      ),
    )
    .orderBy(asc(schema.analysisTasks.createdAt), asc(schema.analysisTasks.id))
    .limit(sampleLimit + 1);
  const tasks: QueueTask[] = rows
    .slice(0, sampleLimit)
    .map((row) => ({ ...row, taskType: row.taskType as TaskType }));
  return {
    ...previewQueue(tasks, {
      now,
      ...(input.limit ? { limit: input.limit } : {}),
      ...(input.policy ? { policy: input.policy } : {}),
    }),
    summary: summarizeQueue(tasks, now),
    sampled: tasks.length,
    limited: rows.length > sampleLimit,
  };
}

/** 可见任务的审计摘要，不满足范围返回 null，避免通过任务 ID 探测隐藏仓库。 */
export async function getTaskTimeline(
  db: Database,
  input: TaskScope & { taskId: string; now?: Date; eventLimit?: number },
) {
  const eventLimit = input.eventLimit ?? 5_000;
  if (
    !Number.isSafeInteger(eventLimit) ||
    eventLimit < 1 ||
    eventLimit > 50_000
  )
    throw new RangeError("eventLimit must be between 1 and 50000");
  const [task] = await db
    .select({ id: schema.analysisTasks.id })
    .from(schema.analysisTasks)
    .where(
      and(eq(schema.analysisTasks.id, input.taskId), taskScopeCondition(input)),
    )
    .limit(1);
  if (!task) return null;
  const events = await db
    .select({
      id: schema.taskEvents.id,
      eventType: schema.taskEvents.eventType,
      createdAt: schema.taskEvents.createdAt,
      data: schema.taskEvents.data,
    })
    .from(schema.taskEvents)
    .where(eq(schema.taskEvents.taskId, task.id))
    .orderBy(asc(schema.taskEvents.createdAt), asc(schema.taskEvents.id))
    .limit(eventLimit + 1);
  return {
    taskId: task.id,
    limited: events.length > eventLimit,
    report: inspectTaskTimeline(
      events.slice(0, eventLimit),
      input.now ? { now: input.now } : {},
    ),
  };
}

export type TaskOperationResult = {
  id: string;
  outcome: "changed" | "unchanged" | "not_found";
};

/**
 * 批量动作逐项复用状态机。权限只读一次后仍在事务内持有任务锁，范围校验与
 * 修改之间不会被其他操作换掉仓库。错误不吞掉，入口据此返回真实失败。
 */
export async function operateTasks(
  db: Database,
  input: TaskScope & {
    operation: "cancel" | "retry";
    ids: readonly string[];
    reason: string;
    now?: Date;
  },
): Promise<{ changed: number; results: TaskOperationResult[] }> {
  if (!["cancel", "retry"].includes(input.operation))
    throw new TypeError("operation must be cancel or retry");
  if (
    !Array.isArray(input.ids) ||
    input.ids.length < 1 ||
    input.ids.length > 500
  )
    throw new RangeError("ids must contain 1 to 500 task IDs");
  const ids = [...new Set(input.ids.map((id) => id.trim()))];
  if (ids.some((id) => !id)) throw new TypeError("task IDs must not be empty");
  const reason = input.reason.trim();
  if (!reason || reason.length > 500)
    throw new TypeError("reason must contain 1 to 500 characters");
  const now = input.now ?? new Date();
  const results: TaskOperationResult[] = [];
  // 排序锁顺序，两个批量请求包含相同任务但顺序不同时不会互相死锁。
  for (const id of [...ids].sort()) {
    const outcome = await db.transaction(async (tx) => {
      const [task] = await tx
        .select({ id: schema.analysisTasks.id })
        .from(schema.analysisTasks)
        .where(and(eq(schema.analysisTasks.id, id), taskScopeCondition(input)))
        .for("update")
        .limit(1);
      if (!task) return "not_found" as const;
      const changed =
        input.operation === "cancel"
          ? await cancelTask(tx as unknown as Database, {
              taskId: id,
              reason,
              now,
            })
          : await resetTaskToQueued(tx as unknown as Database, {
              taskId: id,
              now,
            });
      if (changed && input.operation === "retry")
        await tx
          .insert(schema.taskEvents)
          .values({
            taskId: id,
            eventType: "task.operator_retry",
            data: { reason, requestedAt: now.toISOString() },
          });
      return changed ? ("changed" as const) : ("unchanged" as const);
    });
    results.push({ id, outcome });
  }
  const byId = new Map(results.map((result) => [result.id, result]));
  return {
    changed: results.filter((result) => result.outcome === "changed").length,
    results: ids.map((id) => byId.get(id)!),
  };
}
