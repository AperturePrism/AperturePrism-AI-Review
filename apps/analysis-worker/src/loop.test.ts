import { describe, expect, it, vi } from "vitest";
import type { LeasedTask } from "../../../packages/domain/src/index.js";
import {
  runOnce,
  runWorkerLoop,
  type TaskEngineOperations,
  type WorkerEvent,
} from "./loop.js";

function leasedTask(overrides: Partial<LeasedTask> = {}): LeasedTask {
  return {
    id: "task-1",
    taskType: "issue_analysis",
    status: "leased",
    dedupeKey: "issue-analysis:repo:1:rev:v1",
    leaseOwner: "worker-a",
    leaseExpiresAt: new Date("2026-08-18T00:01:00Z"),
    heartbeatAt: new Date("2026-08-18T00:00:00Z"),
    attemptNumber: 1,
    payload: {
      installationId: "42",
      repositoryFullName: "owner/repo",
      subjectNumber: 7,
      subjectRevision: "rev-1",
    },
    ...overrides,
  };
}

type EngineOverrides = Partial<TaskEngineOperations>;

function engine(overrides: EngineOverrides = {}) {
  const calls: string[] = [];
  const track =
    <T extends unknown[], R>(name: string, fn: (...args: T) => Promise<R>) =>
    (...args: T) => {
      calls.push(name);
      return fn(...args);
    };

  const base: TaskEngineOperations = {
    claim: async () => leasedTask(),
    start: async () => true,
    heartbeat: async () => true,
    beginPublishing: async () => true,
    complete: async () => true,
    fail: async () => null,
  };
  const merged = { ...base, ...overrides };

  return {
    operations: {
      claim: track("claim", merged.claim),
      start: track("start", merged.start),
      heartbeat: track("heartbeat", merged.heartbeat),
      beginPublishing: track("beginPublishing", merged.beginPublishing),
      complete: track("complete", merged.complete),
      fail: track("fail", merged.fail),
    } as TaskEngineOperations,
    calls: () => calls,
  };
}

function collector() {
  const events: WorkerEvent[] = [];
  return { events, onEvent: (event: WorkerEvent) => events.push(event) };
}

const neverAbort = new AbortController().signal;

describe("publication ownership handshake", () => {
  it("advances the lease before an external write and does not advance twice", async () => {
    const order: string[] = [];
    const target = engine({
      beginPublishing: async () => {
        order.push("lease");
        return true;
      },
      complete: async () => {
        order.push("complete");
        return true;
      },
    });
    await runOnce({
      engine: target.operations,
      handler: async (_task, signal, execution) => {
        expect(await execution!.beginPublishing()).toBe(true);
        signal.throwIfAborted();
        order.push("publish");
        expect(await execution!.beginPublishing()).toBe(true);
        return { outcome: "completed" };
      },
      heartbeatIntervalMs: 60_000,
      idleDelayMs: 0,
      shutdownSignal: neverAbort,
    });
    expect(order).toEqual(["lease", "publish", "complete"]);
    expect(
      target.calls().filter((call) => call === "beginPublishing"),
    ).toHaveLength(1);
  });

  it("coalesces simultaneous requests for the same publication lease", async () => {
    const target = engine();
    await runOnce({
      engine: target.operations,
      handler: async (_task, _signal, execution) => {
        expect(
          await Promise.all([
            execution!.beginPublishing(),
            execution!.beginPublishing(),
          ]),
        ).toEqual([true, true]);
        return { outcome: "completed" };
      },
      heartbeatIntervalMs: 60_000,
      idleDelayMs: 0,
      shutdownSignal: neverAbort,
    });
    expect(
      target.calls().filter((call) => call === "beginPublishing"),
    ).toHaveLength(1);
  });

  it("aborts a refused publication lease without publishing, failing, or completing the stale task", async () => {
    const target = engine({ beginPublishing: async () => false });
    const { events, onEvent } = collector();
    let published = false;
    await runOnce({
      engine: target.operations,
      handler: async (_task, signal, execution) => {
        await execution!.beginPublishing();
        signal.throwIfAborted();
        published = true;
        return { outcome: "completed" };
      },
      heartbeatIntervalMs: 60_000,
      idleDelayMs: 0,
      shutdownSignal: neverAbort,
      onEvent,
    });
    expect(published).toBe(false);
    expect(target.calls()).toEqual(["claim", "start", "beginPublishing"]);
    expect(events).toEqual([
      { type: "claimed", taskId: "task-1", attemptNumber: 1 },
      { type: "lease_lost", taskId: "task-1" },
    ]);
  });

  it("does not publish or complete after shutdown races with a successful handler result", async () => {
    const controller = new AbortController();
    const failures: string[] = [];
    const target = engine({
      fail: async (_task, category) => {
        failures.push(category);
        return null;
      },
    });
    await runOnce({
      engine: target.operations,
      handler: async () => {
        controller.abort();
        return { outcome: "completed" };
      },
      heartbeatIntervalMs: 60_000,
      idleDelayMs: 0,
      shutdownSignal: controller.signal,
    });
    expect(target.calls()).not.toContain("beginPublishing");
    expect(target.calls()).not.toContain("complete");
    expect(failures).toEqual(["canceled"]);
  });
});

