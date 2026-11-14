/**
 * 批次：一次提交多项分析，按业务键幂等，并在任务事件里留下批次归属。
 *
 * @example
 * const batch = await createTaskBatch(db, { key: "release-42", items: [{ key: "pr-8", task: request }] });
 * const progress = await getTaskBatch(db, "release-42");
 *
 * 任务仍然只存在 analysis_tasks。批次只保留成员关系和输入指纹，不复制 payload。
 */
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../../database/src/schema.js";
import type {
  CreateTaskInput,
  TaskCreationResult,
  TaskStatus,
} from "../../domain/src/index.js";
import { createAnalysisTaskInTransaction, cancelTask } from "./index.js";

type Database = PostgresJsDatabase<typeof schema>;
export type BatchRequest = {
  key: string;
  items: readonly { key: string; task: Omit<CreateTaskInput, "dedupeKey"> }[];
  label?: string;
  now?: Date;
};
export type BatchResult = {
  key: string;
  requestHash: string;
  created: number;
  duplicate: number;
  items: { key: string; result: TaskCreationResult }[];
};
export type BatchProgress = {
  key: string;
  label: string;
  createdAt: string;
  requestHash: string;
  total: number;
  completed: number;
  failed: number;
  canceled: number;
  active: number;
  finished: boolean;
  completionRatio: number;
  items: {
    key: string;
    taskId: string;
    taskType: string;
    status: TaskStatus;
    attemptCount: number;
    lastErrorCategory: string | null;
  }[];
};

export class BatchConflictError extends Error {
  readonly status = 409;
  constructor(readonly batchKey: string) {
    super(`batch ${batchKey} was already submitted with different items`);
    this.name = "BatchConflictError";
  }
}

/** JSON 键顺序不影响幂等判断；对象字段排序，数组顺序保留业务含义。 */
export function stableTaskJson(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item))
        throw new TypeError("task payload numbers must be finite");
      return item;
    }
    if (typeof item !== "object")
      throw new TypeError("task payload must contain JSON values only");
    if (seen.has(item))
      throw new TypeError("task payload must not contain cycles");
    seen.add(item);
    let result: unknown;
    if (Array.isArray(item)) result = item.map(normalize);
    else {
      if (
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      )
        throw new TypeError("task payload must contain plain objects only");
      result = Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    seen.delete(item);
    return result;
  };
  return JSON.stringify(normalize(value));
}

/** 批次业务键始终经过摘要，不把用户提供的冒号或通配符当成任务键结构。 */
export function batchTaskKey(batchKey: string, itemKey: string): string {
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  return `batch:${hash(batchKey.trim())}:${hash(itemKey.trim())}`;
}

/** 校验一次批次边界；返回规范化输入，后续数据库流程不再重复猜测字段类型。 */
export function parseBatchRequest(
  request: BatchRequest,
): BatchRequest & { requestHash: string } {
  const key = request.key.trim();
  if (!key || key.length > 200)
    throw new TypeError("batch key must contain 1 to 200 characters");
  if (
    !Array.isArray(request.items) ||
    request.items.length < 1 ||
    request.items.length > 500
  )
    throw new RangeError("batch must contain 1 to 500 items");
  const keys = new Set<string>();
  const items = request.items.map((item) => {
    const itemKey = item.key.trim();
    if (!itemKey || itemKey.length > 200)
      throw new TypeError("item key must contain 1 to 200 characters");
    if (keys.has(itemKey))
      throw new TypeError(`duplicate batch item key: ${itemKey}`);
    keys.add(itemKey);
    if (
      !["issue_analysis", "pr_review", "repository_index"].includes(
        item.task.taskType,
      )
    )
      throw new TypeError(`unknown task type for batch item ${itemKey}`);
    if (!item.task.subjectRevision.trim() || !item.task.policyVersion.trim())
      throw new TypeError(
        `revision and policy version are required for batch item ${itemKey}`,
      );
    if (
      item.task.subjectNumber !== undefined &&
      (!Number.isSafeInteger(item.task.subjectNumber) ||
        item.task.subjectNumber < 1)
    )
      throw new RangeError(
        `subjectNumber must be positive for batch item ${itemKey}`,
      );
    if (
      item.task.priority !== undefined &&
      (!Number.isSafeInteger(item.task.priority) ||
        Math.abs(item.task.priority) > 2_147_483_647)
    )
      throw new RangeError(
        `priority must fit a PostgreSQL integer for batch item ${itemKey}`,
      );
    if (
      item.task.maxAttempts !== undefined &&
      (!Number.isSafeInteger(item.task.maxAttempts) ||
        item.task.maxAttempts < 1 ||
        item.task.maxAttempts > 100)
    )
      throw new RangeError(
        `maxAttempts must be between 1 and 100 for batch item ${itemKey}`,
      );
    stableTaskJson(item.task.payload);
    return {
      key: itemKey,
      task: {
        ...item.task,
        subjectRevision: item.task.subjectRevision.trim(),
        policyVersion: item.task.policyVersion.trim(),
      },
    };
  });
  const label = request.label?.trim() ?? "";
  if (label.length > 200)
    throw new RangeError("batch label must not exceed 200 characters");
  if (request.now && !Number.isFinite(request.now.getTime()))
    throw new RangeError("now must be a valid date");
  // 成员顺序只影响展示，不影响“同一次请求”的含义。
  const requestHash = createHash("sha256")
    .update(
      stableTaskJson([...items].sort((a, b) => a.key.localeCompare(b.key))),
    )
    .digest("hex");
  return { ...request, key, label, items, requestHash };
}

