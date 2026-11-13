/**
 * 执行配额：当前进程的并发令牌和固定时间窗口预算。
 *
 * @example
 * const quota = createExecutionQuota({ maxConcurrent: 2, windowMs: 60000, maxStarts: 20, maxUnits: 10000 });
 * const ticket = quota.reserve({ key: task.id, units: estimatedTokens });
 * if (ticket.allowed) try { await run(); } finally { quota.finish(ticket.reservation.id, { units: actualTokens }); }
 *
 * 本主体用于一个计划执行器内部限流。跨进程的任务队列配额必须使用数据库
 * claimTaskWithPolicy，不能把这个内存配额当作全局限额。
 */
export type ExecutionQuotaPolicy = {
  maxConcurrent: number;
  windowMs: number;
  maxStarts: number;
  maxUnits: number;
};
export type QuotaReservation = {
  id: string;
  key: string;
  units: number;
  startedAt: number;
  finishedAt: number | null;
  actualUnits: number | null;
};
export type QuotaDecision =
  | { allowed: true; reservation: QuotaReservation; duplicate: boolean }
  | {
      allowed: false;
      reason: "concurrency" | "starts" | "units";
      retryAt: number | null;
      availableUnits: number;
    };
export type QuotaSnapshot = {
  active: number;
  starts: number;
  usedUnits: number;
  reservedUnits: number;
  availableUnits: number;
  windowStartsAt: number;
  nextReleaseAt: number | null;
};

/** 预算以最小计量单位的整数表示，token、毫秒或微货币均可，避免小数累计误差。 */
export function parseExecutionQuota(
  input: ExecutionQuotaPolicy,
): ExecutionQuotaPolicy {
  for (const key of [
    "maxConcurrent",
    "windowMs",
    "maxStarts",
    "maxUnits",
  ] as const) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 1)
      throw new RangeError(`${key} must be a positive safe integer`);
  }
  return { ...input };
}

export type ExecutionQuota = {
  reserve: (request: {
    key: string;
    units: number;
    now?: number;
  }) => QuotaDecision;
  finish: (id: string, result: { units: number; now?: number }) => boolean;
  cancel: (id: string, now?: number) => boolean;
  snapshot: (now?: number) => QuotaSnapshot;
  active: () => QuotaReservation[];
};

/** 同一个 JS 进程内的 reserve 不含 await，检查和扣额不会被其他请求穿插。 */
export function createExecutionQuota(
  input: ExecutionQuotaPolicy,
  options: { now?: () => number } = {},
): ExecutionQuota {
  const policy = parseExecutionQuota(input);
  const clock = options.now ?? Date.now;
  const records = new Map<string, QuotaReservation>();
  const byKey = new Map<string, string>();
  let sequence = 0;
  const time = (value: number) => {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError("now must be a nonnegative timestamp");
    return value;
  };
  const units = (value: number) => {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError("units must be a nonnegative safe integer");
    return value;
  };
  const prune = (now: number) => {
    for (const [id, record] of records) {
      // 仍在执行的预留不能因窗口流逝而消失，否则长任务会绕过并发上限。
      if (
        record.finishedAt !== null &&
        record.startedAt <= now - policy.windowMs
      ) {
        records.delete(id);
        if (byKey.get(record.key) === id) byKey.delete(record.key);
      }
    }
  };
  const snapshot = (now = clock()): QuotaSnapshot => {
    time(now);
    prune(now);
    let active = 0;
    let starts = 0;
    let usedUnits = 0;
    let reservedUnits = 0;
    let nextReleaseAt: number | null = null;
    for (const record of records.values()) {
      if (record.finishedAt === null) active += 1;
      const inWindow = record.startedAt > now - policy.windowMs;
      if (inWindow) starts += 1;
      if (record.finishedAt === null) reservedUnits += record.units;
      else if (inWindow) usedUnits += record.actualUnits ?? 0;
      if (
        inWindow &&
        (nextReleaseAt === null ||
          record.startedAt + policy.windowMs < nextReleaseAt)
      )
        nextReleaseAt = record.startedAt + policy.windowMs;
    }
    return {
      active,
      starts,
      usedUnits,
      reservedUnits,
      availableUnits: Math.max(0, policy.maxUnits - usedUnits - reservedUnits),
      windowStartsAt: now - policy.windowMs,
      nextReleaseAt,
    };
  };
  return {
    reserve(request) {
      const now = time(request.now ?? clock());
      const estimate = units(request.units);
      const key = request.key.trim();
      if (!key || key.length > 500)
        throw new TypeError("reservation key must contain 1 to 500 characters");
      const current = snapshot(now);
      const existing = records.get(byKey.get(key) ?? "");
      if (existing)
        return { allowed: true, reservation: { ...existing }, duplicate: true };
      if (current.active >= policy.maxConcurrent)
        return {
          allowed: false,
          reason: "concurrency",
          retryAt: null,
          availableUnits: current.availableUnits,
        };
      if (current.starts >= policy.maxStarts)
        return {
          allowed: false,
          reason: "starts",
          retryAt: current.nextReleaseAt,
          availableUnits: current.availableUnits,
        };
      if (estimate > current.availableUnits)
        return {
          allowed: false,
          reason: "units",
          retryAt: current.nextReleaseAt,
          availableUnits: current.availableUnits,
        };
      sequence += 1;
      const reservation: QuotaReservation = {
        id: `quota-${sequence}`,
        key,
        units: estimate,
        startedAt: now,
        finishedAt: null,
        actualUnits: null,
      };
      records.set(reservation.id, reservation);
      byKey.set(key, reservation.id);
      return {
        allowed: true,
        reservation: { ...reservation },
        duplicate: false,
      };
    },
    finish(id, result) {
      const now = time(result.now ?? clock());
      const actual = units(result.units);
      const record = records.get(id);
      if (!record || record.finishedAt !== null) return false;
      if (now < record.startedAt)
        throw new RangeError("finish time must not precede start time");
      record.finishedAt = now;
      record.actualUnits = actual;
      return true;
    },
    cancel(id, requestedNow = clock()) {
      const now = time(requestedNow);
      const record = records.get(id);
      if (!record || record.finishedAt !== null) return false;
      if (now < record.startedAt)
        throw new RangeError("cancel time must not precede start time");
      record.finishedAt = now;
      record.actualUnits = 0;
      return true;
    },
    snapshot,
    active: () =>
      [...records.values()]
        .filter((record) => record.finishedAt === null)
        .map((record) => ({ ...record })),
  };
}
