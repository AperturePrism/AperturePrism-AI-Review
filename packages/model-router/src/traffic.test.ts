/** 并发准入与熔断的真实交错测试；时间只在冷却判断中注入。 */
import { describe, expect, it } from "vitest";
import {
  ModelInvocationError,
  type ModelCandidate,
} from "../../domain/src/index.js";
import { ModelTraffic, estimateRequestUsage } from "./traffic.js";
import { ModelBudget } from "./budget.js";

const first: ModelCandidate = {
  provider: "gateway",
  model: "a",
  accountName: "first",
};
const second: ModelCandidate = { ...first, accountName: "second" };
const request = {
  messages: [{ role: "user" as const, content: "hello" }],
  maxOutputTokens: 4,
};
const signal = () => new AbortController().signal;
const response = () => ({
  content: "ok",
  usage: { inputTokens: 2, outputTokens: 1 },
});

describe("model traffic account admission", () => {
  it("limits total concurrency and returns a seat only once", async () => {
    const traffic = new ModelTraffic({ maxConcurrent: 1, maxPerAccount: 1 });
    const seat = await traffic.acquire(first, signal());
    const waiting = traffic.acquire(second, signal());
    expect(traffic.snapshot()).toMatchObject({ running: 1, queued: 1 });
    seat.finish();
    seat.finish();
    const next = await waiting;
    expect(traffic.snapshot()).toMatchObject({ running: 1, queued: 0 });
    next.finish();
    expect(traffic.snapshot()).toMatchObject({ running: 0, queued: 0 });
  });

  it("does not let a busy account block another account with available capacity", async () => {
    const traffic = new ModelTraffic({ maxConcurrent: 2, maxPerAccount: 1 });
    const a1 = await traffic.acquire(first, signal());
    const order: string[] = [];
    const a2 = traffic.acquire(first, signal()).then((seat) => {
      order.push("a2");
      return seat;
    });
    const b1 = await traffic.acquire(second, signal());
    order.push("b1");
    expect(order).toEqual(["b1"]);
    b1.finish();
    expect(traffic.snapshot().queued).toBe(1);
    a1.finish();
    (await a2).finish();
    expect(order).toEqual(["b1", "a2"]);
  });

  it("preserves FIFO order for the same account", async () => {
    const traffic = new ModelTraffic({ maxConcurrent: 1, maxPerAccount: 1 });
    const seat = await traffic.acquire(first, signal());
    const order: number[] = [];
    const waiters = [1, 2, 3].map(async (number) => {
      const admitted = await traffic.acquire(first, signal());
      order.push(number);
      admitted.finish();
    });
    seat.finish();
    await Promise.all(waiters);
    expect(order).toEqual([1, 2, 3]);
  });

  it("shares account capacity across different models on that account", async () => {
    const traffic = new ModelTraffic({ maxConcurrent: 4, maxPerAccount: 1 });
    const one = await traffic.acquire(first, signal());
    const next = traffic.acquire({ ...first, model: "different" }, signal());
    expect(traffic.snapshot()).toMatchObject({ running: 1, queued: 1 });
    one.finish();
    (await next).finish();
  });

  it("does not confuse colon-containing account identities", async () => {
    const traffic = new ModelTraffic({ maxConcurrent: 2, maxPerAccount: 1 });
    const a = await traffic.acquire(
      { provider: "a:b", model: "m", accountName: "c" },
      signal(),
    );
    const b = await traffic.acquire(
      { provider: "a", model: "m", accountName: "b:c" },
      signal(),
    );
    expect(traffic.snapshot().running).toBe(2);
    a.finish();
    b.finish();
  });

  it("removes a canceled waiter without spending or invoking", async () => {
    const traffic = new ModelTraffic({ maxConcurrent: 1 });
    const seat = await traffic.acquire(first, signal());
    const controller = new AbortController();
    const waiting = traffic.acquire(second, controller.signal);
    const rejected = expect(waiting).rejects.toMatchObject({
      category: "canceled",
    });
    controller.abort();
    await rejected;
    expect(traffic.snapshot()).toMatchObject({
      running: 1,
      queued: 0,
      canceled: 1,
    });
    seat.finish();
  });

  it("rejects already canceled work and expired wait budgets", async () => {
    const traffic = new ModelTraffic();
    const controller = new AbortController();
    controller.abort();
    await expect(
      traffic.acquire(first, controller.signal),
    ).rejects.toMatchObject({ category: "canceled" });
    await expect(traffic.acquire(first, signal(), 0)).rejects.toMatchObject({
      category: "timeout",
    });
    expect(traffic.snapshot().running).toBe(0);
  });

  it("bounds queue size and enforces queue timeout", async () => {
    const traffic = new ModelTraffic({
      maxConcurrent: 1,
      maxQueued: 1,
      queueTimeoutMs: 15,
    });
    const seat = await traffic.acquire(first, signal());
    const waiting = traffic.acquire(second, signal());
    const timedOut = expect(waiting).rejects.toMatchObject({
      category: "timeout",
    });
    await expect(traffic.acquire(second, signal())).rejects.toMatchObject({
      category: "rate_limited",
    });
    await timedOut;
    expect(traffic.snapshot().queued).toBe(0);
    seat.finish();
  });

  it("cancels all queued work during shutdown while preserving active ownership", async () => {
    const traffic = new ModelTraffic({ maxConcurrent: 1 });
    const seat = await traffic.acquire(first, signal());
    const a = traffic.acquire(first, signal());
    const b = traffic.acquire(second, signal());
    const checked = Promise.all([
      expect(a).rejects.toMatchObject({ category: "canceled" }),
      expect(b).rejects.toMatchObject({ category: "canceled" }),
    ]);
    expect(traffic.cancelQueued()).toBe(2);
    await checked;
    expect(traffic.snapshot()).toMatchObject({ running: 1, queued: 0 });
    seat.finish();
  });
});

