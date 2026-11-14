/**
 * 重试计划：把失败原因、次数和服务端等待提示变成可解释的下次运行时间。
 *
 * @example
 * const decision = planRetry({ attempt: 2, maxAttempts: 4, category: "rate_limited", now: new Date(), key: task.id });
 * if (decision.action === "retry") console.log(decision.nextAttemptAt);
 *
 * 此文件不读数据库。任务写入入口和运维预览共用同一个算法，避免界面显示的
 * 时间与 worker 实际使用的时间不同。旧的显式 retryDelayMs 仍由原入口保留。
 */

export type RetryPolicy = {
  baseDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitterRatio: number;
  /** 超过这个总耗时就停止自动重试；undefined 表示没有总耗时上限。 */
  maxElapsedMs?: number;
  /** 这些错误需要修改凭据或输入，原样重试没有意义。 */
  stopCategories: readonly string[];
};

export const DEFAULT_TASK_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60_000,
  multiplier: 2,
  jitterRatio: 0.2,
  stopCategories: Object.freeze([
    "authentication_failed",
    "permission_denied",
    "invalid_input",
    "model_not_found",
    "context_overflow",
    "canceled",
    "stale_revision",
  ]),
});

export type RetryRequest = {
  attempt: number;
  maxAttempts: number;
  category: string;
  now: Date;
  /** 稳定任务标识让一次失败在不同进程中得到相同的抖动。 */
  key: string;
  retryAfterMs?: number;
  startedAt?: Date;
  policy?: Partial<RetryPolicy>;
};

export type RetryDecision =
  | {
      action: "stop";
      reason: "attempts_exhausted" | "non_retryable" | "elapsed_budget";
      category: string;
      attemptsRemaining: number;
    }
  | {
      action: "retry";
      reason: "backoff" | "server_delay";
      category: string;
      attemptsRemaining: number;
      delayMs: number;
      nextAttemptAt: Date;
    };

