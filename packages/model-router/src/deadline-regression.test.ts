import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ModelInvocationError,
  type ModelCandidate,
  type ModelProviderAdapter,
} from "../../domain/src/index.js";
import { routeModelInvocation } from "./index.js";

const candidate: ModelCandidate = {
  provider: "test",
  model: "test",
  accountName: "test",
};
const policy = {
  maxAttemptsPerCandidate: 2,
  baseDelayMs: 100,
  maxDelayMs: 100,
};
function route(adapter: ModelProviderAdapter, signal?: AbortSignal) {
  return routeModelInvocation(new Map([["test", adapter]]), {
    candidates: [candidate],
    request: { messages: [] },
    deadlineMs: 500,
    retryPolicy: policy,
    ...(signal ? { signal } : {}),
  });
}
afterEach(() => vi.useRealTimers());

describe("router hard deadline and cancellation", () => {
  it("settles at the shared deadline when an adapter ignores cancellation", async () => {
    vi.useFakeTimers();
    const invoke = vi.fn<ModelProviderAdapter["invoke"]>(
      () => new Promise<never>(() => {}),
    );
    const promise = route({ provider: "test", invoke });
    const assertion = expect(promise).rejects.toMatchObject({
      name: "ModelRoutingFailedError",
      lastCategory: "timeout",
    });
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[2].aborted).toBe(true);
  });

  it("settles caller cancellation even when the adapter ignores its signal", async () => {
    const controller = new AbortController();
    const promise = route(
      { provider: "test", invoke: () => new Promise<never>(() => {}) },
      controller.signal,
    );
    const assertion = expect(promise).rejects.toMatchObject({
      lastCategory: "canceled",
    });
    controller.abort();
    await assertion;
  });

  it("preserves routing error and attempts when canceled during retry backoff", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const invoke = vi.fn(async () => {
      throw new ModelInvocationError("server_error", "503");
    });
    const promise = route({ provider: "test", invoke }, controller.signal);
    const assertion = expect(promise).rejects.toMatchObject({
      name: "ModelRoutingFailedError",
      lastCategory: "canceled",
      attempts: [expect.objectContaining({ errorCategory: "server_error" })],
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await assertion;
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
