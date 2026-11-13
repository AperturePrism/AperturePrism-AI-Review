/**
 * 持久任务：创建、领取、心跳和状态转换都在这一处修改任务表。
 *
 * @example
 * const task = await createAnalysisTask(db, request);
 * const lease = await claimTask(db, { workerId: "review-1", leaseDurationMs: 60000 });
 *
 * 默认行为兼容旧版本；TASK_QUEUE_POLICY_JSON 与 TASK_RETRY_POLICY_JSON 可启用
 * 公平领取和自适应重试。具体字段与调用示例见 runtime-policy.ts。
 */
import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as databaseSchema from "../../../packages/database/src/schema.js";
import {
  analysisTasks,
  externalPublications,
  taskAttempts,
  taskEvents,
} from "../../../packages/database/src/schema.js";
import {
  taskAnalysisUsageEventType,
  taskCreatedEventType,
  taskCanceledEventType,
  taskCompletedEventType,
  taskFailedEventType,
  taskHeartbeatEventType,
  taskLeaseRecoveredEventType,
  taskLeasedEventType,
  taskPublishingEventType,
  taskRetryReadyEventType,
  taskRetryScheduledEventType,
  taskStartedEventType,
  type CancelTaskInput,
  type ClaimTaskInput,
  type CreateTaskInput,
  type FailTaskInput,
  type FailureResult,
  type HeartbeatTaskInput,
  type LeasedTask,
  type OwnedTaskInput,
  type TaskCreationResult,
  type TaskType,
} from "../../../packages/domain/src/index.js";
import { parseQueuePolicy, type QueuePolicy } from "./queue.js";
import { planRetry, type RetryPolicy } from "./retry.js";
import { loadTaskRuntimePolicy } from "./runtime-policy.js";

export * from "./retry.js";
export * from "./queue.js";
export * from "./batch.js";
export * from "./plan.js";
export * from "./quota.js";
export * from "./dead-letter.js";
export * from "./runtime-policy.js";
export * from "./timeline.js";
export * from "./operations.js";

type Database = PostgresJsDatabase<typeof databaseSchema>;
type TaskDatabase = Pick<Database, "insert" | "select">;

export type RecordAttemptUsageInput = OwnedTaskInput & {
  attemptNumber: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  provider: string;
  model: string;
};

type PersistedTask = {
  id: string;
  taskType: string;
  status:
    | "queued"
    | "leased"
    | "running"
    | "publishing"
    | "completed"
    | "retry_wait"
    | "failed"
    | "canceled";
  dedupeKey: string;
};

type LeasedTaskRow = PersistedTask & {
  attemptId?: string;
  leaseOwner: string;
  leaseExpiresAt: Date;
  heartbeatAt: Date;
  attemptNumber: number;
  payload: unknown;
};

function toAnalysisTask(task: PersistedTask) {
  return {
    id: task.id,
    taskType: task.taskType as TaskType,
    status: task.status,
    dedupeKey: task.dedupeKey,
  };
}

function toLeasedTask(task: LeasedTaskRow): LeasedTask {
  return {
    ...toAnalysisTask(task),
    leaseOwner: task.leaseOwner,
    leaseExpiresAt: task.leaseExpiresAt,
    heartbeatAt: task.heartbeatAt,
    attemptNumber: task.attemptNumber,
    ...(task.attemptId ? { attemptId: task.attemptId } : {}),
    payload: task.payload,
  };
}

function leaseExpiry(now: Date, leaseDurationMs: number): Date {
  return new Date(now.getTime() + leaseDurationMs);
}

