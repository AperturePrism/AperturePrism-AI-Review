import type { LeasedTask } from "../../../packages/domain/src/index.js";

export type WorkerTaskOutcome =
  | { outcome: "completed" }
  | {
      outcome: "failed";
      errorCategory: string;
      /** 可选的失败细节（如契约校验失败的字段），会写入 task_events。 */
      errorMessage?: string;
    };

/**
 * Everything the loop needs from the task engine. Keeping these as injected
 * operations means the loop never issues its own UPDATE against a task.
 */
export type TaskEngineOperations = {
  claim: () => Promise<LeasedTask | null>;
  start: (task: LeasedTask) => Promise<boolean>;
  heartbeat: (task: LeasedTask) => Promise<boolean>;
  beginPublishing: (task: LeasedTask) => Promise<boolean>;
  complete: (task: LeasedTask) => Promise<boolean>;
  fail: (
    task: LeasedTask,
    errorCategory: string,
    errorMessage?: string,
  ) => Promise<FailOutcome | null>;
};

/** failTask 的结果：status=failed 表示重试已耗尽，任务进入终态。 */
export type FailOutcome = {
  status: "failed" | "retry_wait";
  nextAttemptAt: Date | null;
};

/** 当前尝试在真正发布前向队列确认所有权；由循环提供，业务不能伪造租约。 */
export type TaskExecution = {
  beginPublishing: () => Promise<boolean>;
};

export type TaskHandler = (
  task: LeasedTask,
  signal: AbortSignal,
  execution?: TaskExecution,
) => Promise<WorkerTaskOutcome>;

export type WorkerLoopOptions = {
  engine: TaskEngineOperations;
  handler: TaskHandler;
  /** Interval between heartbeats while a task is executing. */
  heartbeatIntervalMs: number;
  /** Delay before polling again when the queue is empty. */
  idleDelayMs: number;
  shutdownSignal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onEvent?: (event: WorkerEvent) => void;
  /**
   * Called when an attempt failure drives the task into its terminal "failed"
   * state (retries exhausted; issues #103). External side effects that must not
   * outlive a dead task — e.g. finalizing a PR Check Run stuck at
   * "in_progress" — belong here. Best-effort by contract: the loop swallows
   * callback errors so cleanup can never mask the failure itself.
   */
  onFinalFailure?: (
    task: LeasedTask,
    errorCategory: string,
    errorMessage?: string,
  ) => Promise<void>;
};

export type WorkerEvent =
  | { type: "claimed"; taskId: string; attemptNumber: number }
  | { type: "idle" }
  | { type: "completed"; taskId: string }
  | { type: "failed"; taskId: string; errorCategory: string; error?: string }
  | { type: "lease_lost"; taskId: string }
  | { type: "shutdown" };

/**
 * Renders an error into a short, safe-to-log string. Provider bodies can be
 * huge and occasionally embed credentials, so only the message is kept and it
 * is truncated.
 */
