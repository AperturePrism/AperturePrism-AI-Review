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

export * from "./openai-compatible.js";

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
  return `${candidate.provider}:${candidate.model}:${candidate.accountName}`;
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

export function backoffDelayMs(attempt: number, policy: RetryPolicy): number {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(exponential, policy.maxDelayMs);
}

function toModelError(error: unknown): ModelInvocationError {
  if (error instanceof ModelInvocationError) return error;
  if (error instanceof Error && error.name === "AbortError")
    return new ModelInvocationError("canceled", "invocation was canceled");
  return new ModelInvocationError(
    "unknown",
    error instanceof Error ? error.message : "unknown provider failure",
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
): Promise<ModelRoutingResult> {
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
          const response = await withDeadline(
            adapter,
            candidate,
            input.request,
            controller.signal,
            remaining(),
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
              backoffDelayMs(attempt, input.retryPolicy),
            Math.max(0, remaining()),
          );
          if (remaining() - delay <= 0) {
            lastCategory = "timeout";
            throw new ModelRoutingFailedError(
              lastCategory,
              attempts,
              lastMessage,
            );
          }
          try {
            await sleep(delay, controller.signal);
          } catch (error) {
            if (controller.signal.aborted)
              throw new ModelRoutingFailedError(
                "canceled",
                attempts,
                lastMessage,
              );
            throw error;
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
  if (signal.aborted)
    throw new ModelInvocationError("canceled", "invocation was canceled");
  const controller = new AbortController();
  let onAbort: () => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(new ModelInvocationError("canceled", "invocation was canceled"));
      controller.abort();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      reject(
        new ModelInvocationError("timeout", "candidate exceeded deadline"),
      );
      controller.abort();
    }, budgetMs);
  });
  try {
    // Adapters are asked to abort their transport, but routing must also settle
    // if a provider ignores the signal or hangs while resolving credentials.
    return await Promise.race([
      adapter.invoke(candidate, request, controller.signal),
      interrupted,
    ]);
  } catch (error) {
    if (signal.aborted)
      throw new ModelInvocationError("canceled", "invocation was canceled");
    if (controller.signal.aborted)
      throw new ModelInvocationError("timeout", "candidate exceeded deadline");
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