describe("worker task processing", () => {
  it("walks a successful task through publishing before completing", async () => {
    const target = engine();
    const { events, onEvent } = collector();

    const worked = await runOnce({
      engine: target.operations,
      handler: async () => ({ outcome: "completed" }),
      heartbeatIntervalMs: 60_000,
      idleDelayMs: 0,
      shutdownSignal: neverAbort,
      onEvent,
    });

    expect(worked).toBe(true);
    expect(target.calls()).toEqual([
      "claim",
      "start",
      "beginPublishing",
      "complete",
    ]);
    expect(events).toEqual([
      { type: "claimed", taskId: "task-1", attemptNumber: 1 },
      { type: "completed", taskId: "task-1" },
    ]);
  });

  it("reports idle without touching task state when the queue is empty", async () => {
    const target = engine({ claim: async () => null });
    const { events, onEvent } = collector();

    const worked = await runOnce({
      engine: target.operations,
      handler: async () => ({ outcome: "completed" }),
      heartbeatIntervalMs: 60_000,
      idleDelayMs: 0,
      shutdownSignal: neverAbort,
      onEvent,
    });

    expect(worked).toBe(false);
    expect(target.calls()).toEqual(["claim"]);
    expect(events).toEqual([{ type: "idle" }]);
  });

  it("fails the task with the handler's error category", async () => {
    const failures: string[] = [];
    const target = engine({
      fail: async (_task, category) => {
        failures.push(category);
        return { status: "failed", nextAttemptAt: null };
      },
    });

    await runOnce({
      engine: target.operations,
      handler: async () => ({
        outcome: "failed",
        errorCategory: "invalid_output",
      }),
      heartbeatIntervalMs: 60_000,
      idleDelayMs: 0,
      shutdownSignal: neverAbort,
    });

    expect(failures).toEqual(["invalid_output"]);
    expect(target.calls()).not.toContain("complete");
  });

  it("converts an unexpected handler throw into a failure", async () => {
    const failures: string[] = [];
    const messages: (string | undefined)[] = [];
    const target = engine({
      fail: async (_task, category, message) => {
        failures.push(category);
        messages.push(message);
        return { status: "retry_wait", nextAttemptAt: null };
      },
    });

    await runOnce({
      engine: target.operations,
      handler: async () => {
        throw new Error("boom");
      },
      heartbeatIntervalMs: 60_000,
      idleDelayMs: 0,
      shutdownSignal: neverAbort,
    });

    expect(failures).toEqual(["handler_error"]);
    // 错误文本必须交给任务引擎，否则 task_events 只剩分类码，事后无法排查。
    expect(messages).toEqual(["boom"]);
  });

  it("forwards the failure detail a handler reports", async () => {
    const messages: (string | undefined)[] = [];
    const target = engine({
      fail: async (_task, _category, message) => {
        messages.push(message);
        return { status: "retry_wait", nextAttemptAt: null };
      },
    });

    await runOnce({
      engine: target.operations,
      handler: async () => ({
        outcome: "failed",
        errorCategory: "invalid_output",
        errorMessage: "summary: 缺少必填字段",
      }),
      heartbeatIntervalMs: 60_000,
      idleDelayMs: 0,
      shutdownSignal: neverAbort,
    });

    expect(messages).toEqual(["summary: 缺少必填字段"]);
  });

  it("runs onFinalFailure only when retries are exhausted (issue #103)", async () => {
    const finalized: string[] = [];
    const { onEvent } = collector();

    // 重试未耗尽（retry_wait）：不触发收尾。
    const retrying = engine({
      fail: async () => ({ status: "retry_wait", nextAttemptAt: null }),
    });
    await runOnce({
      engine: retrying.operations,
      handler: async () => ({
        outcome: "failed",
        errorCategory: "handler_error",
      }),
      heartbeatIntervalMs: 60_000,
      idleDelayMs: 0,
      shutdownSignal: neverAbort,
      onEvent,
      onFinalFailure: async (task, category) => {
        finalized.push(`${task.id}:${category}`);
      },
    });
    expect(finalized).toEqual([]);

    // 重试耗尽（failed 终态）：触发收尾。
    const exhausted = engine({
      fail: async () => ({ status: "failed", nextAttemptAt: null }),
    });
    await runOnce({
      engine: exhausted.operations,
      handler: async () => ({
        outcome: "failed",
        errorCategory: "invalid_output",
      }),
      heartbeatIntervalMs: 60_000,
      idleDelayMs: 0,
      shutdownSignal: neverAbort,
      onEvent,
      onFinalFailure: async (task, category) => {
        finalized.push(`${task.id}:${category}`);
      },
    });
    expect(finalized).toEqual(["task-1:invalid_output"]);
  });

  it("swallows onFinalFailure errors so cleanup never masks the failure", async () => {
    const target = engine({
      fail: async () => ({ status: "failed", nextAttemptAt: null }),
    });
    const { events, onEvent } = collector();

    const worked = await runOnce({
      engine: target.operations,
      handler: async () => ({
        outcome: "failed",
        errorCategory: "handler_error",
      }),
      heartbeatIntervalMs: 60_000,
      idleDelayMs: 0,
      shutdownSignal: neverAbort,
      onEvent,
      onFinalFailure: async () => {
        throw new Error("cleanup boom");
      },
    });

    expect(worked).toBe(true);
    expect(events.some((event) => event.type === "failed")).toBe(true);
  });
});