/**
 * 原子创建批次。所有任务和成员事件同事务提交；任意一项失败就全部回滚。
 * 同键并发请求由 PostgreSQL 事务 advisory lock 串行化，不依赖单机内存锁。
 */
export async function createTaskBatch(
  db: Database,
  request: BatchRequest,
): Promise<BatchResult> {
  const parsed = parseBatchRequest(request);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`task-batch:${parsed.key}`}, 0))`,
    );
    const existing = await tx
      .select({ data: schema.taskEvents.data })
      .from(schema.taskEvents)
      .where(
        sql`${schema.taskEvents.eventType} = 'task.batch_member' and ${schema.taskEvents.data}->>'batchKey' = ${parsed.key}`,
      )
      .limit(1);
    const metadata = existing[0]?.data as { requestHash?: string } | undefined;
    if (metadata && metadata.requestHash !== parsed.requestHash)
      throw new BatchConflictError(parsed.key);
    const items: BatchResult["items"] = [];
    for (const item of parsed.items) {
      const result = await createAnalysisTaskInTransaction(tx, {
        ...item.task,
        dedupeKey: batchTaskKey(parsed.key, item.key),
      });
      if (!metadata) {
        await tx.insert(schema.taskEvents).values({
          taskId: result.task.id,
          eventType: "task.batch_member",
          data: {
            batchKey: parsed.key,
            itemKey: item.key,
            label: parsed.label,
            requestHash: parsed.requestHash,
            createdAt: (parsed.now ?? new Date()).toISOString(),
          },
        });
      }
      items.push({ key: item.key, result });
    }
    return {
      key: parsed.key,
      requestHash: parsed.requestHash,
      created: items.filter((item) => item.result.outcome === "created").length,
      duplicate: items.filter((item) => item.result.outcome === "duplicate")
        .length,
      items,
    };
  });
}

/** 从当前任务状态计算批次进度；批次不会存一份容易过期的完成计数。 */
export async function getTaskBatch(
  db: Database,
  key: string,
): Promise<BatchProgress | null> {
  const normalized = key.trim();
  if (!normalized || normalized.length > 200)
    throw new TypeError("batch key must contain 1 to 200 characters");
  const rows = await db
    .select({
      data: schema.taskEvents.data,
      createdAt: schema.taskEvents.createdAt,
      taskId: schema.analysisTasks.id,
      taskType: schema.analysisTasks.taskType,
      status: schema.analysisTasks.status,
      attemptCount: schema.analysisTasks.attemptCount,
      lastErrorCategory: schema.analysisTasks.lastErrorCategory,
    })
    .from(schema.taskEvents)
    .innerJoin(
      schema.analysisTasks,
      eq(schema.analysisTasks.id, schema.taskEvents.taskId),
    )
    .where(
      sql`${schema.taskEvents.eventType} = 'task.batch_member' and ${schema.taskEvents.data}->>'batchKey' = ${normalized}`,
    )
    .orderBy(asc(schema.taskEvents.createdAt), asc(schema.analysisTasks.id));
  if (!rows.length) return null;
  const first = rows[0]!;
  const firstData = first.data as { label: string; requestHash: string };
  const items = rows.map((row) => ({
    key: (row.data as { itemKey: string }).itemKey,
    taskId: row.taskId,
    taskType: row.taskType,
    status: row.status,
    attemptCount: row.attemptCount,
    lastErrorCategory: row.lastErrorCategory,
  }));
  const completed = items.filter((item) => item.status === "completed").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const canceled = items.filter((item) => item.status === "canceled").length;
  const active = items.length - completed - failed - canceled;
  return {
    key: normalized,
    label: firstData.label,
    createdAt: first.createdAt.toISOString(),
    requestHash: firstData.requestHash,
    total: items.length,
    completed,
    failed,
    canceled,
    active,
    finished: active === 0,
    completionRatio: (completed + failed + canceled) / items.length,
    items,
  };
}

/** 取消批次的非终态成员；逐任务复用已有租约撤销与事件写入规则。 */
export async function cancelTaskBatch(
  db: Database,
  input: { key: string; reason: string; now?: Date },
): Promise<{ total: number; canceled: number }> {
  const reason = input.reason.trim();
  if (!reason || reason.length > 500)
    throw new TypeError("reason must contain 1 to 500 characters");
  const batch = await getTaskBatch(db, input.key);
  if (!batch) return { total: 0, canceled: 0 };
  let canceled = 0;
  for (const item of batch.items) {
    if (
      await cancelTask(db, {
        taskId: item.taskId,
        reason,
        ...(input.now ? { now: input.now } : {}),
      })
    )
      canceled += 1;
  }
  return { total: batch.total, canceled };
}

/** 按可访问的任务 ID 限制查询，供有仓库授权边界的管理 API 使用。 */
export async function batchKeysForTasks(
  db: Database,
  taskIds: readonly string[],
): Promise<string[]> {
  if (taskIds.length === 0) return [];
  if (taskIds.length > 1_000)
    throw new RangeError("at most 1000 task IDs may be queried");
  const rows = await db
    .select({ data: schema.taskEvents.data })
    .from(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.eventType, "task.batch_member"),
        inArray(schema.taskEvents.taskId, [...taskIds]),
      ),
    );
  return [
    ...new Set(rows.map((row) => (row.data as { batchKey: string }).batchKey)),
  ].sort();
}
