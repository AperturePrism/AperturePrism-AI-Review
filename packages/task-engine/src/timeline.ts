/**
 * 任务时间线：从已有事件计算排队耗时、执行耗时、尝试次数与模型用量。
 *
 * @example
 * const report = inspectTaskTimeline(events, { now: new Date() });
 * console.log(report.duration, report.usage, report.warnings);
 *
 * 事件是审计事实，分析只返回结果，不回写任务状态。历史缺少字段时用 null
 * 表示“没有证据”，不把缺失耗时伪装成零。
 */
import type { TaskStatus } from "../../domain/src/index.js";

export type TaskTimelineEvent = {
  id?: string;
  eventType: string;
  createdAt: Date | string;
  data: unknown;
};
export type TaskAttemptTimeline = {
  attemptNumber: number;
  workerId: string | null;
  leasedAt: string | null;
  startedAt: string | null;
  publishingAt: string | null;
  finishedAt: string | null;
  outcome:
    | "completed"
    | "failed"
    | "retry_wait"
    | "canceled"
    | "lease_expired"
    | "active";
  errorCategory: string | null;
  inputTokens: number;
  outputTokens: number;
  modelDurationMs: number;
  providers: string[];
  models: string[];
};
export type TimelineWarning = {
  index: number;
  code:
    | "invalid_time"
    | "duplicate_event"
    | "missing_lease"
    | "unexpected_transition"
    | "invalid_usage";
  message: string;
};
export type TaskTimelineReport = {
  status: TaskStatus | "unknown";
  firstEventAt: string | null;
  lastEventAt: string | null;
  duration: {
    totalMs: number | null;
    queueMs: number | null;
    executionMs: number;
    publishingMs: number;
    retryWaitMs: number;
  };
  usage: { inputTokens: number; outputTokens: number; modelDurationMs: number };
  attempts: TaskAttemptTimeline[];
  warnings: TimelineWarning[];
  reruns: number;
};

const destinations: Record<string, TaskStatus> = {
  "task.created": "queued",
  "task.leased": "leased",
  "task.started": "running",
  "task.publishing": "publishing",
  "task.completed": "completed",
  "task.failed": "failed",
  "task.canceled": "canceled",
  "task.retry_scheduled": "retry_wait",
  "task.retry_ready": "queued",
  "task.lease_recovered": "queued",
};
const allowedSources: Record<string, readonly (TaskStatus | "unknown")[]> = {
  "task.created": ["unknown"],
  "task.leased": ["queued", "unknown"],
  "task.started": ["leased"],
  "task.publishing": ["running"],
  "task.completed": ["publishing"],
  "task.failed": ["running", "publishing", "leased"],
  "task.canceled": [
    "queued",
    "leased",
    "running",
    "publishing",
    "retry_wait",
    "unknown",
  ],
  "task.retry_scheduled": ["running", "publishing"],
  "task.retry_ready": ["retry_wait", "failed", "canceled"],
  "task.lease_recovered": ["leased", "running", "publishing"],
};

