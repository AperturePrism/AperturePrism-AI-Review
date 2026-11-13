/**
 * 模型预算：价格换算、并发预留和实际用量由这一份账本统一拥有。
 *
 * @example
 * const budget = new ModelBudget({ maxCostMicros: 2_000_000 });
 * const hold = budget.reserve("job-1", { inputTokens: 100, outputTokens: 50 }, price);
 * budget.settle(hold.id, { inputTokens: 90, outputTokens: 20 });
 *
 * 账本只覆盖当前进程；多 worker 的硬限额应由调用方在数据库事务中统一预留。
 * 金额使用百万分之一货币单位，不用浮点小数累计费用。
 */
import { randomUUID } from "node:crypto"; // 每个并发请求拥有唯一的预留凭据。
import {
  ModelInvocationError,
  type ModelUsage,
} from "../../domain/src/index.js";

export type ModelPrice = {
  currency: string;
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
};

export type BudgetLimits = {
  maxCostMicros?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxRequests?: number;
};

export type BudgetTotals = {
  costMicros: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
};

export type BudgetReservation = {
  id: string;
  requestId: string;
  estimated: ModelUsage;
  price: ModelPrice;
  costMicros: number;
  createdAt: number;
};

export type BudgetReceipt = {
  reservationId: string;
  requestId: string;
  usage: ModelUsage;
  currency: string;
  costMicros: number;
  settledAt: number;
};

export type BudgetSnapshot = {
  limits: BudgetLimits;
  spent: BudgetTotals;
  reserved: BudgetTotals;
  available: BudgetLimits;
  reservations: number;
  currency: string | null;
  exceeded: boolean;
};

function nonnegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    // 价格与 token 数都必须可精确表示。
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

/** 校验外部价格，并复制后保存，避免调用方在预留之后改价。 */
export function validateModelPrice(price: ModelPrice): ModelPrice {
  if (!/^[A-Z]{3}$/.test(price.currency))
    throw new RangeError("currency must be a three-letter uppercase code");
  nonnegativeInteger(price.inputMicrosPerMillion, "inputMicrosPerMillion");
  nonnegativeInteger(price.outputMicrosPerMillion, "outputMicrosPerMillion");
  return { ...price };
}

