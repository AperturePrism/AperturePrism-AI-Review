/**
 * 队列：公平排序、运行限额和领取预览。数据来自任务表，不维护第二份任务状态。
 *
 * @example
 * const preview = previewQueue(tasks, { now: new Date(), limit: 20, policy: { agingIntervalMs: 60000 } });
 * console.log(preview.ready.map((item) => item.task.id), preview.blocked);
 */
import type { TaskStatus, TaskType } from "../../domain/src/index.js";

export type QueueTask = {
  id: string;
  repositoryId: string | null;
  taskType: TaskType;
  status: TaskStatus;
  priority: number;
  createdAt: Date;
  nextAttemptAt: Date;
  attemptCount: number;
  maxAttempts: number;
  leaseOwner?: string | null;
  leaseExpiresAt?: Date | null;
};

export type QueuePolicy = {
  /** 等待每过一个间隔提升一点优先级；0 表示保留静态优先级。 */
  agingIntervalMs: number;
  maxAgingBoost: number;
  /** 单仓库并发上限，0 表示不限制。全局任务拥有独立的 null 仓库桶。 */
  maxActivePerRepository: number;
  maxActiveTotal: number;
  /** 同时就绪的仓库轮流取一个，避免大仓库一次占满领取窗口。 */
  roundRobin: boolean;
  allowedTaskTypes: readonly TaskType[];
};

export const DEFAULT_QUEUE_POLICY: Readonly<QueuePolicy> = Object.freeze({
  agingIntervalMs: 0,
  maxAgingBoost: 100,
  maxActivePerRepository: 0,
  maxActiveTotal: 0,
  roundRobin: false,
  allowedTaskTypes: Object.freeze([
    "issue_analysis",
    "pr_review",
    "repository_index",
  ] as const),
});

export type QueueBlockReason =
  | "not_queued"
  | "not_due"
  | "attempts_exhausted"
  | "task_type"
  | "repository_limit"
  | "global_limit";
export type QueueCandidate = {
  task: QueueTask;
  effectivePriority: number;
  waitMs: number;
  position: number;
};
export type QueuePreview = {
  ready: QueueCandidate[];
  blocked: { task: QueueTask; reason: QueueBlockReason }[];
  waiting: QueueCandidate[];
  activeTotal: number;
  activeByRepository: Record<string, number>;
};

const activeStatuses = new Set<TaskStatus>(["leased", "running", "publishing"]);
const taskTypes = new Set<TaskType>([
  "issue_analysis",
  "pr_review",
  "repository_index",
]);

/** 外部队列配置只在这里检查；排序阶段只使用已确认的数字。 */
export function parseQueuePolicy(
  input: Partial<QueuePolicy> = {},
): QueuePolicy {
  const policy = { ...DEFAULT_QUEUE_POLICY, ...input };
  for (const key of [
    "agingIntervalMs",
    "maxAgingBoost",
    "maxActivePerRepository",
    "maxActiveTotal",
  ] as const) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 0)
      throw new RangeError(`${key} must be a nonnegative safe integer`);
  }
  if (typeof policy.roundRobin !== "boolean")
    throw new TypeError("roundRobin must be boolean");
  if (
    !Array.isArray(policy.allowedTaskTypes) ||
    !policy.allowedTaskTypes.length ||
    policy.allowedTaskTypes.some((type) => !taskTypes.has(type))
  )
    throw new TypeError("allowedTaskTypes must contain known task types");
  return { ...policy, allowedTaskTypes: [...new Set(policy.allowedTaskTypes)] };
}

/** 当前真实占用；已经过期的租约不占用限额，等待 scheduler 回收后重新领取。 */
export function activeQueueUsage(
  tasks: readonly QueueTask[],
  now: Date,
): Map<string | null, number> {
  const active = new Map<string | null, number>();
  for (const task of tasks) {
    if (!activeStatuses.has(task.status)) continue;
    if (!task.leaseExpiresAt || task.leaseExpiresAt.getTime() <= now.getTime())
      continue;
    active.set(task.repositoryId, (active.get(task.repositoryId) ?? 0) + 1);
  }
  return active;
}

/** 等待提升的上限使异常早期数据也不会永久压过管理员设置的紧急任务。 */
export function effectiveQueuePriority(
  task: Pick<QueueTask, "priority" | "createdAt">,
  now: Date,
  policy: QueuePolicy,
): number {
  const wait = Math.max(0, now.getTime() - task.createdAt.getTime());
  const boost =
    policy.agingIntervalMs === 0
      ? 0
      : Math.min(
          policy.maxAgingBoost,
          Math.floor(wait / policy.agingIntervalMs),
        );
  return task.priority + boost;
}

function compareCandidates(
  left: QueueCandidate,
  right: QueueCandidate,
): number {
  return (
    right.effectivePriority - left.effectivePriority ||
    left.task.nextAttemptAt.getTime() - right.task.nextAttemptAt.getTime() ||
    left.task.createdAt.getTime() - right.task.createdAt.getTime() ||
    left.task.id.localeCompare(right.task.id)
  );
}

/**
 * 只读领取预览。ready 限额包含本次预览已选中的任务，所以不会建议同时领取
 * 超过仓库限额的批次。数据库领取还必须持有锁，预览本身不是授权或原子承诺。
 */