/** 边界解析仅保留事件元数据；不把任意 payload 内容当作可执行字段。 */
function eventData(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
function duration(from: string | null, to: string | null): number {
  return from && to ? Math.max(0, Date.parse(to) - Date.parse(from)) : 0;
}

/**
 * 稳定排序事件并生成审计摘要。同一 id 只计一次；同一尝试的重复 usage 只保留
 * 最后一次快照，防止网络重试把计费与吞吐统计翻倍。
 */
export function inspectTaskTimeline(
  input: readonly TaskTimelineEvent[],
  options: { now?: Date } = {},
): TaskTimelineReport {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime()))
    throw new RangeError("now must be a valid date");
  const warnings: TimelineWarning[] = [];
  const ids = new Set<string>();
  const events = input
    .map((event, index) => ({
      event,
      index,
      time: new Date(event.createdAt).getTime(),
    }))
    .filter(({ event, index, time }) => {
      if (!Number.isFinite(time)) {
        warnings.push({
          index,
          code: "invalid_time",
          message: "event timestamp is invalid",
        });
        return false;
      }
      if (event.id && ids.has(event.id)) {
        warnings.push({
          index,
          code: "duplicate_event",
          message: `duplicate event ${event.id}`,
        });
        return false;
      }
      if (event.id) ids.add(event.id);
      return true;
    })
    .sort((a, b) => a.time - b.time || a.index - b.index);
  const attempts: TaskAttemptTimeline[] = [];
  let status: TaskTimelineReport["status"] = "unknown";
  let current: TaskAttemptTimeline | undefined;
  let queueMs = 0;
  let retryWaitMs = 0;
  let queueSince: number | null = null;
  let retrySince: number | null = null;
  let reruns = 0;
  for (const { event, index, time } of events) {
    const data = eventData(event.data);
    const iso = new Date(time).toISOString();
    const next = destinations[event.eventType];
    if (next && !(allowedSources[event.eventType] ?? []).includes(status))
      warnings.push({
        index,
        code: "unexpected_transition",
        message: `${event.eventType} observed after ${status}`,
      });
    if (
      event.eventType === "task.created" ||
      event.eventType === "task.retry_ready" ||
      event.eventType === "task.lease_recovered"
    )
      queueSince = time;
    if (
      event.eventType === "task.retry_ready" &&
      (status === "failed" || status === "canceled")
    )
      reruns += 1;
    if (event.eventType === "task.retry_scheduled") retrySince = time;
    if (event.eventType === "task.retry_ready" && retrySince !== null) {
      retryWaitMs += Math.max(0, time - retrySince);
      retrySince = null;
    }
    if (event.eventType === "task.leased") {
      if (queueSince !== null) queueMs += Math.max(0, time - queueSince);
      queueSince = null;
      current = {
        attemptNumber: nonnegative(data.attemptNumber) ?? attempts.length + 1,
        workerId: typeof data.workerId === "string" ? data.workerId : null,
        leasedAt: iso,
        startedAt: null,
        publishingAt: null,
        finishedAt: null,
        outcome: "active",
        errorCategory: null,
        inputTokens: 0,
        outputTokens: 0,
        modelDurationMs: 0,
        providers: [],
        models: [],
      };
      attempts.push(current);
    }
    if (
      [
        "task.started",
        "task.publishing",
        "task.completed",
        "task.retry_scheduled",
        "task.failed",
        "task.analysis_usage",
      ].includes(event.eventType) &&
      !current
    )
      warnings.push({
        index,
        code: "missing_lease",
        message: `${event.eventType} has no preceding lease event`,
      });
    if (event.eventType === "task.started" && current) current.startedAt = iso;
    if (event.eventType === "task.publishing" && current)
      current.publishingAt = iso;
    if (event.eventType === "task.analysis_usage" && current) {
      const inputTokens = nonnegative(data.inputTokens);
      const outputTokens = nonnegative(data.outputTokens);
      const modelDuration = nonnegative(data.durationMs);
      if (
        inputTokens === null ||
        outputTokens === null ||
        modelDuration === null
      )
        warnings.push({
          index,
          code: "invalid_usage",
          message:
            "usage requires nonnegative integer token and duration fields",
        });
      else {
        current.inputTokens = inputTokens;
        current.outputTokens = outputTokens;
        current.modelDurationMs = modelDuration;
        current.providers =
          typeof data.provider === "string" ? [data.provider] : [];
        current.models = typeof data.model === "string" ? [data.model] : [];
      }
    }
    if (
      [
        "task.completed",
        "task.failed",
        "task.retry_scheduled",
        "task.canceled",
        "task.lease_recovered",
      ].includes(event.eventType) &&
      current &&
      current.finishedAt === null
    ) {
      current.finishedAt = iso;
      current.errorCategory =
        typeof data.errorCategory === "string" ? data.errorCategory : null;
      current.outcome =
        event.eventType === "task.completed"
          ? "completed"
          : event.eventType === "task.retry_scheduled"
            ? "retry_wait"
            : event.eventType === "task.canceled"
              ? "canceled"
              : event.eventType === "task.lease_recovered"
                ? "lease_expired"
                : "failed";
    }
    if (next) status = next;
  }
  if (queueSince !== null && status === "queued")
    queueMs += Math.max(0, now.getTime() - queueSince);
  if (retrySince !== null && status === "retry_wait")
    retryWaitMs += Math.max(0, now.getTime() - retrySince);
  const firstEventAt = events[0]
    ? new Date(events[0].time).toISOString()
    : null;
  const lastEventAt = events.at(-1)
    ? new Date(events.at(-1)!.time).toISOString()
    : null;
  const terminal = ["completed", "failed", "canceled"].includes(status);
  return {
    status,
    firstEventAt,
    lastEventAt,
    duration: {
      totalMs: firstEventAt
        ? duration(firstEventAt, terminal ? lastEventAt : now.toISOString())
        : null,
      queueMs: events.length ? queueMs : null,
      executionMs: attempts.reduce(
        (sum, attempt) =>
          sum +
          duration(
            attempt.startedAt,
            attempt.publishingAt ?? attempt.finishedAt ?? now.toISOString(),
          ),
        0,
      ),
      publishingMs: attempts.reduce(
        (sum, attempt) =>
          sum +
          duration(
            attempt.publishingAt,
            attempt.finishedAt ?? now.toISOString(),
          ),
        0,
      ),
      retryWaitMs,
    },
    usage: {
      inputTokens: attempts.reduce(
        (sum, attempt) => sum + attempt.inputTokens,
        0,
      ),
      outputTokens: attempts.reduce(
        (sum, attempt) => sum + attempt.outputTokens,
        0,
      ),
      modelDurationMs: attempts.reduce(
        (sum, attempt) => sum + attempt.modelDurationMs,
        0,
      ),
    },
    attempts,
    warnings,
    reruns,
  };
}

/** CSV 导出只包含元数据；不导出可能包含源码或凭据的事件原文。 */
export function timelineCsv(report: TaskTimelineReport): string {
  const quote = (value: unknown) =>
    `"${String(value ?? "").replaceAll('"', '""')}"`;
  const header = [
    "attempt",
    "worker",
    "leased_at",
    "started_at",
    "publishing_at",
    "finished_at",
    "outcome",
    "error_category",
    "input_tokens",
    "output_tokens",
    "model_duration_ms",
  ];
  const rows = report.attempts.map((attempt) => [
    attempt.attemptNumber,
    attempt.workerId,
    attempt.leasedAt,
    attempt.startedAt,
    attempt.publishingAt,
    attempt.finishedAt,
    attempt.outcome,
    attempt.errorCategory,
    attempt.inputTokens,
    attempt.outputTokens,
    attempt.modelDurationMs,
  ]);
  return (
    [header, ...rows].map((row) => row.map(quote).join(",")).join("\r\n") +
    "\r\n"
  );
}
