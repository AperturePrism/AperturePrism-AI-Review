/**
 * 模型调用入口：候选顺序 → 可选流量准入 → 有界请求 → 重试或回退。
 * @example
 * await routeModelInvocation(adapters, { candidates, request, deadlineMs: 30_000,
 *   retryPolicy: { maxAttemptsPerCandidate: 2, baseDelayMs: 100, maxDelayMs: 1000 }, traffic });
 */
import {
  ModelInvocationError,
  nonRetryableModelErrorCategories,
  type ModelAttemptOutcome,
  type ModelCandidate,
  type ModelErrorCategory,
  type ModelInvocationRequest,
  type ModelInvocationResponse,
  type ModelProviderAdapter,
  type ModelRoutingResult,
} from "../../../packages/domain/src/index.js";
import { ModelTraffic, type ModelTrafficOptions } from "./traffic.js";
import { ModelResponseCache, type CacheStatus } from "./cache.js";
import { redactDiagnosticText } from "../../observability/src/redaction.js";

export * from "./openai-compatible.js";
export * from "./traffic.js";
export * from "./budget.js";
export * from "./cache.js";
export * from "./stream.js";
export * from "./health.js";

const trafficByAdapters = new WeakMap<
  ReadonlyMap<string, ModelProviderAdapter>,
  ModelTraffic
>();

/** 默认对每组连接账号共享限流；不需要现有 worker 改参数才能获得保护。 */
export function getModelTraffic(
  adapters: ReadonlyMap<string, ModelProviderAdapter>,
): ModelTraffic {
  let traffic = trafficByAdapters.get(adapters);
  if (!traffic) {
    traffic = new ModelTraffic();
    trafficByAdapters.set(adapters, traffic);
  }
  return traffic;
}

/** 配置重载时在同一个 Map 上替换配额。请在没有在途请求时更换，以免新旧配额并行。 */
export function configureModelTraffic(
  adapters: ReadonlyMap<string, ModelProviderAdapter>,
  options: ModelTrafficOptions,
): ModelTraffic {
  const current = trafficByAdapters.get(adapters);
  if (
    current &&
    (current.snapshot().running > 0 || current.snapshot().queued > 0)
  )
    throw new Error("cannot replace model traffic while requests are active");
  const traffic = new ModelTraffic(options);
  trafficByAdapters.set(adapters, traffic);
  return traffic;
}

export type RetryPolicy = {
  /** Attempts allowed per candidate, including the first one. */
  maxAttemptsPerCandidate: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /**
   * Opt-in: retry the same candidate on `authentication_failed` too. Some
   * gateways intermittently answer 401 under load (not a real credential
   * problem), so the caller can allow bounded retries while the default stays
   * non-retryable for genuine credential errors.
   */
  retryAuthentication?: boolean;
  /** 0 保持确定性的旧行为；1 在 0 到上限间随机退避，避免所有 worker 同时重试。 */
  jitterRatio?: number;
};

export type RouteModelInput = {
  candidates: readonly ModelCandidate[];
  request: ModelInvocationRequest;
  /** Total wall-clock budget shared by every candidate, retry, and backoff. */
  deadlineMs: number;
  retryPolicy: RetryPolicy;
  /** Candidate preferred for this task, tried first when still present. */
  stickyCandidate?: ModelCandidate | undefined;
  signal?: AbortSignal | undefined;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  traffic?: ModelTraffic;
  cache?: ModelResponseCache;
  /** 必须包含租户与策略版本；工具调用存在副作用时不要启用缓存。 */
  cacheScope?: string;
};

export type RoutedModelResult = ModelRoutingResult & {
  cache?: {
    status: CacheStatus;
    reusedUsage: { inputTokens: number; outputTokens: number };
  };
};

export class ModelRoutingFailedError extends Error {
  readonly attempts: readonly ModelAttemptOutcome[];
  readonly lastCategory: ModelErrorCategory;
  /** 最后一次失败的底层错误消息（可能含网关响应体，便于排查 5xx 根因）。 */
  readonly lastMessage: string | undefined;

  constructor(
    lastCategory: ModelErrorCategory,
    attempts: readonly ModelAttemptOutcome[],
    lastMessage?: string,
  ) {
    super(
      `model routing exhausted all candidates: ${lastCategory}${
        lastMessage ? ` — ${lastMessage}` : ""
      }`,
    );
    this.name = "ModelRoutingFailedError";
    this.attempts = attempts;
    this.lastCategory = lastCategory;
    this.lastMessage = lastMessage;
  }
}