export async function createAnalysisTaskInTransaction(
  db: TaskDatabase,
  input: CreateTaskInput,
): Promise<TaskCreationResult> {
  const inserted = await db
    .insert(analysisTasks)
    .values({
      taskType: input.taskType,
      ...(input.repositoryId === undefined
        ? {}
        : { repositoryId: input.repositoryId }),
      ...(input.subjectNumber === undefined
        ? {}
        : { subjectNumber: input.subjectNumber }),
      subjectRevision: input.subjectRevision,
      policyVersion: input.policyVersion,
      dedupeKey: input.dedupeKey,
      priority: input.priority ?? 0,
      payload: input.payload,
      maxAttempts: input.maxAttempts ?? 3,
    })
    .onConflictDoNothing({ target: analysisTasks.dedupeKey })
    .returning({
      id: analysisTasks.id,
      taskType: analysisTasks.taskType,
      status: analysisTasks.status,
      dedupeKey: analysisTasks.dedupeKey,
    });

  if (inserted.length === 0) {
    const existing = await db
      .select({
        id: analysisTasks.id,
        taskType: analysisTasks.taskType,
        status: analysisTasks.status,
        dedupeKey: analysisTasks.dedupeKey,
      })
      .from(analysisTasks)
      .where(eq(analysisTasks.dedupeKey, input.dedupeKey))
      .limit(1);
    const task = existing[0];
    if (!task) throw new Error("task disappeared after dedupe conflict");
    return {
      outcome: "duplicate",
      task: toAnalysisTask(task),
    };
  }

  const task = inserted[0];
  if (!task) throw new Error("task insert returned no row");

  await db.insert(taskEvents).values({
    taskId: task.id,
    eventType: taskCreatedEventType,
    data: {
      taskId: task.id,
      taskType: task.taskType,
      dedupeKey: task.dedupeKey,
      status: task.status,
    },
  });

  return {
    outcome: "created",
    task: toAnalysisTask(task),
  };
}

export async function createAnalysisTask(
  db: Database,
  input: CreateTaskInput,
): Promise<TaskCreationResult> {
  return db.transaction((tx) => createAnalysisTaskInTransaction(tx, input));
}

