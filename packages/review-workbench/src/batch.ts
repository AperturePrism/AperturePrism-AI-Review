/**
 * 批次把多个审查组成可暂停、可恢复的执行计划；租约确保同一项不会被同时领取。
 * @example claimBatchItem(context, {id:batchId, worker:'worker-1', leaseMs:60000});
 */
import type { Batch, BatchItem } from "./types.js";
import { audit, identity, touch, type CommandContext } from "./audit.js";
import {
  array,
  choice,
  findRecord,
  integer,
  metadata,
  object,
  optionalText,
  revision,
  strings,
  text,
  WorkbenchError,
} from "./utils/input.js";

/** 使用拓扑排序检查依赖；大批次不递归，长链也不会撑爆调用栈。 */
export function validateBatchDependencies(
  items: readonly BatchItem[],
): string[] {
  const lookup = new Map(items.map((item) => [item.id, item]));
  if (lookup.size !== items.length)
    throw new WorkbenchError("duplicate_item", "批次项 id 不能重复");
  const remaining = new Map(
    items.map((item) => [item.id, item.dependencies.length]),
  );
  const children = new Map<string, string[]>();
  for (const item of items) {
    for (const dependency of item.dependencies) {
      if (!lookup.has(dependency))
        throw new WorkbenchError(
          "missing_dependency",
          `依赖 ${dependency} 不存在`,
        );
      if (dependency === item.id)
        throw new WorkbenchError("dependency_cycle", "批次项不能依赖自身");
      children.set(dependency, [...(children.get(dependency) ?? []), item.id]);
    }
  }
  const ready = items
    .filter((item) => item.dependencies.length === 0)
    .map((item) => item.id);
  const order: string[] = [];
  for (let index = 0; index < ready.length; index += 1) {
    const id = ready[index]!;
    order.push(id);
    for (const child of children.get(id) ?? []) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (count === 0) ready.push(child);
    }
  }
  if (order.length !== items.length)
    throw new WorkbenchError("dependency_cycle", "批次依赖存在循环");
  return order;
}

export function createBatch(
  context: CommandContext,
  input: Record<string, unknown>,
): Batch {
  const raw = array(input.items, "items", 1000);
  if (!raw.length)
    throw new WorkbenchError("empty_batch", "批次至少需要一个审查项");
  const items: BatchItem[] = raw.map((value, index) => {
    const item = object(value, "item");
    return {
      id:
        item.id === undefined
          ? `item-${index + 1}`
          : text(item.id, "item.id", 100),
      subject: text(item.subject, "subject", 200),
      reference: text(item.reference, "reference", 500),
      dependencies: strings(item.dependencies, "dependencies", 1000, 100),
      status: "pending",
      attempts: 0,
      generation: 0,
      maxAttempts: integer(item.maxAttempts, "maxAttempts", 1, 20, 3),
      worker: "",
      leaseUntil: null,
      startedAt: null,
      completedAt: null,
      error: "",
      result: null,
    };
  });
  validateBatchDependencies(items);
  const batch: Batch = {
    ...identity(context),
    name: text(input.name, "name", 200),
    status: "draft",
    concurrency: integer(input.concurrency, "concurrency", 1, 100, 2),
    items,
    note: optionalText(input.note, "note", 3000),
  };
  context.data.batches.push(batch);
  audit(context, "batch.created", batch.id, {
    items: items.length,
    concurrency: batch.concurrency,
  });
  return batch;
}

/** 生命周期操作只有明确允许的边；取消后不会继续发放租约。 */
export function changeBatchState(
  context: CommandContext,
  input: Record<string, unknown>,
  action: "start" | "pause" | "resume" | "cancel",
): Batch {
  const batch = findRecord(context.data.batches, context.repository, input.id);
  revision(batch, input.expectedRevision);
  const allowed: Record<typeof action, readonly Batch["status"][]> = {
    start: ["draft"],
    pause: ["queued", "running"],
    resume: ["paused"],
    cancel: ["draft", "queued", "running", "paused"],
  };
  if (!allowed[action].includes(batch.status))
    throw new WorkbenchError(
      "invalid_transition",
      `批次 ${batch.status} 不能执行 ${action}`,
      409,
    );
  if (action === "start" || action === "resume") batch.status = "queued";
  if (action === "pause") batch.status = "paused";
  if (action === "cancel") {
    batch.status = "canceled";
    for (const item of batch.items) {
      if (item.status === "pending" || item.status === "running") {
        item.status = "canceled";
        item.worker = "";
        item.leaseUntil = null;
        item.completedAt = context.now;
        item.error = "批次已取消";
      }
    }
  }
  touch(context, batch);
  audit(context, `batch.${action}`, batch.id);
  return batch;
}

