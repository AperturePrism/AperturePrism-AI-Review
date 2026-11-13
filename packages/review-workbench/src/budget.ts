/**
 * 预算的预留、结算和释放。金额始终用整数微美元，预留也计入额度。
 * @example reserveBudget(context, {id:budgetId, key:'task-42', estimate:{amountMicros:2500, inputTokens:1000, outputTokens:500, requests:1}});
 */
import type {
  Budget,
  BudgetLimits,
  BudgetUsage,
  Reservation,
} from "./types.js";
import { audit, identity, touch, type CommandContext } from "./audit.js";
import {
  boolean,
  findRecord,
  integer,
  object,
  revision,
  text,
  timestamp,
  WorkbenchError,
} from "./utils/input.js";

const dimensions = [
  "amountMicros",
  "inputTokens",
  "outputTokens",
  "requests",
] as const;
const maximum = Math.floor(Number.MAX_SAFE_INTEGER / 4);

export function emptyUsage(): BudgetUsage {
  return { amountMicros: 0, inputTokens: 0, outputTokens: 0, requests: 0 };
}

export function parseUsage(value: unknown, field = "usage"): BudgetUsage {
  const input = object(value, field);
  return {
    amountMicros: integer(
      input.amountMicros,
      `${field}.amountMicros`,
      0,
      maximum,
      0,
    ),
    inputTokens: integer(
      input.inputTokens,
      `${field}.inputTokens`,
      0,
      maximum,
      0,
    ),
    outputTokens: integer(
      input.outputTokens,
      `${field}.outputTokens`,
      0,
      maximum,
      0,
    ),
    requests: integer(input.requests, `${field}.requests`, 0, maximum, 0),
  };
}

function add(left: BudgetUsage, right: BudgetUsage): BudgetUsage {
  const sum = emptyUsage();
  for (const dimension of dimensions) {
    sum[dimension] = left[dimension] + right[dimension];
    if (!Number.isSafeInteger(sum[dimension]))
      throw new WorkbenchError("usage_overflow", "预算累计值超出安全整数范围");
  }
  return sum;
}

/** token 单价以“每百万 token 的微美元”输入，向上取整不会低估预算。 */
export function estimateCostMicros(
  inputTokens: number,
  outputTokens: number,
  inputPerMillionMicros: number,
  outputPerMillionMicros: number,
): number {
  for (const [field, value] of Object.entries({
    inputTokens,
    outputTokens,
    inputPerMillionMicros,
    outputPerMillionMicros,
  })) {
    integer(value, field, 0, maximum);
  }
  const numerator =
    BigInt(inputTokens) * BigInt(inputPerMillionMicros) +
    BigInt(outputTokens) * BigInt(outputPerMillionMicros);
  const total = (numerator + 999_999n) / 1_000_000n;
  if (total > BigInt(Number.MAX_SAFE_INTEGER))
    throw new WorkbenchError("cost_overflow", "费用超过安全整数范围");
  return Number(total);
}

export function createBudget(
  context: CommandContext,
  input: Record<string, unknown>,
): Budget {
  const periodStart = timestamp(input.periodStart, "periodStart");
  const periodEnd = timestamp(input.periodEnd, "periodEnd");
  if (periodEnd <= periodStart)
    throw new WorkbenchError("invalid_period", "预算结束时间必须晚于开始时间");
  const budget: Budget = {
    ...identity(context),
    name: text(input.name, "name", 200),
    periodStart,
    periodEnd,
    currency: "USD",
    enabled: boolean(input.enabled, "enabled", true),
    limits: parseUsage(input.limits, "limits"),
    usage: emptyUsage(),
  };
  context.data.budgets.push(budget);
  audit(context, "budget.created", budget.id, {
    periodStart,
    periodEnd,
    amountMicros: budget.limits.amountMicros,
  });
  return budget;
}

export function toggleBudget(
  context: CommandContext,
  input: Record<string, unknown>,
): Budget {
  const budget = findRecord(context.data.budgets, context.repository, input.id);
  revision(budget, input.expectedRevision);
  budget.enabled = boolean(input.enabled, "enabled");
  touch(context, budget);
  audit(context, "budget.toggled", budget.id, { enabled: budget.enabled });
  return budget;
}

/** 修改额度不能低于已经花掉或仍在预留中的用量。 */
export function updateBudgetLimits(
  context: CommandContext,
  input: Record<string, unknown>,
): Budget {
  const budget = findRecord(context.data.budgets, context.repository, input.id);
  revision(budget, input.expectedRevision);
  const limits = parseUsage(input.limits, "limits");
  const occupied = occupiedBudget(context, budget);
  for (const dimension of dimensions) {
    if (limits[dimension] < occupied[dimension])
      throw new WorkbenchError(
        "budget_in_use",
        `${dimension} 额度不能低于已用和预留的总量`,
        409,
      );
  }
  budget.limits = limits;
  touch(context, budget);
  audit(context, "budget.limits_updated", budget.id, {
    amountMicros: limits.amountMicros,
  });
  return budget;
}

function activeReservation(reservation: Reservation, now: string): boolean {
  return reservation.status === "reserved" && reservation.expiresAt > now;
}

function occupiedBudget(
  context: CommandContext,
  budget: Budget,
  excludeReservation = "",
): BudgetUsage {
  let occupied = { ...budget.usage };
  for (const reservation of context.data.reservations) {
    if (
      reservation.repository !== context.repository ||
      reservation.budgetId !== budget.id ||
      reservation.id === excludeReservation ||
      !activeReservation(reservation, context.now)
    )
      continue;
    occupied = add(occupied, reservation.estimate);
  }
  return occupied;
}