export async function claimTask(
  db: Database,
  input: ClaimTaskInput & { policy?: Partial<QueuePolicy> },
): Promise<LeasedTask | null> {
  const now = input.now ?? new Date();
  const expiresAt = leaseExpiry(now, input.leaseDurationMs);
  const configured = input.policy ?? loadTaskRuntimePolicy().queue;
  const policy = configured ? parseQueuePolicy(configured) : undefined;
  if (!input.workerId.trim()) throw new TypeError("workerId must not be empty");
  if (
    !Number.isSafeInteger(input.leaseDurationMs) ||
    input.leaseDurationMs <= 0
  )
    throw new RangeError("leaseDurationMs must be a positive safe integer");
  if (!Number.isFinite(expiresAt.getTime()))
    throw new RangeError("lease expiry must be a valid date");

  return db.transaction(async (tx) => {
    // 启用限额的 worker 共用一把事务锁，检查当前占用和领取新任务不可被穿插。
    // 混用旧领取器不提供全局限额保证；集群应统一配置此环境变量。
    if (policy) await tx.execute(sql`select pg_advisory_xact_lock(721942631)`);
    const active = sql`status in ('leased', 'running', 'publishing') and lease_expires_at > ${now.toISOString()}::timestamptz`;
    const typeFilter = policy
      ? sql`and task_type in (${sql.join(
          policy.allowedTaskTypes.map((type) => sql`${type}`),
          sql`, `,
        )})`
      : sql``;
    const totalLimit = policy?.maxActiveTotal
      ? sql`and (select count(*) from analysis_tasks where ${active}) < ${policy.maxActiveTotal}`
      : sql``;
    const repositoryLimit = policy?.maxActivePerRepository
      ? sql`and (select count(*) from analysis_tasks occupied where occupied.repository_id is not distinct from candidate.repository_id and occupied.status in ('leased', 'running', 'publishing') and occupied.lease_expires_at > ${now.toISOString()}::timestamptz) < ${policy.maxActivePerRepository}`
      : sql``;
    const priority = policy?.agingIntervalMs
      ? sql`priority + least(${policy.maxAgingBoost}, greatest(0, floor(extract(epoch from (${now.toISOString()}::timestamptz - created_at)) * 1000 / ${policy.agingIntervalMs})))`
      : sql`priority`;
    const fairness = policy?.roundRobin
      ? sql`(select count(*) from analysis_tasks occupied where occupied.repository_id is not distinct from candidate.repository_id and occupied.status in ('leased', 'running', 'publishing') and occupied.lease_expires_at > ${now.toISOString()}::timestamptz) asc, `
      : sql``;
    const candidates = await tx.execute<{ id: string }>(sql`
      select id
      from analysis_tasks candidate
      where status = 'queued'
        and next_attempt_at <= ${now.toISOString()}::timestamptz
        and attempt_count < max_attempts
        ${typeFilter} ${totalLimit} ${repositoryLimit}
      order by ${fairness}${priority} desc, next_attempt_at asc, created_at asc, id asc
      for update skip locked
      limit 1
    `);
    const candidate = candidates[0];
    if (!candidate) return null;

    const claimed = await tx
      .update(analysisTasks)
      .set({
        status: "leased",
        leaseOwner: input.workerId,
        leaseExpiresAt: expiresAt,
        heartbeatAt: now,
        attemptCount: sql`${analysisTasks.attemptCount} + 1`,
        updatedAt: now,
      })
      .where(eq(analysisTasks.id, candidate.id))
      .returning({
        id: analysisTasks.id,
        taskType: analysisTasks.taskType,
        status: analysisTasks.status,
        dedupeKey: analysisTasks.dedupeKey,
        leaseOwner: analysisTasks.leaseOwner,
        leaseExpiresAt: analysisTasks.leaseExpiresAt,
        heartbeatAt: analysisTasks.heartbeatAt,
        attemptNumber: analysisTasks.attemptCount,
        payload: analysisTasks.payload,
      });
    const task = claimed[0];
    if (!task || !task.leaseOwner || !task.leaseExpiresAt || !task.heartbeatAt)
      throw new Error("claimed task is missing lease fields");

    const [attempt] = await tx
      .insert(taskAttempts)
      .values({
        taskId: task.id,
        attemptNumber: task.attemptNumber,
        workerId: input.workerId,
        startedAt: now,
      })
      .returning({ id: taskAttempts.id });
    if (!attempt)
      throw new Error("claimed task is missing its durable attempt identity");
    await tx.insert(taskEvents).values({
      taskId: task.id,
      eventType: taskLeasedEventType,
      data: {
        taskId: task.id,
        workerId: input.workerId,
        attemptNumber: task.attemptNumber,
        leaseExpiresAt: task.leaseExpiresAt.toISOString(),
      },
    });

    return toLeasedTask({
      ...task,
      attemptId: attempt.id,
      leaseOwner: task.leaseOwner,
      leaseExpiresAt: task.leaseExpiresAt,
      heartbeatAt: task.heartbeatAt,
    });
  });
}

export async function heartbeatTask(
  db: Database,
  input: HeartbeatTaskInput,
): Promise<LeasedTask | null> {
  const now = input.now ?? new Date();
  const expiresAt = leaseExpiry(now, input.leaseDurationMs);
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(analysisTasks)
      .set({
        leaseExpiresAt: expiresAt,
        heartbeatAt: now,
        updatedAt: now,
      })
      .where(
        sql`${analysisTasks.id} = ${input.taskId}
          and ${analysisTasks.leaseOwner} = ${input.workerId}
          and ${analysisTasks.status} in ('leased', 'running', 'publishing')
          and ${analysisTasks.leaseExpiresAt} > ${now.toISOString()}::timestamptz`,
      )
      .returning({
        id: analysisTasks.id,
        taskType: analysisTasks.taskType,
        status: analysisTasks.status,
        dedupeKey: analysisTasks.dedupeKey,
        leaseOwner: analysisTasks.leaseOwner,
        leaseExpiresAt: analysisTasks.leaseExpiresAt,
        heartbeatAt: analysisTasks.heartbeatAt,
        attemptNumber: analysisTasks.attemptCount,
        payload: analysisTasks.payload,
      });
    const task = updated[0];
    if (!task || !task.leaseOwner || !task.leaseExpiresAt || !task.heartbeatAt)
      return null;

    await tx.insert(taskEvents).values({
      taskId: task.id,
      eventType: taskHeartbeatEventType,
      data: {
        taskId: task.id,
        workerId: input.workerId,
        leaseExpiresAt: task.leaseExpiresAt.toISOString(),
      },
    });
    return toLeasedTask({
      ...task,
      leaseOwner: task.leaseOwner,
      leaseExpiresAt: task.leaseExpiresAt,
      heartbeatAt: task.heartbeatAt,
      attemptNumber: task.attemptNumber,
    });
  });
}