/** 到期租约可以重试；最后一次失败会明确结束，依赖项不会永久等待。 */
function recoverExpired(context: CommandContext, batch: Batch): number {
  let recovered = 0;
  for (const item of batch.items) {
    if (
      item.status !== "running" ||
      item.leaseUntil === null ||
      item.leaseUntil > context.now
    )
      continue;
    item.status = item.attempts < item.maxAttempts ? "pending" : "failed";
    item.error = "执行租约到期";
    item.worker = "";
    item.leaseUntil = null;
    item.completedAt = item.status === "failed" ? context.now : null;
    recovered += 1;
  }
  return recovered;
}

/** 多轮传播依赖失败；每轮至少结束一项，最多走 items.length 轮。 */
function finishBlocked(context: CommandContext, batch: Batch): void {
  const lookup = new Map(batch.items.map((item) => [item.id, item]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of batch.items) {
      if (item.status !== "pending") continue;
      const failed = item.dependencies.find((id) =>
        ["failed", "canceled"].includes(lookup.get(id)!.status),
      );
      if (!failed) continue;
      item.status = "canceled";
      item.error = `依赖 ${failed} 未成功完成`;
      item.completedAt = context.now;
      changed = true;
    }
  }
  if (
    batch.items.every((item) =>
      ["completed", "failed", "canceled"].includes(item.status),
    )
  ) {
    if (batch.status !== "canceled") batch.status = "completed";
  }
}

/** 领取、回收、并发限制在同一磁盘事务；跨 API 进程也不会重复领取。 */
export function claimBatchItem(
  context: CommandContext,
  input: Record<string, unknown>,
): { batch: Batch; item: BatchItem | null; recovered: number } {
  const batch = findRecord(context.data.batches, context.repository, input.id);
  const worker = text(input.worker, "worker", 200);
  const leaseMs = integer(input.leaseMs, "leaseMs", 1000, 3_600_000, 60_000);
  if (!["queued", "running"].includes(batch.status))
    return { batch, item: null, recovered: 0 };
  const recovered = recoverExpired(context, batch);
  finishBlocked(context, batch);
  if (batch.status === "completed") {
    touch(context, batch);
    return { batch, item: null, recovered };
  }
  const running = batch.items.filter(
    (item) => item.status === "running",
  ).length;
  if (running >= batch.concurrency) return { batch, item: null, recovered };
  const lookup = new Map(batch.items.map((item) => [item.id, item]));
  const item = batch.items.find(
    (candidate) =>
      candidate.status === "pending" &&
      candidate.dependencies.every(
        (id) => lookup.get(id)!.status === "completed",
      ),
  );
  if (!item) return { batch, item: null, recovered };
  item.status = "running";
  item.worker = worker;
  item.attempts += 1;
  item.startedAt = context.now;
  item.completedAt = null;
  item.leaseUntil = new Date(
    new Date(context.now).getTime() + leaseMs,
  ).toISOString();
  item.error = "";
  batch.status = "running";
  touch(context, batch);
  audit(context, "batch.item_claimed", batch.id, {
    itemId: item.id,
    worker,
    attempt: item.attempts,
    recovered,
  });
  return { batch, item, recovered };
}

function ownedItem(
  context: CommandContext,
  batch: Batch,
  input: Record<string, unknown>,
): BatchItem {
  const itemId = text(input.itemId, "itemId", 100);
  const worker = text(input.worker, "worker", 200);
  const item = batch.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new WorkbenchError("not_found", "批次项不存在", 404);
  if (
    item.status !== "running" ||
    item.worker !== worker ||
    item.leaseUntil === null ||
    item.leaseUntil <= context.now
  ) {
    throw new WorkbenchError(
      "lease_lost",
      "执行租约已失效或不属于当前工作进程",
      409,
    );
  }
  return item;
}

/** 心跳只延长当前持有者的有效租约。 */
export function heartbeatBatchItem(
  context: CommandContext,
  input: Record<string, unknown>,
): BatchItem {
  const batch = findRecord(context.data.batches, context.repository, input.id);
  const item = ownedItem(context, batch, input);
  const leaseMs = integer(input.leaseMs, "leaseMs", 1000, 3_600_000, 60_000);
  item.leaseUntil = new Date(
    new Date(context.now).getTime() + leaseMs,
  ).toISOString();
  touch(context, batch);
  return item;
}

