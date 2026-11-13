/** 从原路由入口验证默认限流、真正截止时间、缓存与回退。 */
import { describe, expect, it } from "vitest";
import {
  ModelInvocationError,
  type ModelCandidate,
  type ModelProviderAdapter,
} from "../../domain/src/index.js";
import {
  ModelResponseCache,
  ModelRoutingFailedError,
  configureModelTraffic,
  getModelTraffic,
  routeModelInvocation,
  orderCandidates,
  candidateKey,
} from "./index.js";

const candidate: ModelCandidate = {
  provider: "a",
  model: "m",
  accountName: "one",
};
const input = {
  candidates: [candidate],
  request: { messages: [{ role: "user" as const, content: "analyze" }] },
  deadlineMs: 1_000,
  retryPolicy: { maxAttemptsPerCandidate: 1, baseDelayMs: 0, maxDelayMs: 0 },
};
const response = { content: "ok", usage: { inputTokens: 5, outputTokens: 2 } };

describe("router reliability integration", () => {
  it("keeps sticky routing unambiguous when model or account names contain colons", () => {
    const first = { provider: "p", model: "a:b", accountName: "c" };
    const second = { provider: "p", model: "a", accountName: "b:c" };
    expect(candidateKey(first)).not.toBe(candidateKey(second));
    expect(orderCandidates([first, second], second)).toEqual([second, first]);
  });
  it("uses shared traffic by adapter set without requiring worker changes", async () => {
    let active = 0;
    let maxActive = 0;
    const adapter: ModelProviderAdapter = {
      provider: "a",
      invoke: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return response;
      },
    };
    const adapters = new Map([["a", adapter]]);
    configureModelTraffic(adapters, { maxConcurrent: 1, maxPerAccount: 1 });
    await Promise.all([
      routeModelInvocation(adapters, input),
      routeModelInvocation(adapters, input),
    ]);
    expect(maxActive).toBe(1);
    expect(getModelTraffic(adapters).snapshot().completed).toBe(2);
  });

  it("rejects zero remaining deadline as a routing timeout without invoking an adapter", async () => {
    let called = false;
    const adapter: ModelProviderAdapter = {
      provider: "a",
      invoke: async () => {
        called = true;
        return response;
      },
    };
    await expect(
      routeModelInvocation(new Map([["a", adapter]]), {
        ...input,
        deadlineMs: 0,
      }),
    ).rejects.toMatchObject({ lastCategory: "timeout", attempts: [] });
    expect(called).toBe(false);
  });

  it("enforces deadlines even when a custom provider never observes AbortSignal", async () => {
    const adapter: ModelProviderAdapter = {
      provider: "a",
      invoke: () => new Promise(() => undefined),
    };
    await expect(
      routeModelInvocation(new Map([["a", adapter]]), {
        ...input,
        deadlineMs: 15,
      }),
    ).rejects.toMatchObject({ lastCategory: "timeout" });
  });

  it("normalizes cancellation during retry backoff to a routing error", async () => {
    const controller = new AbortController();
    const adapter: ModelProviderAdapter = {
      provider: "a",
      invoke: async () => {
        throw new ModelInvocationError("server_error", "503");
      },
    };
    const route = routeModelInvocation(new Map([["a", adapter]]), {
      ...input,
      signal: controller.signal,
      retryPolicy: {
        maxAttemptsPerCandidate: 2,
        baseDelayMs: 100,
        maxDelayMs: 100,
      },
      sleep: async () => {
        controller.abort();
        throw new ModelInvocationError("canceled", "canceled wait");
      },
    });
    await expect(route).rejects.toBeInstanceOf(ModelRoutingFailedError);
    await expect(route).rejects.toMatchObject({ lastCategory: "canceled" });
  });

  it("tries a fallback when the first provider's Retry-After cannot fit the deadline", async () => {
    const fallback: ModelCandidate = { ...candidate, provider: "b" };
    const a: ModelProviderAdapter = {
      provider: "a",
      invoke: async () => {
        throw new ModelInvocationError("rate_limited", "429", 30_000);
      },
    };
    const b: ModelProviderAdapter = {
      provider: "b",
      invoke: async () => response,
    };
    const result = await routeModelInvocation(
      new Map([
        ["a", a],
        ["b", b],
      ]),
      {
        ...input,
        candidates: [candidate, fallback],
        retryPolicy: {
          maxAttemptsPerCandidate: 2,
          baseDelayMs: 10,
          maxDelayMs: 100,
        },
      },
    );
    expect(result.candidate.provider).toBe("b");
    expect(result.attempts).toHaveLength(2);
  });

  it("returns zero newly billed usage and no fake attempts on a cache hit", async () => {
    let calls = 0;
    const adapter: ModelProviderAdapter = {
      provider: "a",
      invoke: async () => {
        calls += 1;
        return response;
      },
    };
    const adapters = new Map([["a", adapter]]);
    const cachedInput = {
      ...input,
      cache: new ModelResponseCache(),
      cacheScope: "tenant:policy",
    };
    const first = await routeModelInvocation(adapters, cachedInput);
    const second = await routeModelInvocation(adapters, cachedInput);
    expect(first.response.usage).toEqual(response.usage);
    expect(second.response.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(second.cache).toEqual({
      status: "hit",
      reusedUsage: response.usage,
    });
    expect(second.attempts).toEqual([]);
    expect(calls).toBe(1);
  });

  it("prevents cache use without an explicit isolation scope", async () => {
    await expect(
      routeModelInvocation(new Map(), {
        ...input,
        cache: new ModelResponseCache(),
      }),
    ).rejects.toThrow("cacheScope");
  });

  it("refuses quota replacement while a request holds a seat", async () => {
    const adapters = new Map<string, ModelProviderAdapter>();
    const traffic = getModelTraffic(adapters);
    const seat = await traffic.acquire(candidate, new AbortController().signal);
    expect(() => configureModelTraffic(adapters, { maxConcurrent: 1 })).toThrow(
      "active",
    );
    seat.finish();
    expect(configureModelTraffic(adapters, { maxConcurrent: 1 })).not.toBe(
      traffic,
    );
  });
});