describe("model traffic circuit lifecycle", () => {
  it("opens after repeated provider failures and admits a single recovery probe", async () => {
    let now = 0;
    const traffic = new ModelTraffic({
      now: () => now,
      circuit: { failureThreshold: 2, cooldownMs: 100 },
    });
    (await traffic.acquire(first, signal())).finish("server_error");
    (await traffic.acquire(first, signal())).finish("connection_failed");
    expect(traffic.availability(first)).toMatchObject({
      reason: "circuit_open",
      retryAfterMs: 100,
    });
    await expect(traffic.acquire(first, signal())).rejects.toMatchObject({
      category: "rate_limited",
      retryAfterMs: 100,
    });
    now = 100;
    const probe = await traffic.acquire(first, signal());
    expect(traffic.availability(first).reason).toBe("probe_busy");
    await expect(traffic.acquire(first, signal())).rejects.toMatchObject({
      category: "rate_limited",
    });
    probe.finish();
    expect(traffic.availability(first).available).toBe(true);
    expect(traffic.snapshot().circuits[0]).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
    });
  });

  it("reopens when the single half-open probe fails", async () => {
    let now = 0;
    const traffic = new ModelTraffic({
      now: () => now,
      circuit: { failureThreshold: 1, cooldownMs: 100 },
    });
    (await traffic.acquire(first, signal())).finish("timeout");
    now = 100;
    (await traffic.acquire(first, signal())).finish("server_error");
    expect(traffic.snapshot().circuits[0]).toMatchObject({
      state: "open",
      retryAfterMs: 100,
    });
    now = 200;
    (await traffic.acquire(first, signal())).finish();
    expect(traffic.snapshot().circuits[0]!.state).toBe("closed");
  });

  it("ignores old successes after a newer request has opened the circuit", async () => {
    const traffic = new ModelTraffic({
      maxPerAccount: 3,
      circuit: { failureThreshold: 1 },
    });
    const old = await traffic.acquire(first, signal());
    const newer = await traffic.acquire(first, signal());
    newer.finish("server_error");
    old.finish();
    expect(traffic.availability(first).reason).toBe("circuit_open");
  });

  it("does not count user cancellation, bad inputs or auth errors as provider outages", async () => {
    const traffic = new ModelTraffic({ circuit: { failureThreshold: 1 } });
    for (const category of [
      "canceled",
      "authentication_failed",
      "context_overflow",
      "invalid_output",
      "rate_limited",
    ] as const) {
      (await traffic.acquire(first, signal())).finish(category);
      expect(traffic.availability(first).available).toBe(true);
    }
  });

  it("manual reset prevents late old failures from reopening the cleared generation", async () => {
    const traffic = new ModelTraffic({ circuit: { failureThreshold: 1 } });
    const old = await traffic.acquire(first, signal());
    expect(traffic.resetCircuit(first)).toBe(true);
    old.finish("server_error");
    expect(traffic.availability(first).available).toBe(true);
    expect(traffic.resetCircuit(second)).toBe(false);
  });

  it("bounds candidate memory and removes idle state before admitting new identities", async () => {
    let now = 0;
    const traffic = new ModelTraffic({
      now: () => now,
      maxCandidates: 1,
      circuit: { idleTtlMs: 50 },
    });
    (await traffic.acquire(first, signal())).finish();
    await expect(traffic.acquire(second, signal())).rejects.toMatchObject({
      category: "rate_limited",
    });
    now = 51;
    (await traffic.acquire(second, signal())).finish();
    expect(traffic.snapshot().circuits).toHaveLength(1);
    expect(traffic.snapshot().circuits[0]!.candidate.accountName).toBe(
      "second",
    );
  });
});