/** 领取后立即持久化真实任务 id，执行进程重启时可以回接同一任务。 */
export function linkBatchItem(
  context: CommandContext,
  input: Record<string, unknown>,
): BatchItem {
  const batch = findRecord(context.data.batches, context.repository, input.id);
  const item = ownedItem(context, batch, input);
  const result = metadata(input.result);
  const taskId = text(result.taskId, "result.taskId", 200);
  if (item.result !== null && item.result.taskId !== taskId) {
    throw new WorkbenchError(
      "item_already_linked",
      "批次项已关联另一个执行结果",
      409,
    );
  }
  if (JSON.stringify(item.result) === JSON.stringify(result)) return item;
  item.result = result;
  touch(context, batch);
  audit(context, "batch.item_linked", batch.id, {
    itemId: item.id,
    worker: item.worker,
  });
  return item;
}

/** 结果只接受 JSON，不会被解释为命令或代码。 */
export function completeBatchItem(
  context: CommandContext,
  input: Record<string, unknown>,
): Batch {
  const batch = findRecord(context.data.batches, context.repository, input.id);
  const item = ownedItem(context, batch, input);
  const outcome = choice(
    input.outcome,
    "outcome",
    ["completed", "failed"] as const,
    "completed",
  );
  const error = outcome === "failed" ? text(input.error, "error", 3000) : "";
  item.status =
    outcome === "failed" && item.attempts < item.maxAttempts
      ? "pending"
      : outcome;
  item.error = error;
  item.result = input.result === undefined ? null : metadata(input.result);
  item.completedAt = item.status === "pending" ? null : context.now;
  item.worker = "";
  item.leaseUntil = null;
  finishBlocked(context, batch);
  touch(context, batch);
  audit(context, "batch.item_finished", batch.id, {
    itemId: item.id,
    outcome,
    nextStatus: item.status,
  });
  return batch;
}

/** 明确选择失败项重试；依赖已恢复时自动重新打开其阻塞项。 */
export function retryBatchItems(
  context: CommandContext,
  input: Record<string, unknown>,
): Batch {
  const batch = findRecord(context.data.batches, context.repository, input.id);
  revision(batch, input.expectedRevision);
  if (batch.status === "canceled")
    throw new WorkbenchError(
      "invalid_transition",
      "已取消批次不能重试，请新建批次",
      409,
    );
  const requested =
    input.itemIds === undefined
      ? null
      : new Set(strings(input.itemIds, "itemIds", 1000, 100));
  if (
    requested &&
    [...requested].some((id) => !batch.items.some((item) => item.id === id))
  )
    throw new WorkbenchError("not_found", "部分批次项不存在", 404);
  let count = 0;
  for (const item of batch.items) {
    if (item.status !== "failed" || (requested && !requested.has(item.id)))
      continue;
    item.status = "pending";
    item.attempts = 0;
    item.generation = (item.generation ?? 0) + 1;
    item.error = "";
    item.completedAt = null;
    item.result = null;
    count += 1;
  }
  if (!count)
    throw new WorkbenchError("no_failed_items", "没有可重试的失败项", 409);
  const lookup = new Map(batch.items.map((item) => [item.id, item]));
  for (const id of validateBatchDependencies(batch.items)) {
    const item = lookup.get(id)!;
    if (
      item.status === "canceled" &&
      item.error.startsWith("依赖 ") &&
      item.dependencies.every(
        (dependency) =>
          !["failed", "canceled"].includes(lookup.get(dependency)!.status),
      )
    ) {
      item.status = "pending";
      item.error = "";
      item.completedAt = null;
    }
  }
  if (batch.status === "completed") batch.status = "queued";
  touch(context, batch);
  audit(context, "batch.retried", batch.id, { count });
  return batch;
}

/** 只读执行预览用于调度器和界面，不会领取任务。 */
export function previewBatch(
  context: CommandContext,
  input: Record<string, unknown>,
): {
  order: string[];
  ready: string[];
  blocked: string[];
  progress: Record<string, number>;
  maxParallel: number;
} {
  const batch = findRecord(context.data.batches, context.repository, input.id);
  const lookup = new Map(batch.items.map((item) => [item.id, item]));
  const ready = batch.items
    .filter(
      (item) =>
        item.status === "pending" &&
        item.dependencies.every((id) => lookup.get(id)!.status === "completed"),
    )
    .map((item) => item.id);
  const progress: Record<string, number> = {
    total: batch.items.length,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    canceled: 0,
  };
  for (const item of batch.items)
    progress[item.status] = (progress[item.status] ?? 0) + 1;
  return {
    order: validateBatchDependencies(batch.items),
    ready,
    blocked: batch.items
      .filter((item) => item.status === "pending" && !ready.includes(item.id))
      .map((item) => item.id),
    progress,
    maxParallel: Math.max(0, batch.concurrency - (progress.running ?? 0)),
  };
}
