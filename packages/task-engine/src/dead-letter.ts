/**
 * 失败任务：诊断、恢复预览与带状态校验的人工重跑。
 *
 * @example
 * const page = await listDeadLetters(db, { repositoryIds: visibleIds, limit: 50 });
 * const plan = diagnoseDeadLetter(page.items[0]!);
 * if (plan.canRetry) await retryDeadLetter(db, { taskId: plan.taskId, actor: "admin", reason: "凭据已更新" });
 *
 * 此处只读取已有 task/attempt/event 数据。恢复时沿用原任务 ID 和 dedupe key，
 * 不创建绕过去重约束的第二项任务。
 */
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../../database/src/schema.js";
import type { TaskStatus } from "../../domain/src/index.js";
import { resetTaskToQueued } from "./index.js";

type Database = PostgresJsDatabase<typeof schema>;
export type DeadLetterTask = {
  id: string;
  taskType: string;
  repositoryId: string | null;
  subjectNumber: number | null;
  status: TaskStatus;
  attemptCount: number;
  maxAttempts: number;
  lastErrorCategory: string | null;
  createdAt: Date;
  updatedAt: Date;
};
export type FailureDiagnosis = {
  taskId: string;
  category: string;
  kind:
    "credentials" | "capacity" | "input" | "worker" | "publication" | "unknown";
  title: string;
  explanation: string;
  actions: string[];
  canRetry: boolean;
  requiresChange: boolean;
  attemptsExhausted: boolean;
  ageMs: number;
};

const failures: Record<
  string,
  Omit<
    FailureDiagnosis,
    "taskId" | "category" | "canRetry" | "attemptsExhausted" | "ageMs"
  >
> = {
  authentication_failed: {
    kind: "credentials",
    title: "模型凭据失效",
    explanation: "服务端拒绝了当前凭据，重复调用相同凭据不会恢复。",
    actions: ["更新对应模型账号凭据", "执行连接测试后重新运行"],
    requiresChange: true,
  },
  permission_denied: {
    kind: "credentials",
    title: "仓库访问被拒绝",
    explanation: "GitHub 安装或仓库授权不足，任务无法取得所需内容或发布结果。",
    actions: [
      "确认 GitHub App 仍安装在目标仓库",
      "核对仓库读取、评论和 Check Run 权限",
    ],
    requiresChange: true,
  },
  rate_limited: {
    kind: "capacity",
    title: "上游请求限流",
    explanation: "任务的自动等待已用尽，当前吞吐或账号配额不足。",
    actions: ["查看上游配额与 Retry-After", "降低队列并发或调整候选账号后重试"],
    requiresChange: false,
  },
  timeout: {
    kind: "capacity",
    title: "调用超时",
    explanation: "模型或外部服务没有在任务期限内完成。",
    actions: ["检查提供商延迟", "缩小审查上下文或提高合理的调用期限"],
    requiresChange: false,
  },
  connection_failed: {
    kind: "capacity",
    title: "上游连接失败",
    explanation: "无法连接到外部服务，可能是网络或提供商暂时不可用。",
    actions: ["验证服务地址与网络连通性", "服务恢复后重试"],
    requiresChange: false,
  },
  server_error: {
    kind: "capacity",
    title: "上游服务出错",
    explanation: "外部服务返回了可重试的服务端错误，但自动次数已经耗尽。",
    actions: ["检查提供商状态与日志", "服务恢复后重试或更换候选模型"],
    requiresChange: false,
  },
  model_not_found: {
    kind: "input",
    title: "模型名称不可用",
    explanation: "提供商不认识当前模型名，重试同一模型配置没有意义。",
    actions: ["核对模型路由中的模型名称", "确认账号具备该模型的权限"],
    requiresChange: true,
  },
  context_overflow: {
    kind: "input",
    title: "上下文超过模型容量",
    explanation: "当前审查输入超过模型限制，需要缩小内容或更换模型。",
    actions: ["调整差异分块与上下文预算", "选择上下文容量足够的模型"],
    requiresChange: true,
  },
  invalid_output: {
    kind: "input",
    title: "模型输出不符合契约",
    explanation: "模型返回的内容无法按审查结果格式解析。",
    actions: [
      "检查模型是否支持结构化输出",
      "核对审查规则是否要求了互相冲突的格式",
    ],
    requiresChange: false,
  },
  invalid_input: {
    kind: "input",
    title: "任务输入不完整",
    explanation: "任务的外部输入无法满足业务契约，重复执行不会补齐缺失内容。",
    actions: ["确认对应 Issue 或 PR 仍存在", "从有效仓库和版本重新触发分析"],
    requiresChange: true,
  },
  lease_expired: {
    kind: "worker",
    title: "执行器租约过期",
    explanation:
      "worker 在任务完成前停止心跳，可能退出、阻塞或失去数据库连接。",
    actions: ["检查 worker 重启与资源使用情况", "确认心跳与租约时间匹配后重试"],
    requiresChange: false,
  },
  lease_lost: {
    kind: "worker",
    title: "执行器失去任务所有权",
    explanation: "任务已被撤销或回收，旧 worker 无权继续发布结果。",
    actions: ["检查取消和租约回收事件", "确认没有重复启动同名 worker"],
    requiresChange: false,
  },
  publication_failed: {
    kind: "publication",
    title: "结果发布失败",
    explanation: "分析可能已经完成，但 GitHub 评论或 Check Run 未成功写入。",
    actions: [
      "检查 GitHub 写入权限与 API 限流",
      "确认已发布结果后再恢复，防止重复副作用",
    ],
    requiresChange: false,
  },
};