describe("model traffic request accounting", () => {
  it("settles successful usage and omits content from bounded telemetry", async () => {
    const budget = new ModelBudget({ maxCostMicros: 100 });
    const traffic = new ModelTraffic({
      budget,
      prices: [
        {
          candidate: first,
          price: {
            currency: "USD",
            inputMicrosPerMillion: 1_000_000,
            outputMicrosPerMillion: 1_000_000,
          },
        },
      ],
      estimateUsage: () => ({ inputTokens: 4, outputTokens: 4 }),
      historyLimit: 1,
    });
    await traffic.run(first, request, signal(), 1_000, async () => response());
    await traffic.run(first, request, signal(), 1_000, async () => response());
    expect(budget.snapshot().spent).toMatchObject({
      costMicros: 6,
      requests: 2,
    });
    expect(traffic.snapshot()).toMatchObject({
      completed: 2,
      running: 0,
      queued: 0,
    });
    expect(traffic.history()).toHaveLength(1);
    expect(JSON.stringify(traffic.history())).not.toContain("hello");
    traffic.history()[0]!.candidate.model = "mutated";
    expect(traffic.history()[0]!.candidate.model).toBe("a");
  });

  it("releases a failed invocation reservation and always returns concurrency", async () => {
    const budget = new ModelBudget({ maxRequests: 1 });
    const traffic = new ModelTraffic({
      budget,
      prices: [
        {
          candidate: first,
          price: {
            currency: "USD",
            inputMicrosPerMillion: 1,
            outputMicrosPerMillion: 1,
          },
        },
      ],
    });
    await expect(
      traffic.run(first, request, signal(), 1_000, async () => {
        throw new ModelInvocationError("server_error", "failure");
      }),
    ).rejects.toThrow("failure");
    expect(budget.snapshot()).toMatchObject({
      reservations: 0,
      spent: { requests: 0 },
    });
    expect(traffic.snapshot()).toMatchObject({ running: 0, failed: 1 });
  });

  it("does not send a request when the configured budget or price rejects it", async () => {
    let sent = false;
    const traffic = new ModelTraffic({
      budget: new ModelBudget({ maxRequests: 0 }),
    });
    await expect(
      traffic.run(first, request, signal(), 1_000, async () => {
        sent = true;
        return response();
      }),
    ).rejects.toMatchObject({ category: "model_not_found" });
    expect(sent).toBe(false);
    expect(traffic.snapshot().running).toBe(0);
  });

  it("deducts actual queue time from the invocation deadline", async () => {
    let now = 0;
    const traffic = new ModelTraffic({ maxConcurrent: 1, now: () => now });
    const seat = await traffic.acquire(first, signal());
    let receivedBudget = 0;
    const run = traffic.run(
      second,
      request,
      signal(),
      100,
      async (remaining) => {
        receivedBudget = remaining;
        return response();
      },
    );
    now = 70;
    seat.finish();
    await run;
    expect(receivedBudget).toBe(30);
  });

  it("estimates tool schemas, multibyte text and images instead of counting only text characters", () => {
    const plain = estimateRequestUsage(request);
    const withImage = estimateRequestUsage({
      ...request,
      messages: [
        {
          role: "user",
          content: "中文",
          imageParts: [
            {
              type: "image_url",
              image_url: { url: "https://example.test/pic.png" },
            },
          ],
        },
      ],
      tools: [{ name: "read", description: "read source" }],
    });
    expect(withImage.inputTokens).toBeGreaterThan(plain.inputTokens + 4_096);
    expect(withImage.outputTokens).toBe(4);
  });
});