export async function recoverExpiredLeases(
  db: Database,
  now = new Date(),
): Promise<number> {
  return db.transaction(async (tx) => {
    // A crashed worker consumes its attempt just like an explicit failure.
    // Decide atomically so concurrent sweeps cannot requeue an exhausted task.
    const exhausted = sql`${analysisTasks.attemptCount} >= ${analysisTasks.maxAttempts}`;
    const recovered = await tx
      .update(analysisTasks)
      .set({
        status: sql`case when ${exhausted} then 'failed'::task_status else 'queued'::task_status end`,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        nextAttemptAt: sql`case when ${exhausted} then ${analysisTasks.nextAttemptAt} else ${now.toISOString()}::timestamptz end`,
        lastErrorCategory: sql`case when ${exhausted} then 'lease_expired' else ${analysisTasks.lastErrorCategory} end`,
        updatedAt: now,
      })
      .where(
        sql`${analysisTasks.status} in ('leased', 'running', 'publishing')
          and ${analysisTasks.leaseExpiresAt} <= ${now.toISOString()}::timestamptz`,
      )
      .returning({
        id: analysisTasks.id,
        status: analysisTasks.status,
        attemptNumber: analysisTasks.attemptCount,
      });

    for (const task of recovered) {
      await tx
        .update(taskAttempts)
        .set({ finishedAt: now, errorCategory: "lease_expired" })
        .where(
          sql`${taskAttempts.taskId} = ${task.id}
            and ${taskAttempts.finishedAt} is null`,
        );
      await tx.insert(taskEvents).values({
        taskId: task.id,
        eventType:
          task.status === "failed"
            ? taskFailedEventType
            : taskLeaseRecoveredEventType,
        data: {
          taskId: task.id,
          recoveredAt: now.toISOString(),
          ...(task.status === "failed"
            ? {
                errorCategory: "lease_expired",
                attemptNumber: task.attemptNumber,
              }
            : {}),
        },
      });
    }
    return recovered.length;
  });
}

export async function startTask(
  db: Database,
  input: OwnedTaskInput,
): Promise<boolean> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(analysisTasks)
      .set({ status: "running", updatedAt: now })
      .where(
        sql`${analysisTasks.id} = ${input.taskId}
          and ${analysisTasks.leaseOwner} = ${input.workerId}
          and ${analysisTasks.status} = 'leased'
          and ${analysisTasks.leaseExpiresAt} > ${now.toISOString()}::timestamptz`,
      )
      .returning({ id: analysisTasks.id });
    if (updated.length === 0) return false;
    await tx.insert(taskEvents).values({
      taskId: input.taskId,
      eventType: taskStartedEventType,
      data: { taskId: input.taskId, workerId: input.workerId },
    });
    return true;
  });
}

export async function beginPublishing(
  db: Database,
  input: OwnedTaskInput,
): Promise<boolean> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(analysisTasks)
      .set({ status: "publishing", updatedAt: now })
      .where(
        sql`${analysisTasks.id} = ${input.taskId}
          and ${analysisTasks.leaseOwner} = ${input.workerId}
          and ${analysisTasks.status} = 'running'
          and ${analysisTasks.leaseExpiresAt} > ${now.toISOString()}::timestamptz`,
      )
      .returning({ id: analysisTasks.id });
    if (updated.length === 0) return false;
    await tx.insert(taskEvents).values({
      taskId: input.taskId,
      eventType: taskPublishingEventType,
      data: { taskId: input.taskId, workerId: input.workerId },
    });
    return true;
  });
}