function describeError(error: unknown): string | undefined {
  if (error instanceof Error) {
    const message = error.message || error.name;
    return message.length > 500 ? `${message.slice(0, 500)}…` : message;
  }
  const text = String(error);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

/**
 * issue #103：任务重试耗尽进入终态 failed 时触发的收尾钩子。钩子自身的异常
 * 一律吞掉——收尾失败不能掩盖真正的任务失败，也不该影响循环继续运转。
 */
async function notifyFinalFailure(
  options: WorkerLoopOptions,
  task: LeasedTask,
  errorCategory: string,
  failOutcome: FailOutcome | null,
  errorMessage?: string,
): Promise<void> {
  if (!options.onFinalFailure || failOutcome?.status !== "failed") return;
  // 吞掉钩子异常：收尾是 best-effort，失败不能掩盖任务本身的失败结果。
  try {
    await options.onFinalFailure(task, errorCategory, errorMessage);
  } catch {
    // best-effort cleanup only
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Keeps the lease alive while the handler runs. A lost lease aborts the work
 * so two workers never publish for the same attempt.
 */
function startHeartbeat(
  engine: TaskEngineOperations,
  task: LeasedTask,
  intervalMs: number,
  onLost: () => void,
): () => void {
  const timer = setInterval(() => {
    void engine
      .heartbeat(task)
      .then((held) => {
        if (!held) onLost();
      })
      .catch(() => onLost());
  }, intervalMs);
  return () => clearInterval(timer);
}

/**
 * Processes one claimed task through the engine's state machine. Returns false
 * when the queue was empty so the caller can back off.
 */
export async function runOnce(options: WorkerLoopOptions): Promise<boolean> {
  const { engine, handler, shutdownSignal, onEvent } = options;
  const task = await engine.claim();
  if (!task) {
    onEvent?.({ type: "idle" });
    return false;
  }
  onEvent?.({
    type: "claimed",
    taskId: task.id,
    attemptNumber: task.attemptNumber,
  });

  if (!(await engine.start(task))) {
    onEvent?.({ type: "lease_lost", taskId: task.id });
    return true;
  }

  const controller = new AbortController();
  const abortForShutdown = () => controller.abort();
  if (shutdownSignal.aborted) controller.abort();
  shutdownSignal.addEventListener("abort", abortForShutdown, { once: true });
  let leaseLost = false;
  let publicationStarted = false;
  let publicationPending: Promise<boolean> | null = null;
  const stopHeartbeat = startHeartbeat(
    engine,
    task,
    options.heartbeatIntervalMs,
    () => {
      leaseLost = true;
      controller.abort();
    },
  );
  const execution: TaskExecution = {
    async beginPublishing() {
      if (controller.signal.aborted) return false;
      if (publicationStarted) return true;
      // 同一个尝试可能有多个发布入口；并行调用也只推进一次数据库状态。
      publicationPending ??= engine.beginPublishing(task).then((held) => {
        if (held) publicationStarted = true;
        else {
          leaseLost = true;
          controller.abort();
        }
        return held;
      });
      return publicationPending;
    },
  };

  try {
    controller.signal.throwIfAborted();
    const result = await handler(task, controller.signal, execution);
    if (leaseLost) {
      onEvent?.({ type: "lease_lost", taskId: task.id });
      return true;
    }
    controller.signal.throwIfAborted();

    if (result.outcome === "failed") {
      const failOutcome = await engine.fail(
        task,
        result.errorCategory,
        result.errorMessage,
      );
      await notifyFinalFailure(
        options,
        task,
        result.errorCategory,
        failOutcome,
        result.errorMessage,
      );
      onEvent?.({
        type: "failed",
        taskId: task.id,
        errorCategory: result.errorCategory,
        ...(result.errorMessage === undefined
          ? {}
          : { error: result.errorMessage }),
      });
      return true;
    }

    controller.signal.throwIfAborted();
    // 旧的纯计算 handler 没有发布副作用，仍兼容它们在返回后推进状态。
    if (!publicationStarted && !(await execution.beginPublishing())) {
      onEvent?.({ type: "lease_lost", taskId: task.id });
      return true;
    }
    if (!(await engine.complete(task))) {
      onEvent?.({ type: "lease_lost", taskId: task.id });
      return true;
    }
    onEvent?.({ type: "completed", taskId: task.id });
    return true;
  } catch (error) {
    if (leaseLost) {
      onEvent?.({ type: "lease_lost", taskId: task.id });
      return true; // 原尝试已不拥有任务，不能再记失败或触发失败收尾。
    }
    const errorCategory =
      controller.signal.aborted && !leaseLost
        ? "canceled"
        : error instanceof Error && error.name === "AbortError"
          ? "canceled"
          : "handler_error";
    const errorText = describeError(error);
    // 错误文本必须一并交给任务引擎：否则它只存在于进程日志里，
    // task_events 只剩分类码，事后无法判断失败原因。
    if (!leaseLost) {
      const failOutcome = await engine.fail(task, errorCategory, errorText);
      await notifyFinalFailure(
        options,
        task,
        errorCategory,
        failOutcome,
        errorText,
      );
    }
    onEvent?.({
      type: "failed",
      taskId: task.id,
      errorCategory,
      ...(errorText === undefined ? {} : { error: errorText }),
    });
    return true;
  } finally {
    stopHeartbeat();
    shutdownSignal.removeEventListener("abort", abortForShutdown);
  }
}

/**
 * Runs until shutdown is requested. The in-flight task is always finished or
 * explicitly failed before returning, so no attempt is left dangling.
 */
export async function runWorkerLoop(options: WorkerLoopOptions): Promise<void> {
  const sleep = options.sleep ?? delay;
  while (!options.shutdownSignal.aborted) {
    const worked = await runOnce(options);
    if (!worked && !options.shutdownSignal.aborted)
      await sleep(options.idleDelayMs, options.shutdownSignal);
  }
  options.onEvent?.({ type: "shutdown" });
}