function enforceLimits(limits: BudgetLimits, total: BudgetUsage): void {
  for (const dimension of dimensions) {
    if (total[dimension] > limits[dimension])
      throw new WorkbenchError(
        "budget_exceeded",
        `${dimension} 预算不足：需要 ${total[dimension]}，额度 ${limits[dimension]}`,
        409,
      );
  }
}

/** 相同 key 重复调用得到同一预留；不同估算不能复用旧 key。 */
export function reserveBudget(
  context: CommandContext,
  input: Record<string, unknown>,
): Reservation {
  const budget = findRecord(context.data.budgets, context.repository, input.id);
  const key = text(input.key, "key", 300);
  const estimate = parseUsage(input.estimate, "estimate");
  const existing = context.data.reservations.find(
    (reservation) =>
      reservation.repository === context.repository &&
      reservation.budgetId === budget.id &&
      reservation.key === key,
  );
  if (existing) {
    if (
      dimensions.some(
        (dimension) => existing.estimate[dimension] !== estimate[dimension],
      )
    )
      throw new WorkbenchError(
        "idempotency_conflict",
        "同一预留 key 不能改用不同估算",
        409,
      );
    return existing;
  }
  if (!budget.enabled)
    throw new WorkbenchError("budget_disabled", "预算已停用", 409);
  if (context.now < budget.periodStart || context.now >= budget.periodEnd)
    throw new WorkbenchError(
      "budget_outside_period",
      "当前时间不在预算周期内",
      409,
    );
  const expiresMs = integer(
    input.expiresMs,
    "expiresMs",
    1000,
    86_400_000,
    300_000,
  );
  const expiresAt = new Date(
    Math.min(
      new Date(context.now).getTime() + expiresMs,
      new Date(budget.periodEnd).getTime(),
    ),
  ).toISOString();
  enforceLimits(budget.limits, add(occupiedBudget(context, budget), estimate));
  const reservation: Reservation = {
    ...identity(context),
    budgetId: budget.id,
    key,
    status: "reserved",
    estimate,
    actual: null,
    expiresAt,
  };
  context.data.reservations.push(reservation);
  audit(context, "budget.reserved", reservation.id, {
    budgetId: budget.id,
    key,
    amountMicros: estimate.amountMicros,
  });
  return reservation;
}

/** 结算不受停用开关影响，已发生的真实费用仍要如实记账。 */
export function settleBudget(
  context: CommandContext,
  input: Record<string, unknown>,
): Reservation {
  const reservation = findRecord(
    context.data.reservations,
    context.repository,
    input.reservationId ?? input.id,
  );
  const actual = parseUsage(input.actual, "actual");
  if (reservation.status === "settled") {
    if (
      dimensions.some(
        (dimension) => reservation.actual?.[dimension] !== actual[dimension],
      )
    )
      throw new WorkbenchError(
        "idempotency_conflict",
        "已结算预留不能改写费用",
        409,
      );
    return reservation;
  }
  if (!activeReservation(reservation, context.now))
    throw new WorkbenchError(
      "reservation_expired",
      "预留已释放或到期，无法结算",
      409,
    );
  const budget = findRecord(
    context.data.budgets,
    context.repository,
    reservation.budgetId,
  );
  enforceLimits(
    budget.limits,
    add(occupiedBudget(context, budget, reservation.id), actual),
  );
  budget.usage = add(budget.usage, actual);
  reservation.actual = actual;
  reservation.status = "settled";
  touch(context, budget);
  touch(context, reservation);
  audit(context, "budget.settled", reservation.id, {
    budgetId: budget.id,
    amountMicros: actual.amountMicros,
  });
  return reservation;
}

export function releaseBudget(
  context: CommandContext,
  input: Record<string, unknown>,
): Reservation {
  const reservation = findRecord(
    context.data.reservations,
    context.repository,
    input.reservationId ?? input.id,
  );
  if (reservation.status === "settled")
    throw new WorkbenchError("reservation_settled", "已结算预留不能释放", 409);
  if (reservation.status === "released") return reservation;
  reservation.status = "released";
  touch(context, reservation);
  audit(context, "budget.released", reservation.id, {
    budgetId: reservation.budgetId,
  });
  return reservation;
}

export function budgetAvailability(
  context: CommandContext,
  input: Record<string, unknown>,
): {
  budget: Budget;
  occupied: BudgetUsage;
  remaining: BudgetUsage;
  reservations: Reservation[];
  active: boolean;
} {
  const budget = findRecord(context.data.budgets, context.repository, input.id);
  const occupied = occupiedBudget(context, budget);
  const remaining = emptyUsage();
  for (const dimension of dimensions)
    remaining[dimension] = Math.max(
      0,
      budget.limits[dimension] - occupied[dimension],
    );
  return {
    budget,
    occupied,
    remaining,
    reservations: context.data.reservations.filter(
      (reservation) =>
        reservation.repository === context.repository &&
        reservation.budgetId === budget.id,
    ),
    active:
      budget.enabled &&
      context.now >= budget.periodStart &&
      context.now < budget.periodEnd,
  };
}

/** 定期清理到期预留但保留幂等键，防止过期请求迟到后重复收费。 */
export function expireReservations(context: CommandContext): {
  released: number;
} {
  let released = 0;
  for (const reservation of context.data.reservations) {
    if (
      reservation.repository !== context.repository ||
      reservation.status !== "reserved" ||
      reservation.expiresAt > context.now
    )
      continue;
    reservation.status = "released";
    touch(context, reservation);
    audit(context, "budget.expired", reservation.id, {
      budgetId: reservation.budgetId,
    });
    released += 1;
  }
  return { released };
}