export async function completeTask(
  db: Database,
  input: OwnedTaskInput,
): Promise<boolean> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(analysisTasks)
      .set({
        status: "completed",
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        lastErrorCategory: null,
        updatedAt: now,
      })
      .where(
        sql`${analysisTasks.id} = ${input.taskId}
          and ${analysisTasks.leaseOwner} = ${input.workerId}
          and ${analysisTasks.status} = 'publishing'
          and ${analysisTasks.leaseExpiresAt} > ${now.toISOString()}::timestamptz`,
      )
      .returning({ id: analysisTasks.id });
    if (updated.length === 0) return false;
    await tx
      .update(taskAttempts)
      .set({ finishedAt: now })
      .where(
        sql`${taskAttempts.taskId} = ${input.taskId}
          and ${taskAttempts.workerId} = ${input.workerId}
          and ${taskAttempts.finishedAt} is null`,
      );
    await tx.insert(taskEvents).values({
      taskId: input.taskId,
      eventType: taskCompletedEventType,
      data: { taskId: input.taskId, workerId: input.workerId },
    });
    return true;
  });
}

export async function failTask(
  db: Database,
  input: FailTaskInput & {
    retryPolicy?: Partial<RetryPolicy>;
    retryAfterMs?: number;
  },
): Promise<FailureResult | null> {
  const now = input.now ?? new Date();
  const retryPolicy = input.retryPolicy ?? loadTaskRuntimePolicy().retry;
  if (!Number.isSafeInteger(input.retryDelayMs) || input.retryDelayMs < 0)
    throw new RangeError("retryDelayMs must be a nonnegative safe integer");
  return db.transaction(async (tx) => {
    const owned = await tx
      .select({
        attemptCount: analysisTasks.attemptCount,
        maxAttempts: analysisTasks.maxAttempts,
        createdAt: analysisTasks.createdAt,
      })
      .from(analysisTasks)
      .where(
        sql`${analysisTasks.id} = ${input.taskId}
          and ${analysisTasks.leaseOwner} = ${input.workerId}
          and ${analysisTasks.status} in ('running', 'publishing')
          and ${analysisTasks.leaseExpiresAt} > ${now.toISOString()}::timestamptz`,
      )
      .limit(1);
    const task = owned[0];
    if (!task) return null;

    const decision = retryPolicy
      ? planRetry({
          attempt: task.attemptCount,
          maxAttempts: task.maxAttempts,
          category: input.errorCategory,
          now,
          key: input.taskId,
          startedAt: task.createdAt,
          policy: retryPolicy,
          ...(input.retryAfterMs !== undefined
            ? { retryAfterMs: input.retryAfterMs }
            : {}),
        })
      : undefined;
    // 旧提交的 diff 已不再对应当前 head，重复分析无法让它重新有效。
    const exhausted =
      input.errorCategory === "stale_revision" ||
      (decision
        ? decision.action === "stop"
        : task.attemptCount >= task.maxAttempts);
    const nextAttemptAt = exhausted
      ? null
      : decision?.action === "retry"
        ? decision.nextAttemptAt
        : new Date(now.getTime() + input.retryDelayMs);
    const updated = await tx
      .update(analysisTasks)
      .set({
        status: exhausted ? "failed" : "retry_wait",
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        ...(nextAttemptAt ? { nextAttemptAt } : {}),
        lastErrorCategory: input.errorCategory,
        updatedAt: now,
      })
      .where(
        sql`${analysisTasks.id} = ${input.taskId}
          and ${analysisTasks.leaseOwner} = ${input.workerId}
          and ${analysisTasks.status} in ('running', 'publishing')
          and ${analysisTasks.leaseExpiresAt} > ${now.toISOString()}::timestamptz`,
      )
      .returning({ id: analysisTasks.id });
    if (updated.length === 0) return null;
    await tx
      .update(taskAttempts)
      .set({ finishedAt: now, errorCategory: input.errorCategory })
      .where(
        sql`${taskAttempts.taskId} = ${input.taskId}
          and ${taskAttempts.workerId} = ${input.workerId}
          and ${taskAttempts.finishedAt} is null`,
      );
    await tx.insert(taskEvents).values({
      taskId: input.taskId,
      eventType: exhausted ? taskFailedEventType : taskRetryScheduledEventType,
      data: {
        taskId: input.taskId,
        workerId: input.workerId,
        errorCategory: input.errorCategory,
        attemptNumber: task.attemptCount,
        ...(decision ? { retryReason: decision.reason } : {}),
        // 二次截断：事件是排查失败的唯一持久记录，不能因调用方疏忽而写入长文本。
        ...(input.errorMessage
          ? { errorMessage: input.errorMessage.slice(0, 500) }
          : {}),
        ...(nextAttemptAt
          ? { nextAttemptAt: nextAttemptAt.toISOString() }
          : {}),
      },
    });
    return {
      status: exhausted ? "failed" : "retry_wait",
      nextAttemptAt,
    };
  });
}