/** 输入与输出先按有理数相加，最后向上取整一次，避免每段分别取整造成多收。 */
export function estimateCostMicros(
  usage: ModelUsage,
  price: ModelPrice,
): number {
  nonnegativeInteger(usage.inputTokens, "inputTokens");
  nonnegativeInteger(usage.outputTokens, "outputTokens");
  validateModelPrice(price); // 价格来自外部配置，换算入口只检查一次。
  const numerator =
    BigInt(usage.inputTokens) * BigInt(price.inputMicrosPerMillion) +
    BigInt(usage.outputTokens) * BigInt(price.outputMicrosPerMillion);
  const result = (numerator + 999_999n) / 1_000_000n; // 不足一个微单位按一个计，绝不低估预留。
  if (result > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError("calculated cost exceeds safe integer range");
  return Number(result);
}

/** 将精确微单位显示为定长小数，不经过浮点除法。 */
export function formatCostMicros(amount: number): string {
  nonnegativeInteger(amount, "amount");
  const value = BigInt(amount);
  return `${value / 1_000_000n}.${String(value % 1_000_000n).padStart(6, "0")}`;
}

function emptyTotals(): BudgetTotals {
  return { costMicros: 0, inputTokens: 0, outputTokens: 0, requests: 0 };
}

function addTotals(
  left: BudgetTotals,
  right: BudgetTotals,
  direction = 1,
): BudgetTotals {
  const totals: BudgetTotals = {
    costMicros: left.costMicros + direction * right.costMicros,
    inputTokens: left.inputTokens + direction * right.inputTokens,
    outputTokens: left.outputTokens + direction * right.outputTokens,
    requests: left.requests + direction * right.requests,
  };
  for (const [name, value] of Object.entries(totals))
    nonnegativeInteger(value, name);
  return totals;
}

function reservationTotals(hold: BudgetReservation): BudgetTotals {
  return { ...hold.estimated, costMicros: hold.costMicros, requests: 1 };
}

/** 检查包含在途请求的总额，预留必须和检查在同一个同步步骤中完成。 */
function exceeds(total: BudgetTotals, limits: BudgetLimits): boolean {
  return (
    (limits.maxCostMicros !== undefined &&
      total.costMicros > limits.maxCostMicros) ||
    (limits.maxInputTokens !== undefined &&
      total.inputTokens > limits.maxInputTokens) ||
    (limits.maxOutputTokens !== undefined &&
      total.outputTokens > limits.maxOutputTokens) ||
    (limits.maxRequests !== undefined && total.requests > limits.maxRequests)
  );
}

export class ModelBudget {
  private limits: BudgetLimits;
  private spent = emptyTotals();
  private reserved = emptyTotals();
  private currency: string | null = null;
  private readonly holds = new Map<string, BudgetReservation>();
  private readonly pendingRequests = new Map<string, string>();
  private readonly receipts = new Map<string, BudgetReceipt>();
  private readonly now: () => number;
  private readonly receiptLimit: number;

  constructor(
    limits: BudgetLimits = {},
    options: { now?: () => number; receiptLimit?: number } = {},
  ) {
    for (const [name, value] of Object.entries(limits))
      nonnegativeInteger(value, name);
    this.limits = { ...limits }; // 外部配置变化不影响已经开始的计费周期。
    this.now = options.now ?? Date.now;
    this.receiptLimit = options.receiptLimit ?? 2_000;
    nonnegativeInteger(this.receiptLimit, "receiptLimit");
  }

  /** 在发送 HTTP 之前预留；并发请求不能各自看到同一份剩余额度。 */
  reserve(
    requestId: string,
    estimated: ModelUsage,
    price: ModelPrice,
  ): BudgetReservation {
    if (!requestId.trim()) throw new RangeError("requestId is required");
    if (this.pendingRequests.has(requestId))
      throw new Error("request already has a budget reservation");
    const copiedPrice = validateModelPrice(price);
    if (this.currency !== null && copiedPrice.currency !== this.currency)
      throw new RangeError("a budget cannot mix currencies");
    const costMicros = estimateCostMicros(estimated, copiedPrice);
    const hold: BudgetReservation = {
      id: randomUUID(),
      requestId,
      estimated: { ...estimated },
      price: copiedPrice,
      costMicros,
      createdAt: this.now(),
    };
    const nextReserved = addTotals(this.reserved, reservationTotals(hold));
    if (exceeds(addTotals(this.spent, nextReserved), this.limits)) {
      throw new ModelInvocationError(
        "rate_limited",
        "model budget is exhausted",
      );
    }
    this.currency = copiedPrice.currency;
    this.reserved = nextReserved;
    this.holds.set(hold.id, hold);
    this.pendingRequests.set(requestId, hold.id);
    return structuredClone(hold); // 不让调用方修改正在计账的对象。
  }

  /** 成功或已知部分用量时结算；重复回调返回同一收据，不重复扣账。 */
  settle(reservationId: string, usage: ModelUsage): BudgetReceipt {
    const previous = this.receipts.get(reservationId);
    if (previous) return structuredClone(previous);
    const hold = this.holds.get(reservationId);
    if (!hold) throw new Error("budget reservation does not exist");
    const costMicros = estimateCostMicros(usage, hold.price);
    const nextSpent = addTotals(this.spent, {
      ...usage,
      costMicros,
      requests: 1,
    });
    const nextReserved = addTotals(this.reserved, reservationTotals(hold), -1);
    const receipt: BudgetReceipt = {
      reservationId,
      requestId: hold.requestId,
      usage: { ...usage },
      currency: hold.price.currency,
      costMicros,
      settledAt: this.now(),
    };
    this.spent = nextSpent; // 实际账单即便超出预估也必须记录，不能把超额使用隐藏掉。
    this.reserved = nextReserved;
    this.holds.delete(reservationId);
    this.pendingRequests.delete(hold.requestId);
    this.receipts.set(reservationId, receipt);
    while (this.receipts.size > this.receiptLimit)
      this.receipts.delete(this.receipts.keys().next().value!);
    return structuredClone(receipt);
  }

  /** 连接建立前失败可释放预留；供应商有部分账单时应调用 settle 而非 release。 */
  release(reservationId: string): boolean {
    const hold = this.holds.get(reservationId);
    if (!hold) return false;
    this.reserved = addTotals(this.reserved, reservationTotals(hold), -1);
    this.holds.delete(reservationId);
    this.pendingRequests.delete(hold.requestId);
    return true;
  }

  /** 管理端修改限额后立即影响下一次预留，不抹去既有费用。 */
  setLimits(limits: BudgetLimits): void {
    for (const [name, value] of Object.entries(limits))
      nonnegativeInteger(value, name);
    this.limits = { ...limits };
  }

  /** 开始新计费周期时，仍有在途请求就拒绝清零，避免账单落入错误周期。 */
  reset(): void {
    if (this.holds.size > 0)
      throw new Error("cannot reset budget with pending reservations");
    this.spent = emptyTotals();
    this.receipts.clear();
    this.currency = null;
  }

  /** 有限记录供管理端排查：只包含数量和金额，不包含提示词或模型正文。 */
  history(): BudgetReceipt[] {
    return structuredClone([...this.receipts.values()]);
  }

  snapshot(): BudgetSnapshot {
    const total = addTotals(this.spent, this.reserved);
    const available: BudgetLimits = {};
    if (this.limits.maxCostMicros !== undefined)
      available.maxCostMicros = Math.max(
        0,
        this.limits.maxCostMicros - total.costMicros,
      );
    if (this.limits.maxInputTokens !== undefined)
      available.maxInputTokens = Math.max(
        0,
        this.limits.maxInputTokens - total.inputTokens,
      );
    if (this.limits.maxOutputTokens !== undefined)
      available.maxOutputTokens = Math.max(
        0,
        this.limits.maxOutputTokens - total.outputTokens,
      );
    if (this.limits.maxRequests !== undefined)
      available.maxRequests = Math.max(
        0,
        this.limits.maxRequests - total.requests,
      );
    return {
      limits: { ...this.limits },
      spent: { ...this.spent },
      reserved: { ...this.reserved },
      available,
      reservations: this.holds.size,
      currency: this.currency,
      exceeded: exceeds(total, this.limits),
    };
  }
}