export function previewQueue(
  tasks: readonly QueueTask[],
  input: { now: Date; limit?: number; policy?: Partial<QueuePolicy> },
): QueuePreview {
  const policy = parseQueuePolicy(input.policy);
  const limit = input.limit ?? 50;
  if (!Number.isFinite(input.now.getTime()))
    throw new RangeError("now must be a valid date");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
    throw new RangeError("limit must be between 1 and 1000");
  const usage = activeQueueUsage(tasks, input.now);
  const activeTotal = [...usage.values()].reduce(
    (total, value) => total + value,
    0,
  );
  const blocked: QueuePreview["blocked"] = [];
  const candidates: QueueCandidate[] = [];
  for (const task of tasks) {
    let reason: QueueBlockReason | undefined;
    if (task.status !== "queued") reason = "not_queued";
    else if (task.attemptCount >= task.maxAttempts)
      reason = "attempts_exhausted";
    else if (!policy.allowedTaskTypes.includes(task.taskType))
      reason = "task_type";
    else if (task.nextAttemptAt.getTime() > input.now.getTime())
      reason = "not_due";
    if (reason) {
      blocked.push({ task, reason });
      continue;
    }
    candidates.push({
      task,
      effectivePriority: effectiveQueuePriority(task, input.now, policy),
      waitMs: Math.max(0, input.now.getTime() - task.createdAt.getTime()),
      position: 0,
    });
  }
  candidates.sort(compareCandidates);
  const ordered = policy.roundRobin
    ? interleaveRepositories(candidates)
    : candidates;
  const ready: QueueCandidate[] = [];
  const waiting: QueueCandidate[] = [];
  for (const candidate of ordered) {
    const repository = candidate.task.repositoryId;
    const repositoryUsage = usage.get(repository) ?? 0;
    if (
      policy.maxActiveTotal > 0 &&
      activeTotal + ready.length >= policy.maxActiveTotal
    ) {
      blocked.push({ task: candidate.task, reason: "global_limit" });
      continue;
    }
    if (
      policy.maxActivePerRepository > 0 &&
      repositoryUsage >= policy.maxActivePerRepository
    ) {
      blocked.push({ task: candidate.task, reason: "repository_limit" });
      continue;
    }
    candidate.position = ready.length + waiting.length + 1;
    if (ready.length >= limit) {
      waiting.push(candidate);
      continue;
    }
    ready.push(candidate);
    usage.set(repository, repositoryUsage + 1);
  }
  return {
    ready,
    waiting,
    blocked,
    activeTotal,
    // 原始真实占用单独重新计算，不把尚未领取的预览项当成持久占用。
    activeByRepository: Object.fromEntries(
      [...activeQueueUsage(tasks, input.now)].map(([key, value]) => [
        key ?? "(global)",
        value,
      ]),
    ),
  };
}

/** 同一轮内各仓库至多一次；仓库的首项优先级决定它在每轮里的位置。 */
function interleaveRepositories(
  candidates: readonly QueueCandidate[],
): QueueCandidate[] {
  const groups = new Map<string | null, QueueCandidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.task.repositoryId) ?? [];
    group.push(candidate);
    groups.set(candidate.task.repositoryId, group);
  }
  const ordered: QueueCandidate[] = [];
  let offset = 0;
  while (ordered.length < candidates.length) {
    for (const group of groups.values()) {
      const candidate = group[offset];
      if (candidate) ordered.push(candidate);
    }
    offset += 1;
  }
  return ordered;
}

export type QueueSummary = {
  total: number;
  due: number;
  scheduled: number;
  active: number;
  exhausted: number;
  oldestQueuedAt: string | null;
  oldestWaitMs: number;
  byStatus: Record<TaskStatus, number>;
  byRepository: {
    repositoryId: string | null;
    queued: number;
    active: number;
    failed: number;
  }[];
};

/** 同一份任务快照导出摘要，监控与管理页面不需要自行复制状态分类逻辑。 */
export function summarizeQueue(
  tasks: readonly QueueTask[],
  now = new Date(),
): QueueSummary {
  const byStatus: Record<TaskStatus, number> = {
    queued: 0,
    leased: 0,
    running: 0,
    publishing: 0,
    completed: 0,
    retry_wait: 0,
    failed: 0,
    canceled: 0,
  };
  const repositories = new Map<
    string | null,
    QueueSummary["byRepository"][number]
  >();
  let oldest: Date | null = null;
  let due = 0;
  let scheduled = 0;
  let exhausted = 0;
  for (const task of tasks) {
    byStatus[task.status] += 1;
    const repository = repositories.get(task.repositoryId) ?? {
      repositoryId: task.repositoryId,
      queued: 0,
      active: 0,
      failed: 0,
    };
    if (task.status === "queued") {
      repository.queued += 1;
      if (oldest === null || task.createdAt < oldest) oldest = task.createdAt;
      if (task.nextAttemptAt <= now && task.attemptCount < task.maxAttempts)
        due += 1;
      else scheduled += 1;
      if (task.attemptCount >= task.maxAttempts) exhausted += 1;
    }
    if (activeStatuses.has(task.status)) repository.active += 1;
    if (task.status === "failed") repository.failed += 1;
    repositories.set(task.repositoryId, repository);
  }
  return {
    total: tasks.length,
    due,
    scheduled,
    active: byStatus.leased + byStatus.running + byStatus.publishing,
    exhausted,
    oldestQueuedAt: oldest?.toISOString() ?? null,
    oldestWaitMs: oldest ? Math.max(0, now.getTime() - oldest.getTime()) : 0,
    byStatus,
    byRepository: [...repositories.values()].sort(
      (a, b) =>
        b.queued - a.queued ||
        (a.repositoryId ?? "").localeCompare(b.repositoryId ?? ""),
    ),
  };
}