/** 显式策略入口，供不通过环境变量配置的队列管理器调用。 */
export async function claimTaskWithPolicy(
  db: Database,
  input: ClaimTaskInput & { policy: Partial<QueuePolicy> },
): Promise<LeasedTask | null> {
  return claimTask(db, input);
}

export async function cancelTask(
  db: Database,
  input: CancelTaskInput,
): Promise<boolean> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const canceled = await tx
      .update(analysisTasks)
      .set({
        status: "canceled",
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        lastErrorCategory: "canceled",
        updatedAt: now,
      })
      .where(
        sql`${analysisTasks.id} = ${input.taskId}
          and ${analysisTasks.status} in ('queued', 'leased', 'running', 'publishing', 'retry_wait')`,
      )
      .returning({ id: analysisTasks.id });
    if (canceled.length === 0) return false;

    await tx
      .update(taskAttempts)
      .set({ finishedAt: now, errorCategory: "canceled" })
      .where(
        sql`${taskAttempts.taskId} = ${input.taskId}
          and ${taskAttempts.finishedAt} is null`,
      );
    await tx.insert(taskEvents).values({
      taskId: input.taskId,
      eventType: taskCanceledEventType,
      data: {
        taskId: input.taskId,
        reason: input.reason,
        canceledAt: now.toISOString(),
      },
    });
    return true;
  });
}

/**
 * 取消某个仓库下指定 subject（issue/PR）的所有活跃分析任务（#540 借鉴）。
 *
 * 语义与 cancelTask 一致，只是按「taskType + repositoryId + subjectNumber」批量
 * 匹配，而不是单个 taskId。GitHub 侧收到 issue 的 `closed`/`deleted` 事件时调用：
 * 关闭/删除的 issue 不再需要继续分析，排队与运行中的任务都应取消，避免过期
 * worker 在清理后把已关闭记录的评论补发出去（竞态保护）。
 *
 * 只取消非终态任务（queued/leased/running/publishing/retry_wait）；运行中的任务
 * 由 worker 心跳在下一次检测到 lease 被清空而中断（见 runOnce 的 lease_lost 路径）。
 */
export async function cancelSubjectTasks(
  db: Database,
  input: {
    taskType: string;
    repositoryId: string;
    subjectNumber: number;
    reason?: string;
    now?: Date;
  },
): Promise<number> {
  const now = input.now ?? new Date();
  const reason = input.reason ?? "subject_closed_or_deleted";
  return db.transaction(async (tx) => {
    const canceled = await tx
      .update(analysisTasks)
      .set({
        status: "canceled",
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        lastErrorCategory: "canceled",
        updatedAt: now,
      })
      .where(
        sql`${analysisTasks.taskType} = ${input.taskType}
          and ${analysisTasks.repositoryId} = ${input.repositoryId}
          and ${analysisTasks.subjectNumber} = ${input.subjectNumber}
          and ${analysisTasks.status} in ('queued', 'leased', 'running', 'publishing', 'retry_wait')`,
      )
      .returning({ id: analysisTasks.id });
    if (canceled.length === 0) return 0;

    for (const task of canceled) {
      await tx
        .update(taskAttempts)
        .set({ finishedAt: now, errorCategory: "canceled" })
        .where(
          sql`${taskAttempts.taskId} = ${task.id}
            and ${taskAttempts.finishedAt} is null`,
        );
      await tx.insert(taskEvents).values({
        taskId: task.id,
        eventType: taskCanceledEventType,
        data: {
          taskId: task.id,
          reason,
          canceledAt: now.toISOString(),
        },
      });
    }
    return canceled.length;
  });
}