describe("worker lease safety", () => {
  it("stops when the lease was already lost before starting", async () => {
    const target = engine({ start: async () => false });
    const { events, onEvent } = collector();

    await runOnce({
      engine: target.operations,
      handler: async () => ({ outcome: "completed" }),
      heartbeatIntervalMs: 60_000,
      idleDelayMs: 0,
      shutdownSignal: neverAbort,
      onEvent,
    });

    expect(target.calls()).toEqual(["claim", "start"]);
    expect(events.at(-1)).toEqual({ type: "lease_lost", taskId: "task-1" });
  });

  it("does not publish when the lease is lost mid-flight", async () => {
    vi.useFakeTimers();
    try {
      const target = engine({ heartbeat: async () => false });
      const { events, onEvent } = collector();

      const promise = runOnce({
        engine: target.operations,
        handler: (_task, signal) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () =>
              resolve({ outcome: "completed" }),
            );
          }),
        heartbeatIntervalMs: 10,
        idleDelayMs: 0,
        shutdownSignal: neverAbort,
        onEvent,
      });

      await vi.advanceTimersByTimeAsync(15);
      await promise;

      expect(target.calls()).not.toContain("beginPublishing");
      expect(target.calls()).not.toContain("fail");
      expect(events.at(-1)).toEqual({ type: "lease_lost", taskId: "task-1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a lost lease during publishing as lease loss, not completion", async () => {
    const target = engine({ beginPublishing: async () => false });
    const { events, onEvent } = collector();

    await runOnce({
      engine: target.operations,
      handler: async () => ({ outcome: "completed" }),
      heartbeatIntervalMs: 60_000,
      idleDelayMs: 0,
      shutdownSignal: neverAbort,
      onEvent,
    });

    expect(target.calls()).not.toContain("complete");
    expect(events.at(-1)).toEqual({ type: "lease_lost", taskId: "task-1" });
  });
});

describe("worker graceful shutdown", () => {
  it("cancels the in-flight handler and records the cancellation", async () => {
    const controller = new AbortController();
    const failures: string[] = [];
    const target = engine({
      fail: async (_task, category) => {
        failures.push(category);
        return { status: "retry_wait", nextAttemptAt: null };
      },
    });

    const promise = runOnce({
      engine: target.operations,
      handler: (_task, signal) =>
        new Promise((_resolve, reject) => {
          const abort = () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
          // Request shutdown only once the handler is genuinely in flight.
          controller.abort();
        }),
      heartbeatIntervalMs: 60_000,
      idleDelayMs: 0,
      shutdownSignal: controller.signal,
    });

    await promise;

    expect(failures).toEqual(["canceled"]);
    expect(target.calls()).not.toContain("complete");
  });

  it("exits the loop after shutdown and emits a shutdown event", async () => {
    const controller = new AbortController();
    const target = engine({ claim: async () => null });
    const { events, onEvent } = collector();
    let idleWaits = 0;

    await runWorkerLoop({
      engine: target.operations,
      handler: async () => ({ outcome: "completed" }),
      heartbeatIntervalMs: 60_000,
      idleDelayMs: 5,
      shutdownSignal: controller.signal,
      sleep: async () => {
        idleWaits += 1;
        if (idleWaits >= 2) controller.abort();
      },
      onEvent,
    });

    expect(idleWaits).toBe(2);
    expect(events.at(-1)).toEqual({ type: "shutdown" });
  });

  it("settles the canceled attempt before exiting without claiming another task", async () => {
    const controller = new AbortController();
    let claims = 0;
    const target = engine({
      claim: async () => {
        claims += 1;
        return claims === 1 ? leasedTask() : null;
      },
    });

    await runWorkerLoop({
      engine: target.operations,
      handler: async () => {
        controller.abort();
        return { outcome: "completed" };
      },
      heartbeatIntervalMs: 60_000,
      idleDelayMs: 0,
      shutdownSignal: controller.signal,
      sleep: async () => undefined,
    });

    expect(target.calls()).toContain("fail");
    expect(target.calls()).not.toContain("complete");
    expect(claims).toBe(1);
  });
});