/** 把有限错误类别翻成可执行排查动作，不从异常文本猜测是否应当重试。 */
export function diagnoseDeadLetter(
  task: DeadLetterTask,
  now = new Date(),
): FailureDiagnosis {
  const category = task.lastErrorCategory ?? "unknown";
  const detail = failures[category] ?? {
    kind: "unknown" as const,
    title: "未分类的任务失败",
    explanation: "查看该任务最后一次失败事件，确认原因后再运行。",
    actions: ["查看任务时间线和执行器日志", "修正原因后选择人工重跑"],
    requiresChange: false,
  };
  return {
    ...detail,
    actions: [...detail.actions],
    taskId: task.id,
    category,
    canRetry: task.status === "failed" || task.status === "canceled",
    attemptsExhausted: task.attemptCount >= task.maxAttempts,
    ageMs: Math.max(0, now.getTime() - task.updatedAt.getTime()),
  };
}

export type DeadLetterQuery = {
  repositoryIds?: readonly string[];
  includeGlobal?: boolean;
  categories?: readonly string[];
  before?: Date;
  limit?: number;
  offset?: number;
};

/**
 * 分页读取失败任务。repositoryIds 缺省仅供系统管理员调用；传空数组表示没有
 * 可见仓库，而不是省略授权过滤。调用 HTTP 的一侧必须先解析用户授权。
 */