/** 验证外部策略并补齐默认值；失败说明具体字段，不让 NaN 进入持久时间。 */
export function parseRetryPolicy(
  input: Partial<RetryPolicy> = {},
): RetryPolicy {
  const policy = { ...DEFAULT_TASK_RETRY_POLICY, ...input };
  for (const [name, value] of [
    ["baseDelayMs", policy.baseDelayMs],
    ["maxDelayMs", policy.maxDelayMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError(`${name} must be a nonnegative safe integer`);
  }
  if (policy.maxDelayMs < policy.baseDelayMs)
    throw new RangeError("maxDelayMs must be at least baseDelayMs");
  if (!Number.isFinite(policy.multiplier) || policy.multiplier < 1)
    throw new RangeError("multiplier must be finite and at least 1");
  if (
    !Number.isFinite(policy.jitterRatio) ||
    policy.jitterRatio < 0 ||
    policy.jitterRatio > 1
  )
    throw new RangeError("jitterRatio must be between 0 and 1");
  if (
    policy.maxElapsedMs !== undefined &&
    (!Number.isSafeInteger(policy.maxElapsedMs) || policy.maxElapsedMs <= 0)
  )
    throw new RangeError("maxElapsedMs must be a positive safe integer");
  if (
    !Array.isArray(policy.stopCategories) ||
    policy.stopCategories.some(
      (category) => typeof category !== "string" || !category.trim(),
    )
  )
    throw new TypeError("stopCategories must contain nonempty strings");
  return {
    ...policy,
    stopCategories: [
      ...new Set(policy.stopCategories.map((value) => value.trim())),
    ],
  };
}

/** 同一个任务和次数使用同一个样本；不依赖全局随机状态，便于追查与重放。 */
export function retrySample(key: string, attempt: number): number {
  let hash = 2_166_136_261;
  for (const char of `${key}:${attempt}`) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 4_294_967_296;
}

/**
 * 计算一次失败后的计划。服务端 Retry-After 是最低等待时间，不能被抖动缩短。
 * @param request 失败发生时的任务快照；attempt 从 1 开始。
 * @returns 停止原因，或包含确切时间的重试决定。
 */
export function planRetry(request: RetryRequest): RetryDecision {
  const policy = parseRetryPolicy(request.policy);
  if (!Number.isSafeInteger(request.attempt) || request.attempt < 1)
    throw new RangeError("attempt must be a positive safe integer");
  if (!Number.isSafeInteger(request.maxAttempts) || request.maxAttempts < 1)
    throw new RangeError("maxAttempts must be a positive safe integer");
  if (!Number.isFinite(request.now.getTime()))
    throw new RangeError("now must be a valid date");
  if (request.startedAt && !Number.isFinite(request.startedAt.getTime()))
    throw new RangeError("startedAt must be a valid date");
  if (
    request.retryAfterMs !== undefined &&
    (!Number.isSafeInteger(request.retryAfterMs) || request.retryAfterMs < 0)
  )
    throw new RangeError("retryAfterMs must be a nonnegative safe integer");
  const category = request.category.trim();
  if (!category) throw new TypeError("category must not be empty");
  const attemptsRemaining = Math.max(0, request.maxAttempts - request.attempt);
  if (attemptsRemaining === 0)
    return {
      action: "stop",
      reason: "attempts_exhausted",
      category,
      attemptsRemaining,
    };
  if (policy.stopCategories.includes(category))
    return {
      action: "stop",
      reason: "non_retryable",
      category,
      attemptsRemaining,
    };

  // 指数先封顶再抖动，极大次数也不会产生 Infinity 或无效日期。
  const exponent = Math.min(request.attempt - 1, 1_024);
  const rawDelay =
    policy.baseDelayMs === 0
      ? 0
      : Math.min(
          policy.maxDelayMs,
          policy.baseDelayMs * policy.multiplier ** exponent,
        );
  const spread =
    1 -
    policy.jitterRatio +
    retrySample(request.key, request.attempt) * policy.jitterRatio * 2;
  const backoffMs = Math.min(
    policy.maxDelayMs,
    Math.max(0, Math.round(rawDelay * spread)),
  );
  const serverDelay = request.retryAfterMs ?? 0;
  const delayMs = Math.max(backoffMs, serverDelay);
  const elapsedMs = request.startedAt
    ? Math.max(0, request.now.getTime() - request.startedAt.getTime())
    : 0;
  if (
    policy.maxElapsedMs !== undefined &&
    elapsedMs + delayMs > policy.maxElapsedMs
  )
    return {
      action: "stop",
      reason: "elapsed_budget",
      category,
      attemptsRemaining,
    };
  const nextAttemptAt = new Date(request.now.getTime() + delayMs);
  if (!Number.isFinite(nextAttemptAt.getTime()))
    throw new RangeError("retry time exceeds supported date range");
  return {
    action: "retry",
    reason: serverDelay > backoffMs ? "server_delay" : "backoff",
    category,
    attemptsRemaining,
    delayMs,
    nextAttemptAt,
  };
}

/** 将 HTTP Retry-After 的秒数或 HTTP 日期转成毫秒；格式错误返回 null。 */
export function parseRetryAfter(
  value: string | null,
  now = new Date(),
): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const delay = Math.ceil(Number(text) * 1_000);
    return Number.isSafeInteger(delay) ? delay : null;
  }
  // Date.parse 会把 "-1" 当月份；只接受真正的 HTTP 日期形状。
  if (!/^[A-Za-z]{3},\s/.test(text)) return null;
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - now.getTime());
}

/** 运维页面可一次预览后续所有等待，使用的算法与实际失败入口完全一致。 */
export function previewRetries(
  input: Omit<RetryRequest, "attempt"> & { fromAttempt?: number },
): RetryDecision[] {
  const decisions: RetryDecision[] = [];
  let now = input.now;
  for (let attempt = input.fromAttempt ?? 1; ; attempt += 1) {
    const decision = planRetry({ ...input, now, attempt });
    decisions.push(decision);
    if (decision.action === "stop") break;
    now = decision.nextAttemptAt;
  }
  return decisions;
}
