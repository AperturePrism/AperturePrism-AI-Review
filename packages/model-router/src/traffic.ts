/**
 * 模型流量：一个对象拥有当前进程的并发席位、账号队列、熔断与预算。
 *
 * @example
 * const traffic = new ModelTraffic({ maxConcurrent: 16, maxPerAccount: 4 });
 * await routeModelInvocation(adapters, { ...input, traffic });
 * console.log(traffic.snapshot());
 *
 * 不保存提示词或响应正文；调用者取消排队时会立即移除票据。
 * 多进程部署请为每个 worker 分配配额，进程内限流不是分布式配额。
 */
import { randomUUID } from "node:crypto";
import {
  ModelInvocationError,
  type ModelCandidate,
  type ModelErrorCategory,
  type ModelInvocationRequest,
  type ModelInvocationResponse,
  type ModelUsage,
} from "../../domain/src/index.js";
import { ModelBudget, type BudgetSnapshot, type ModelPrice } from "./budget.js";
import { metrics } from "../../observability/src/metrics.js";

export type CircuitPolicy = {
  failureThreshold: number;
  cooldownMs: number;
  /** 熔断信息保留多久；只在无等待与无运行调用时清理。 */
  idleTtlMs: number;
};

export type ModelTrafficOptions = {
  maxConcurrent?: number;
  maxPerAccount?: number;
  maxQueued?: number;
  queueTimeoutMs?: number;
  maxCandidates?: number;
  circuit?: Partial<CircuitPolicy>;
  budget?: ModelBudget;
  /** 价格按完整候选项查找，避免同账号多个模型错误共用价格。 */
  prices?: readonly { candidate: ModelCandidate; price: ModelPrice }[];
  estimateUsage?: (request: ModelInvocationRequest) => ModelUsage;
  now?: () => number;
  historyLimit?: number;
};

export type ModelAvailability = {
  available: boolean;
  reason:
    | "ready"
    | "account_busy"
    | "global_busy"
    | "circuit_open"
    | "probe_busy"
    | "queue_full";
  retryAfterMs: number;
};

export type TrafficRecord = {
  candidate: ModelCandidate;
  at: number;
  waitMs: number;
  durationMs: number;
  outcome: ModelErrorCategory | "success";
  usage: ModelUsage | null;
};

export type TrafficSnapshot = {
  running: number;
  queued: number;
  completed: number;
  failed: number;
  canceled: number;
  rejected: number;
  accounts: {
    provider: string;
    accountName: string;
    running: number;
    queued: number;
  }[];
  circuits: {
    candidate: ModelCandidate;
    state: "closed" | "open" | "half_open";
    consecutiveFailures: number;
    retryAfterMs: number;
    probeRunning: boolean;
  }[];
  budget: BudgetSnapshot | null;
};

type Circuit = {
  candidate: ModelCandidate;
  failures: number;
  openedUntil: number;
  probeRunning: boolean;
  generation: number;
  updatedAt: number;
};

type QueueTicket = {
  candidate: ModelCandidate;
  account: string;
  enqueuedAt: number;
  resolve: (admission: ModelAdmission) => void;
  reject: (reason: unknown) => void;
  cleanup: () => void;
};

export type ModelAdmission = {
  waitMs: number;
  /** 每个席位只归还一次；外部 finally 和错误路径可安全地重复调用。 */
  finish: (outcome?: ModelErrorCategory | null) => void;
};

const DEFAULT_CIRCUIT: CircuitPolicy = {
  failureThreshold: 5,
  cooldownMs: 30_000,
  idleTtlMs: 15 * 60_000,
};

/** 账号名包含冒号时仍保持独立，不能用字符串拼接产生碰撞。 */
function accountKey(candidate: ModelCandidate): string {
  return JSON.stringify([candidate.provider, candidate.accountName]);
}