export async function listDeadLetters(
  db: Database,
  input: DeadLetterQuery = {},
): Promise<{ items: DeadLetterTask[]; nextOffset: number | null }> {
  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw new RangeError("limit must be between 1 and 500");
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new RangeError("offset must be a nonnegative safe integer");
  if (input.before && !Number.isFinite(input.before.getTime()))
    throw new RangeError("before must be a valid date");
  const conditions = [eq(schema.analysisTasks.status, "failed")];
  if (input.repositoryIds !== undefined) {
    const ids = [...new Set(input.repositoryIds)];
    conditions.push(
      input.includeGlobal
        ? sql`(${ids.length ? inArray(schema.analysisTasks.repositoryId, ids) : sql`false`} or ${schema.analysisTasks.repositoryId} is null)`
        : ids.length
          ? inArray(schema.analysisTasks.repositoryId, ids)
          : sql`false`,
    );
  }
  if (input.categories?.length)
    conditions.push(
      inArray(schema.analysisTasks.lastErrorCategory, [...input.categories]),
    );
  if (input.before)
    conditions.push(lt(schema.analysisTasks.updatedAt, input.before));
  const rows = await db
    .select({
      id: schema.analysisTasks.id,
      taskType: schema.analysisTasks.taskType,
      repositoryId: schema.analysisTasks.repositoryId,
      subjectNumber: schema.analysisTasks.subjectNumber,
      status: schema.analysisTasks.status,
      attemptCount: schema.analysisTasks.attemptCount,
      maxAttempts: schema.analysisTasks.maxAttempts,
      lastErrorCategory: schema.analysisTasks.lastErrorCategory,
      createdAt: schema.analysisTasks.createdAt,
      updatedAt: schema.analysisTasks.updatedAt,
    })
    .from(schema.analysisTasks)
    .where(and(...conditions))
    .orderBy(desc(schema.analysisTasks.updatedAt), asc(schema.analysisTasks.id))
    .limit(limit + 1)
    .offset(offset);
  return {
    items: rows.slice(0, limit),
    nextOffset: rows.length > limit ? offset + limit : null,
  };
}

/**
 * 人工恢复必须带操作者和理由。状态比较与原重跑入口共用同一事务，只有实际
 * 恢复成功才追加审计事件；并发重跑最多一个成功。
 */
export async function retryDeadLetter(
  db: Database,
  input: {
    taskId: string;
    actor: string;
    reason: string;
    now?: Date;
    expectedUpdatedAt?: Date;
  },
): Promise<boolean> {
  const actor = input.actor.trim();
  const reason = input.reason.trim();
  if (!input.taskId.trim()) throw new TypeError("taskId is required");
  if (!actor || actor.length > 200)
    throw new TypeError("actor must contain 1 to 200 characters");
  if (!reason || reason.length > 500)
    throw new TypeError("reason must contain 1 to 500 characters");
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select({
        status: schema.analysisTasks.status,
        updatedAt: schema.analysisTasks.updatedAt,
        errorCategory: schema.analysisTasks.lastErrorCategory,
        attemptCount: schema.analysisTasks.attemptCount,
      })
      .from(schema.analysisTasks)
      .where(eq(schema.analysisTasks.id, input.taskId))
      .for("update")
      .limit(1);
    if (!task || !["failed", "canceled"].includes(task.status)) return false;
    if (
      input.expectedUpdatedAt &&
      task.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()
    )
      return false;
    const restored = await resetTaskToQueued(tx as unknown as Database, {
      taskId: input.taskId,
      now,
    });
    if (!restored) return false;
    await tx
      .insert(schema.taskEvents)
      .values({
        taskId: input.taskId,
        eventType: "task.dead_letter_restored",
        data: {
          actor,
          reason,
          priorStatus: task.status,
          priorErrorCategory: task.errorCategory,
          priorAttempts: task.attemptCount,
          restoredAt: now.toISOString(),
        },
      });
    return true;
  });
}

/** 汇总失败类别，避免管理界面靠完整 payload 做客户端统计。 */
export function summarizeDeadLetters(
  tasks: readonly DeadLetterTask[],
  now = new Date(),
): {
  total: number;
  oldestAgeMs: number;
  categories: { category: string; count: number; requiresChange: boolean }[];
} {
  const categories = new Map<string, number>();
  let oldestAgeMs = 0;
  for (const task of tasks) {
    const diagnosis = diagnoseDeadLetter(task, now);
    categories.set(
      diagnosis.category,
      (categories.get(diagnosis.category) ?? 0) + 1,
    );
    oldestAgeMs = Math.max(oldestAgeMs, diagnosis.ageMs);
  }
  return {
    total: tasks.length,
    oldestAgeMs,
    categories: [...categories]
      .map(([category, count]) => ({
        category,
        count,
        requiresChange: failures[category]?.requiresChange ?? false,
      }))
      .sort(
        (a, b) => b.count - a.count || a.category.localeCompare(b.category),
      ),
  };
}
