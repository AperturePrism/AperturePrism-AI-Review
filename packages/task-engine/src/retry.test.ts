import { describe, expect, it } from "vitest";
import {
  parseRetryAfter,
  parseRetryPolicy,
  planRetry,
  previewRetries,
  retrySample,
} from "./retry.js";
import { loadTaskRuntimePolicy } from "./runtime-policy.js";

const now = new Date("2026-11-13T12:00:00Z");
const request = {
  attempt: 1,
  maxAttempts: 4,
  category: "timeout",
  now,
  key: "task-1",
  policy: { jitterRatio: 0 },
};

describe("task retry plans", () => {
  it("uses exponential backoff capped by the configured maximum", () => {
    expect(planRetry(request)).toMatchObject({
      action: "retry",
      delayMs: 1_000,
      attemptsRemaining: 3,
      nextAttemptAt: new Date(now.getTime() + 1_000),
    });
    expect(planRetry({ ...request, attempt: 2 })).toMatchObject({
      delayMs: 2_000,
    });
    expect(
      planRetry({
        ...request,
        attempt: 30,
        maxAttempts: 50,
        policy: { jitterRatio: 0, maxDelayMs: 10_000 },
      }),
    ).toMatchObject({ delayMs: 10_000 });
  });

  it("stops at the exact attempt boundary", () => {
    expect(planRetry({ ...request, attempt: 4 })).toEqual({
      action: "stop",
      reason: "attempts_exhausted",
      category: "timeout",
      attemptsRemaining: 0,
    });
    expect(planRetry({ ...request, attempt: 5 })).toMatchObject({
      action: "stop",
      attemptsRemaining: 0,
    });
  });

  it.each([
    "authentication_failed",
    "permission_denied",
    "invalid_input",
    "model_not_found",
    "context_overflow",
    "canceled",
  ])("does not automatically retry %s", (category) => {
    expect(planRetry({ ...request, category })).toMatchObject({
      action: "stop",
      reason: "non_retryable",
    });
  });

  it("allows an explicit category policy without silently imposing defaults", () => {
    expect(
      planRetry({
        ...request,
        category: "authentication_failed",
        policy: { stopCategories: [] },
      }),
    ).toMatchObject({ action: "retry" });
  });

  it("honors Retry-After as a minimum even when longer than the exponential cap", () => {
    expect(planRetry({ ...request, retryAfterMs: 900_000 })).toMatchObject({
      reason: "server_delay",
      delayMs: 900_000,
    });
    expect(planRetry({ ...request, retryAfterMs: 20 })).toMatchObject({
      reason: "backoff",
      delayMs: 1_000,
    });
  });

  it("uses a deterministic, bounded jitter per task attempt", () => {
    const jittered = { ...request, policy: { jitterRatio: 0.2 } };
    expect(planRetry(jittered)).toEqual(planRetry(jittered));
    const samples = new Set<number>();
    for (let index = 0; index < 100; index += 1) {
      const result = planRetry({ ...jittered, key: `task-${index}` });
      expect(result.action).toBe("retry");
      if (result.action === "retry") {
        expect(result.delayMs).toBeGreaterThanOrEqual(800);
        expect(result.delayMs).toBeLessThanOrEqual(1_200);
        samples.add(result.delayMs);
      }
    }
    expect(samples.size).toBeGreaterThan(50);
    expect(retrySample("same", 1)).not.toBe(retrySample("same", 2));
  });

  it("does not overflow when a large attempt number is supplied", () => {
    const result = planRetry({
      ...request,
      attempt: 100_000,
      maxAttempts: 100_001,
    });
    expect(result).toMatchObject({ action: "retry", delayMs: 300_000 });
  });

  it("retains an immediate retry policy even at a huge exponential attempt", () => {
    expect(
      planRetry({
        ...request,
        attempt: 100_000,
        maxAttempts: 100_001,
        policy: { baseDelayMs: 0, maxDelayMs: 0 },
      }),
    ).toMatchObject({ action: "retry", delayMs: 0 });
  });

  it("previews an exhausted budget and rejects invalid empty budgets", () => {
    expect(previewRetries({ ...request, fromAttempt: 10 })).toMatchObject([
      { action: "stop", reason: "attempts_exhausted" },
    ]);
    expect(() => previewRetries({ ...request, maxAttempts: 0 })).toThrow();
  });

  it("stops when waiting would exceed the elapsed budget", () => {
    expect(
      planRetry({
        ...request,
        startedAt: new Date(now.getTime() - 500),
        policy: { jitterRatio: 0, maxElapsedMs: 1_000 },
      }),
    ).toMatchObject({ action: "stop", reason: "elapsed_budget" });
    expect(
      planRetry({
        ...request,
        startedAt: now,
        policy: { jitterRatio: 0, maxElapsedMs: 1_000 },
      }),
    ).toMatchObject({ action: "retry" });
  });

  it("previews cumulative backoff using the same decision function", () => {
    const preview = previewRetries({ ...request, maxAttempts: 4 });
    expect(preview).toHaveLength(4);
    expect(preview[0]).toMatchObject({
      nextAttemptAt: new Date(now.getTime() + 1_000),
    });
    expect(preview[1]).toMatchObject({
      nextAttemptAt: new Date(now.getTime() + 3_000),
    });
    expect(preview[2]).toMatchObject({
      nextAttemptAt: new Date(now.getTime() + 7_000),
    });
    expect(preview[3]).toMatchObject({ action: "stop" });
  });

  it.each([
    { attempt: 0 },
    { attempt: -1 },
    { attempt: 1.5 },
    { maxAttempts: 0 },
    { now: new Date("bad") },
    { startedAt: new Date("bad") },
    { retryAfterMs: -1 },
    { retryAfterMs: NaN },
    { category: "   " },
  ])("rejects invalid retry requests %o", (override) => {
    expect(() => planRetry({ ...request, ...override })).toThrow();
  });

  it.each([
    { baseDelayMs: -1 },
    { maxDelayMs: 1 },
    { multiplier: 0.5 },
    { multiplier: Infinity },
    { jitterRatio: -0.1 },
    { jitterRatio: 1.1 },
    { maxElapsedMs: 0 },
    { stopCategories: [""] },
  ])("rejects invalid policies %o", (policy) => {
    expect(() => parseRetryPolicy(policy)).toThrow();
  });

  it("returns independent category arrays", () => {
    const categories = ["timeout", "timeout", " canceled "];
    const policy = parseRetryPolicy({ stopCategories: categories });
    categories.push("later");
    expect(policy.stopCategories).toEqual(["timeout", "canceled"]);
  });
});