function candidateIdentity(candidate: ModelCandidate): string {
  return JSON.stringify([
    candidate.provider,
    candidate.model,
    candidate.accountName,
  ]);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

/** 只是预留估算，不宣称它是特定模型的 tokenizer。真实账单用供应商返回的用量结算。 */
export function estimateRequestUsage(
  request: ModelInvocationRequest,
): ModelUsage {
  const textBytes =
    Buffer.byteLength(JSON.stringify(request.messages)) +
    Buffer.byteLength(JSON.stringify(request.tools ?? []));
  const imageCount = request.messages.reduce(
    (total, message) => total + (message.imageParts?.length ?? 0),
    0,
  );
  return {
    inputTokens: textBytes + imageCount * 4_096, // 按 UTF-8 字节预留，给未配置 tokenizer 的调用保守余量。
    outputTokens: request.maxOutputTokens ?? 4_096,
  };
}

export class ModelTraffic {
  private readonly maxConcurrent: number;
  private readonly maxPerAccount: number;
  private readonly maxQueued: number;
  private readonly queueTimeoutMs: number;
  private readonly maxCandidates: number;
  private readonly historyLimit: number;
  private readonly circuitPolicy: CircuitPolicy;
  private readonly now: () => number;
  private readonly budget: ModelBudget | undefined;
  private readonly prices: Map<string, ModelPrice>;
  private readonly estimateUsage: (
    request: ModelInvocationRequest,
  ) => ModelUsage;
  private readonly accounts = new Map<
    string,
    { candidate: ModelCandidate; running: number }
  >();
  private readonly circuits = new Map<string, Circuit>();
  private readonly queue: QueueTicket[] = [];
  private readonly records: TrafficRecord[] = [];
  private running = 0;
  private completed = 0;
  private failed = 0;
  private canceled = 0;
  private rejected = 0;

  constructor(options: ModelTrafficOptions = {}) {
    this.maxConcurrent = positiveInteger(
      options.maxConcurrent ?? 32,
      "maxConcurrent",
    );
    this.maxPerAccount = positiveInteger(
      options.maxPerAccount ?? 4,
      "maxPerAccount",
    );
    this.maxQueued = positiveInteger(options.maxQueued ?? 1_024, "maxQueued");
    this.queueTimeoutMs = positiveInteger(
      options.queueTimeoutMs ?? 30_000,
      "queueTimeoutMs",
    );
    this.maxCandidates = positiveInteger(
      options.maxCandidates ?? 2_000,
      "maxCandidates",
    );
    this.historyLimit = positiveInteger(
      options.historyLimit ?? 500,
      "historyLimit",
    );
    this.circuitPolicy = { ...DEFAULT_CIRCUIT, ...options.circuit };
    for (const [name, value] of Object.entries(this.circuitPolicy))
      positiveInteger(value, name);
    this.now = options.now ?? Date.now;
    this.budget = options.budget;
    this.prices = new Map(
      (options.prices ?? []).map(({ candidate, price }) => [
        candidateIdentity(candidate),
        { ...price },
      ]),
    );
    this.estimateUsage = options.estimateUsage ?? estimateRequestUsage;
  }

  /** 不发请求的路由预览；席位状态可能在真正调用前变化，仍须 acquire。 */
  availability(candidate: ModelCandidate): ModelAvailability {
    const circuit = this.circuits.get(candidateIdentity(candidate));
    if (circuit && circuit.openedUntil > this.now()) {
      return {
        available: false,
        reason: "circuit_open",
        retryAfterMs: circuit.openedUntil - this.now(),
      };
    }
    if (circuit?.probeRunning)
      return { available: false, reason: "probe_busy", retryAfterMs: 0 };
    if (this.queue.length >= this.maxQueued)
      return { available: false, reason: "queue_full", retryAfterMs: 0 };
    if (
      (this.accounts.get(accountKey(candidate))?.running ?? 0) >=
      this.maxPerAccount
    ) {
      return { available: false, reason: "account_busy", retryAfterMs: 0 };
    }
    if (this.running >= this.maxConcurrent)
      return { available: false, reason: "global_busy", retryAfterMs: 0 };
    return { available: true, reason: "ready", retryAfterMs: 0 };
  }

  /** 获取执行席位。早来的同账号请求优先，忙碌账号不会挡住其他空闲账号。 */
  acquire(
    candidate: ModelCandidate,
    signal: AbortSignal,
    waitMs = this.queueTimeoutMs,
  ): Promise<ModelAdmission> {
    if (signal.aborted)
      return Promise.reject(
        new ModelInvocationError("canceled", "model queue was canceled"),
      );
    if (!Number.isFinite(waitMs) || waitMs <= 0)
      return Promise.reject(
        new ModelInvocationError("timeout", "model queue deadline expired"),
      );
    this.pruneCircuits(); // 每次准入顺手淘汰过期历史，避免无限积累候选项。
    const state = this.availability(candidate);
    if (
      state.reason === "circuit_open" ||
      state.reason === "probe_busy" ||
      state.reason === "queue_full"
    ) {
      this.rejected += 1;
      return Promise.reject(
        new ModelInvocationError(
          "rate_limited",
          `model ${state.reason}`,
          state.retryAfterMs,
        ),
      );
    }
    return new Promise<ModelAdmission>((resolve, reject) => {
      const ticket: QueueTicket = {
        candidate: { ...candidate },
        account: accountKey(candidate),
        enqueuedAt: this.now(),
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
        },
      };
      const rejectTicket = (error: ModelInvocationError) => {
        const index = this.queue.indexOf(ticket);
        if (index === -1) return; // 席位已经开始运行，取消由适配器自己的 signal 处理。
        this.queue.splice(index, 1);
        ticket.cleanup();
        if (error.category === "canceled") this.canceled += 1;
        else this.rejected += 1;
        reject(error);
        this.drain(); // 前面的取消票据不能阻塞后面的空闲账号。
      };
      const onAbort = () =>
        rejectTicket(
          new ModelInvocationError("canceled", "model queue was canceled"),
        );
      const timer = setTimeout(
        () =>
          rejectTicket(
            new ModelInvocationError(
              "timeout",
              "model queue wait exceeded deadline",
            ),
          ),
        Math.min(waitMs, this.queueTimeoutMs),
      );
      signal.addEventListener("abort", onAbort, { once: true });
      this.queue.push(ticket);
      this.drain();
    });
  }

  /** 路由入口调用这一条主线：排队 → 预留 → 请求 → 结账 → 归还。 */
  async run(
    candidate: ModelCandidate,
    request: ModelInvocationRequest,
    signal: AbortSignal,
    waitMs: number,
    invoke: (remainingMs: number) => Promise<ModelInvocationResponse>,
  ): Promise<ModelInvocationResponse> {
    const enqueuedAt = this.now();
    const admission = await this.acquire(candidate, signal, waitMs);
    const startedAt = this.now();
    metrics.increment("model.requests");
    metrics.recordDuration("model.queue_wait_ms", admission.waitMs);
    let holdId: string | undefined;
    let outcome: ModelErrorCategory | null = null;
    let usage: ModelUsage | null = null;
    try {
      if (signal.aborted)
        throw new ModelInvocationError(
          "canceled",
          "model invocation was canceled before sending",
        );
      const remainingMs = waitMs - (this.now() - enqueuedAt);
      if (remainingMs <= 0)
        throw new ModelInvocationError(
          "timeout",
          "model deadline expired while waiting",
        );
      if (this.budget) {
        const price = this.prices.get(candidateIdentity(candidate));
        if (!price)
          throw new ModelInvocationError(
            "model_not_found",
            "model budget requires a configured price",
          );
        holdId = this.budget.reserve(
          randomUUID(),
          this.estimateUsage(request),
          price,
        ).id;
      }
      const response = await invoke(remainingMs);
      usage = response.usage;
      if (holdId) this.budget!.settle(holdId, response.usage);
      this.completed += 1;
      return response;
    } catch (error) {
      outcome =
        error instanceof ModelInvocationError ? error.category : "unknown";
      if (outcome === "canceled") this.canceled += 1;
      else this.failed += 1;
      if (holdId) this.budget!.release(holdId); // 供应商未报告用量，预留释放，不伪造已知账单。
      throw error;
    } finally {
      admission.finish(outcome);
      this.records.push({
        candidate: { ...candidate },
        at: startedAt,
        waitMs: admission.waitMs,
        durationMs: Math.max(0, this.now() - startedAt),
        outcome: outcome ?? "success",
        usage,
      });
      metrics.recordDuration(
        "model.invocation_ms",
        Math.max(0, this.now() - startedAt),
      );
      metrics.increment(`model.outcome.${outcome ?? "success"}`); // 类别是有限枚举，不用账号或请求ID制造无限指标名。
      if (usage) {
        metrics.increment("model.input_tokens", usage.inputTokens);
        metrics.increment("model.output_tokens", usage.outputTokens);
      }
      while (this.records.length > this.historyLimit) this.records.shift();
    }
  }

  /** 管理端可手动解除某个候选项熔断；正在运行的旧请求不能重开同一代状态。 */
  resetCircuit(candidate: ModelCandidate): boolean {
    const circuit = this.circuits.get(candidateIdentity(candidate));
    if (!circuit) return false;
    circuit.failures = 0;
    circuit.openedUntil = 0;
    circuit.probeRunning = false;
    circuit.generation += 1;
    circuit.updatedAt = this.now();
    this.drain();
    return true;
  }

  /** 停机时取消排队；在途请求由调用方拥有的 AbortController 结束。 */
  cancelQueued(): number {
    const pending = this.queue.splice(0);
    for (const ticket of pending) {
      ticket.cleanup();
      ticket.reject(
        new ModelInvocationError("canceled", "model queue was closed"),
      );
    }
    this.canceled += pending.length;
    return pending.length;
  }

  history(): TrafficRecord[] {
    return structuredClone(this.records);
  }

  snapshot(): TrafficSnapshot {
    const now = this.now();
    const accounts = new Map<
      string,
      { provider: string; accountName: string; running: number; queued: number }
    >();
    for (const [key, account] of this.accounts) {
      accounts.set(key, {
        provider: account.candidate.provider,
        accountName: account.candidate.accountName,
        running: account.running,
        queued: 0,
      });
    }
    for (const ticket of this.queue) {
      const account = accounts.get(ticket.account) ?? {
        provider: ticket.candidate.provider,
        accountName: ticket.candidate.accountName,
        running: 0,
        queued: 0,
      };
      account.queued += 1;
      accounts.set(ticket.account, account);
    }
    return {
      running: this.running,
      queued: this.queue.length,
      completed: this.completed,
      failed: this.failed,
      canceled: this.canceled,
      rejected: this.rejected,
      accounts: [...accounts.values()],
      circuits: [...this.circuits.values()].map((circuit) => ({
        candidate: { ...circuit.candidate },
        state:
          circuit.openedUntil > now
            ? "open"
            : circuit.openedUntil > 0
              ? "half_open"
              : "closed",
        consecutiveFailures: circuit.failures,
        retryAfterMs: Math.max(0, circuit.openedUntil - now),
        probeRunning: circuit.probeRunning,
      })),
      budget: this.budget?.snapshot() ?? null,
    };
  }

  // --- 依次给空闲账号发席位 ---
  private drain(): void {
    while (this.running < this.maxConcurrent) {
      const index = this.queue.findIndex(
        (ticket) =>
          (this.accounts.get(ticket.account)?.running ?? 0) <
          this.maxPerAccount,
      );
      if (index === -1) return;
      const [ticket] = this.queue.splice(index, 1);
      if (!ticket) return;
      ticket.cleanup();
      const key = candidateIdentity(ticket.candidate);
      const circuit = this.circuits.get(key) ?? {
        candidate: { ...ticket.candidate },
        failures: 0,
        openedUntil: 0,
        probeRunning: false,
        generation: 0,
        updatedAt: this.now(),
      };
      if (circuit.openedUntil > this.now() || circuit.probeRunning) {
        this.rejected += 1;
        ticket.reject(
          new ModelInvocationError(
            "rate_limited",
            "model circuit is unavailable",
            Math.max(0, circuit.openedUntil - this.now()),
          ),
        );
        continue;
      }
      if (!this.circuits.has(key) && this.circuits.size >= this.maxCandidates) {
        this.rejected += 1;
        ticket.reject(
          new ModelInvocationError(
            "rate_limited",
            "model candidate capacity is full",
          ),
        );
        continue;
      }
      this.circuits.set(key, circuit);
      const probe = circuit.openedUntil > 0; // 冷却到期后只放一个探测，避免恢复瞬间再次冲垮供应商。
      if (probe) circuit.probeRunning = true;
      const generation = circuit.generation;
      const account = this.accounts.get(ticket.account) ?? {
        candidate: { ...ticket.candidate },
        running: 0,
      };
      account.running += 1;
      this.accounts.set(ticket.account, account);
      this.running += 1;
      let finished = false;
      ticket.resolve({
        waitMs: Math.max(0, this.now() - ticket.enqueuedAt),
        finish: (outcome = null) => {
          if (finished) return;
          finished = true;
          account.running -= 1;
          this.running -= 1;
          if (account.running === 0) this.accounts.delete(ticket.account);
          if (circuit.generation === generation)
            this.recordCircuit(circuit, outcome, probe);
          this.drain();
        },
      });
    }
  }

  private recordCircuit(
    circuit: Circuit,
    outcome: ModelErrorCategory | null,
    probe: boolean,
  ): void {
    circuit.updatedAt = this.now();
    if (probe) circuit.probeRunning = false;
    if (outcome === null) {
      circuit.failures = 0;
      circuit.openedUntil = 0;
      return;
    }
    if (outcome === "canceled") return; // 用户主动取消并不说明供应商损坏。
    const providerFault =
      outcome === "connection_failed" ||
      outcome === "timeout" ||
      outcome === "server_error";
    if (!providerFault) {
      if (probe) circuit.openedUntil = 0; // 认证/输入报错说明服务已能响应，交给路由处理。
      return;
    }
    circuit.failures += 1;
    if (probe || circuit.failures >= this.circuitPolicy.failureThreshold) {
      circuit.openedUntil = this.now() + this.circuitPolicy.cooldownMs;
      circuit.generation += 1; // 熔断后到达的旧成功不能提前把熔断抹掉。
    }
  }

  private pruneCircuits(): void {
    const cutoff = this.now() - this.circuitPolicy.idleTtlMs;
    for (const [key, circuit] of this.circuits) {
      if (
        circuit.updatedAt >= cutoff ||
        circuit.probeRunning ||
        this.accounts.has(accountKey(circuit.candidate))
      )
        continue;
      if (
        this.queue.some((ticket) => candidateIdentity(ticket.candidate) === key)
      )
        continue;
      this.circuits.delete(key);
    }
  }
}