/**
 * Resets a finished task (failed / canceled) back to `queued` so a worker can
 * pick it up again. Used by the "re-run" action in the WebUI. Attempts are
 * zeroed so the re-run gets a fresh budget; a `task.retry_ready` event records
 * the re-queue. Returns false when the task is not in a finished state.
 */
export async function resetTaskToQueued(
  db: Database,
  input: { taskId: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(analysisTasks)
      .set({
        status: "queued",
        attemptCount: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        // next_attempt_at 是 NOT NULL，重跑任务立即可被领取。
        nextAttemptAt: now,
        lastErrorCategory: null,
        updatedAt: now,
      })
      .where(
        sql`${analysisTasks.id} = ${input.taskId}
          and ${analysisTasks.status} in ('failed', 'canceled')`,
      )
      .returning({ id: analysisTasks.id });
    if (updated.length === 0) return false;
    // Reopening a task invalidates the previous Check Run completion ack.
    // Keep task -> publication lock order consistent with reconciliation.
    await tx
      .update(externalPublications)
      .set({ checkRunCompletedAt: null })
      .where(
        sql`${externalPublications.taskId} = ${input.taskId}
          and ${externalPublications.channel} = 'check_run'`,
      );
    // 重跑是全新执行：清掉旧 attempts，避免 worker 重新领取时插入
    // attempt_number=1 与历史记录撞唯一约束 (task_id, attempt_number)。
    await tx.delete(taskAttempts).where(eq(taskAttempts.taskId, input.taskId));
    await tx.insert(taskEvents).values({
      taskId: input.taskId,
      eventType: taskRetryReadyEventType,
      data: {
        taskId: input.taskId,
        reason: "manual rerun",
        rerunAt: now.toISOString(),
      },
    });
    return true;
  });
}

/**
 * Records model usage for the current attempt as an event. The worker is the
 * only caller; it never mutates task state itself, and the event keeps token
 * and duration data out of the attempt row until a schema change is wanted.
 */
export async function recordAttemptUsage(
  db: Database,
  input: RecordAttemptUsageInput,
): Promise<boolean> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    // 旧执行器的模型可能比租约活得更久。只有当前尝试仍持有任务，才允许它写
    // 用量；否则陈旧 usage 会污染重跑后的成本统计与批次诊断。
    const [owned] = await tx
      .select({ id: analysisTasks.id })
      .from(analysisTasks)
      .where(
        sql`${analysisTasks.id} = ${input.taskId}
        and ${analysisTasks.leaseOwner} = ${input.workerId}
        and ${analysisTasks.attemptCount} = ${input.attemptNumber}
        and ${analysisTasks.status} in ('leased', 'running', 'publishing')
        and ${analysisTasks.leaseExpiresAt} > ${now.toISOString()}::timestamptz`,
      )
      .for("update")
      .limit(1);
    if (!owned) return false;
    await tx.insert(taskEvents).values({
      taskId: input.taskId,
      eventType: taskAnalysisUsageEventType,
      data: {
        taskId: input.taskId,
        workerId: input.workerId,
        attemptNumber: input.attemptNumber,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        durationMs: input.durationMs,
        provider: input.provider,
        model: input.model,
      },
    });
    return true;
  });
}

export async function releaseDueRetries(
  db: Database,
  now = new Date(),
): Promise<number> {
  return db.transaction(async (tx) => {
    const released = await tx
      .update(analysisTasks)
      .set({ status: "queued", updatedAt: now })
      .where(
        sql`${analysisTasks.status} = 'retry_wait'
          and ${analysisTasks.nextAttemptAt} <= ${now.toISOString()}::timestamptz`,
      )
      .returning({ id: analysisTasks.id });
    for (const task of released) {
      await tx.insert(taskEvents).values({
        taskId: task.id,
        eventType: taskRetryReadyEventType,
        data: { taskId: task.id, readyAt: now.toISOString() },
      });
    }
    return released.length;
  });
}