describe("HTTP Retry-After", () => {
  it("reads seconds and fractional seconds", () => {
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter(" 0.25 ", now)).toBe(250);
  });
  it("reads HTTP dates and clamps dates in the past", () => {
    expect(parseRetryAfter("Fri, 13 Nov 2026 12:00:05 GMT", now)).toBe(5_000);
    expect(parseRetryAfter("Fri, 13 Nov 2026 11:59:00 GMT", now)).toBe(0);
  });
  it.each([
    null,
    "",
    "   ",
    "-1",
    "not a date",
    "Infinity",
    "999999999999999999999999",
  ])("ignores malformed delay %s", (value) => {
    expect(parseRetryAfter(value, now)).toBeNull();
  });
});

describe("runtime task policies", () => {
  it("leaves original behavior enabled when optional configuration is absent", () => {
    expect(loadTaskRuntimePolicy({})).toEqual({});
    expect(loadTaskRuntimePolicy({ TASK_QUEUE_POLICY_JSON: "   " })).toEqual(
      {},
    );
  });
  it("reads and validates queue and retry policies together", () => {
    expect(
      loadTaskRuntimePolicy({
        TASK_QUEUE_POLICY_JSON: '{"maxActivePerRepository":2}',
        TASK_RETRY_POLICY_JSON: '{"baseDelayMs":2000}',
      }),
    ).toMatchObject({
      queue: { maxActivePerRepository: 2 },
      retry: { baseDelayMs: 2_000 },
    });
  });
  it.each([
    "broken",
    "[]",
    "null",
    '{"maxActivePerRepo":3}',
    '{"maxActiveTotal":-1}',
  ])("rejects queue configuration %s", (value) => {
    expect(() =>
      loadTaskRuntimePolicy({ TASK_QUEUE_POLICY_JSON: value }),
    ).toThrow();
  });
  it("rejects misspelled retry configuration rather than silently ignoring it", () => {
    expect(() =>
      loadTaskRuntimePolicy({ TASK_RETRY_POLICY_JSON: '{"jiterRatio":0.2}' }),
    ).toThrow("unknown field");
  });
});