export function candidateKey(candidate: ModelCandidate): string {
  return JSON.stringify([
    candidate.provider,
    candidate.model,
    candidate.accountName,
  ]); // 账号/模型名可以含冒号，三元组不能靠分隔符猜边界。
}

/**
 * Puts the sticky candidate first so a task keeps using the model that already
 * worked for it, without dropping the remaining fallbacks.
 */
export function orderCandidates(
  candidates: readonly ModelCandidate[],
  sticky: ModelCandidate | undefined,
): readonly ModelCandidate[] {
  if (!sticky) return candidates;
  const stickyKey = candidateKey(sticky);
  const preferred = candidates.filter((c) => candidateKey(c) === stickyKey);
  if (preferred.length === 0) return candidates;
  return [
    ...preferred,
    ...candidates.filter((c) => candidateKey(c) !== stickyKey),
  ];
}

export function backoffDelayMs(
  attempt: number,
  policy: RetryPolicy,
  random = Math.random,
): number {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  const ratio = policy.jitterRatio ?? 0;
  return Math.round(
    capped * (1 - ratio + ratio * Math.min(1, Math.max(0, random()))),
  );
}

function toModelError(error: unknown): ModelInvocationError {
  if (error instanceof ModelInvocationError) return error;
  if (error instanceof Error && error.name === "AbortError")
    return new ModelInvocationError("canceled", "invocation was canceled");
  return new ModelInvocationError(
    "unknown",
    error instanceof Error
      ? redactDiagnosticText(error.message)
      : "unknown provider failure",
  );
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted)
    return Promise.reject(
      new ModelInvocationError("canceled", "wait was canceled"),
    );
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ModelInvocationError("canceled", "wait was canceled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs candidates in order under a single logical deadline. Adapters classify
 * failures; this router decides whether to retry the same candidate, move to
 * the next one, or stop.
 */
export async function routeModelInvocation(
  adapters: ReadonlyMap<string, ModelProviderAdapter>,
  input: RouteModelInput,
): Promise<RoutedModelResult> {
  validateRoutingInput(input); // 外部调用边界只检查一次，内部路径使用已确定的参数。
  if (!input.cache) return routeCandidates(adapters, input);
  if (!input.cacheScope?.trim())
    throw new RangeError(
      "cacheScope is required when enabling model response caching",
    );
  const { value, status } = await input.cache.run(
    input.cacheScope,
    {
      candidates: input.candidates,
      request: input.request,
      retryPolicy: input.retryPolicy,
      stickyCandidate: input.stickyCandidate,
      deadlineMs: input.deadlineMs,
    },
    (signal) => routeCandidates(adapters, { ...input, signal }),
    input.signal,
  );
  if (status === "miss")
    return {
      ...value,
      cache: { status, reusedUsage: { inputTokens: 0, outputTokens: 0 } },
    };
  return {
    ...value,
    response: { ...value.response, usage: { inputTokens: 0, outputTokens: 0 } },
    attempts: [],
    cache: { status, reusedUsage: { ...value.response.usage } },
  }; // 缓存命中不会再次向供应商付费，不能重复累计原调用用量。
}

function validateRoutingInput(input: RouteModelInput): void {
  if (
    !Number.isFinite(input.deadlineMs) ||
    input.deadlineMs < 0 ||
    input.deadlineMs > 2_147_483_647
  )
    throw new RangeError("deadlineMs must be non-negative and fit a timer");
  const policy = input.retryPolicy;
  if (
    !Number.isSafeInteger(policy.maxAttemptsPerCandidate) ||
    policy.maxAttemptsPerCandidate < 1 ||
    policy.maxAttemptsPerCandidate > 100
  )
    throw new RangeError("maxAttemptsPerCandidate must be between 1 and 100");
  if (
    ![policy.baseDelayMs, policy.maxDelayMs].every(
      (value) => Number.isFinite(value) && value >= 0,
    )
  )
    throw new RangeError("retry delays must be finite and non-negative");
  if (
    policy.jitterRatio !== undefined &&
    (!Number.isFinite(policy.jitterRatio) ||
      policy.jitterRatio < 0 ||
      policy.jitterRatio > 1)
  )
    throw new RangeError("jitterRatio must be between 0 and 1");
}

async function routeCandidates(
  adapters: ReadonlyMap<string, ModelProviderAdapter>,
  input: RouteModelInput,
): Promise<ModelRoutingResult> {
  const traffic = input.traffic ?? getModelTraffic(adapters);
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? defaultSleep;
  const deadlineAt = now() + input.deadlineMs;
  const attempts: ModelAttemptOutcome[] = [];
  const controller = new AbortController();
  const abortOuter = () => controller.abort();
  input.signal?.addEventListener("abort", abortOuter, { once: true });

  const remaining = () => deadlineAt - now();
  let lastCategory: ModelErrorCategory = "unknown";
  let lastMessage: string | undefined;

  try {
    if (input.signal?.aborted)
      throw new ModelRoutingFailedError("canceled", attempts, lastMessage);

    for (const candidate of orderCandidates(
      input.candidates,
      input.stickyCandidate,
    )) {
      const adapter = adapters.get(candidate.provider);
      if (!adapter) {
        lastCategory = "model_not_found";
        attempts.push({
          candidate,
          startedAt: new Date(now()),
          finishedAt: new Date(now()),
          usage: null,
          errorCategory: "model_not_found",
        });
        continue;
      }

      for (
        let attempt = 1;
        attempt <= input.retryPolicy.maxAttemptsPerCandidate;
        attempt += 1
      ) {
        if (remaining() <= 0) {
          lastCategory = "timeout";
          throw new ModelRoutingFailedError(
            lastCategory,
            attempts,
            lastMessage,
          );
        }

        const startedAt = new Date(now());
        try {
          const invoke = (budgetMs: number) =>
            withDeadline(
              adapter,
              candidate,
              input.request,
              controller.signal,
              budgetMs,
            );
          const response = await traffic.run(
            candidate,
            input.request,
            controller.signal,
            remaining(),
            invoke,
          );
          attempts.push({
            candidate,
            startedAt,
            finishedAt: new Date(now()),
            usage: response.usage,
            errorCategory: null,
          });
          return { response, candidate, attempts };
        } catch (error) {
          const modelError = toModelError(error);
          lastCategory = modelError.category;
          lastMessage = modelError.message;
          attempts.push({
            candidate,
            startedAt,
            finishedAt: new Date(now()),
            usage: null,
            errorCategory: modelError.category,
          });

          if (modelError.category === "canceled")
            throw new ModelRoutingFailedError(
              "canceled",
              attempts,
              lastMessage,
            );
          // Genuine credential problems are non-retryable, but a flaky gateway
          // that intermittently 401s can be opted into bounded retries.
          const authenticationRetryable =
            modelError.category === "authentication_failed" &&
            input.retryPolicy.retryAuthentication;
          if (
            !authenticationRetryable &&
            nonRetryableModelErrorCategories.includes(modelError.category)
          )
            break;
          if (attempt === input.retryPolicy.maxAttemptsPerCandidate) break;

          const delay = Math.min(
            modelError.retryAfterMs ??
              backoffDelayMs(attempt, input.retryPolicy, input.random),
            Math.max(0, remaining()),
          );
          if (remaining() - delay <= 0) {
            break; // 当前账号的等待放不进剩余预算时，直接把机会留给后面的候选项。
          }
          try {
            await sleep(delay, controller.signal);
          } catch (waitError) {
            const category = controller.signal.aborted
              ? "canceled"
              : toModelError(waitError).category;
            throw new ModelRoutingFailedError(
              category,
              attempts,
              "model retry wait ended",
            );
          }
        }
      }
    }

    throw new ModelRoutingFailedError(lastCategory, attempts, lastMessage);
  } finally {
    input.signal?.removeEventListener("abort", abortOuter);
  }
}

async function withDeadline(
  adapter: ModelProviderAdapter,
  candidate: ModelCandidate,
  request: ModelInvocationRequest,
  signal: AbortSignal,
  budgetMs: number,
): Promise<ModelInvocationResponse> {
  const controller = new AbortController();
  let rejectDeadline: (error: ModelInvocationError) => void = () => undefined;
  const ended = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const onAbort = () => {
    controller.abort();
    rejectDeadline(
      new ModelInvocationError("canceled", "model invocation was canceled"),
    );
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort();
    rejectDeadline(
      new ModelInvocationError("timeout", "candidate exceeded deadline"),
    );
  }, budgetMs);
  try {
    if (signal.aborted) onAbort();
    const work = Promise.resolve().then(() => {
      if (controller.signal.aborted)
        throw new ModelInvocationError(
          signal.aborted ? "canceled" : "timeout",
          "candidate was canceled before sending",
        );
      return adapter.invoke(candidate, request, controller.signal);
    });
    return await Promise.race([work, ended]); // 不遵守 signal 的适配器也不能让请求无限挂起。
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted)
      throw new ModelInvocationError("timeout", "candidate exceeded deadline");
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
