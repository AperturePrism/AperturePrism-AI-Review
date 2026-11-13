/**
 * 定时维护：每个维护动作拥有独立周期、取消信号和运行快照。
 *
 * @example
 * const maintenance = createMaintenance({ jobs: [{ name: "retry", intervalMs: 10000, run: () => releaseDueRetries(db) }] });
 * await maintenance.tick();
 * await maintenance.stop();
 *
 * 同一动作最多执行一次；慢速模型整理不会挡住租约回收，也不会在每次定时器
 * 触发时再启动一个整理。这里只保存当前进程的运行状态，不复制业务任务。
 */
export type MaintenanceJob = {
  name: string;
  intervalMs: number;
  run: (signal: AbortSignal) => Promise<unknown>;
  /** 首次启动是否立即运行，默认为 true。 */
  immediately?: boolean;
};
export type MaintenanceSnapshot = {
  name: string;
  running: boolean;
  runs: number;
  successes: number;
  failures: number;
  overlapsPrevented: number;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  lastDurationMs: number | null;
  nextRunAt: number;
  lastError: string | null;
};
export type MaintenanceEvent =
  | { type: "started"; name: string; at: number }
  | {
      type: "completed";
      name: string;
      at: number;
      durationMs: number;
      result: unknown;
    }
  | {
      type: "failed";
      name: string;
      at: number;
      durationMs: number;
      error: unknown;
    }
  | { type: "overlap_prevented"; name: string; at: number };
export type Maintenance = {
  tick: (at?: number) => Promise<void>;
  run: (name: string) => Promise<boolean>;
  snapshot: () => MaintenanceSnapshot[];
  drain: () => Promise<void>;
  stop: () => Promise<void>;
  signal: AbortSignal;
};

/**
 * 创建明确的维护动作表。每次 tick 只启动到期动作；返回时这些动作可能仍在
 * 运行。需要等待结果的测试或优雅退出使用 drain/stop。
 */
export function createMaintenance(options: {
  jobs: readonly MaintenanceJob[];
  now?: () => number;
  onEvent?: (event: MaintenanceEvent) => void;
}): Maintenance {
  const clock = options.now ?? Date.now;
  const controller = new AbortController();
  const jobs = new Map<string, MaintenanceJob>();
  const snapshots = new Map<string, MaintenanceSnapshot>();
  const running = new Map<string, Promise<void>>();
  const startedAt = clock();
  for (const job of options.jobs) {
    if (!job.name.trim() || jobs.has(job.name))
      throw new TypeError(
        `maintenance job name must be unique and nonempty: ${job.name}`,
      );
    if (!Number.isSafeInteger(job.intervalMs) || job.intervalMs < 1)
      throw new RangeError(
        `maintenance interval must be positive: ${job.name}`,
      );
    jobs.set(job.name, job);
    snapshots.set(job.name, {
      name: job.name,
      running: false,
      runs: 0,
      successes: 0,
      failures: 0,
      overlapsPrevented: 0,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastDurationMs: null,
      nextRunAt:
        job.immediately === false ? startedAt + job.intervalMs : startedAt,
      lastError: null,
    });
  }
  const emit = (event: MaintenanceEvent) => {
    // 观测回调不能破坏动作状态或令进程留下一个永不完成的维护 Promise。
    try {
      options.onEvent?.(event);
    } catch {
      /* 观测故障交给调用方自身日志处理。 */
    }
  };
  const run = async (name: string): Promise<boolean> => {
    const job = jobs.get(name);
    if (!job) throw new TypeError(`unknown maintenance job: ${name}`);
    if (controller.signal.aborted) return false;
    const state = snapshots.get(name)!;
    const at = clock();
    if (running.has(name)) {
      state.overlapsPrevented += 1;
      emit({ type: "overlap_prevented", name, at });
      return false;
    }
    state.running = true;
    state.runs += 1;
    state.lastStartedAt = at;
    state.nextRunAt = at + job.intervalMs;
    emit({ type: "started", name, at });
    // Promise.resolve().then 延后实际调用，先登记 running，防止同步重入。
    const promise = Promise.resolve()
      .then(() => job.run(controller.signal))
      .then(
        (result) => {
          const finished = clock();
          state.successes += 1;
          state.lastError = null;
          emit({
            type: "completed",
            name,
            at: finished,
            durationMs: Math.max(0, finished - at),
            result,
          });
        },
        (error: unknown) => {
          const finished = clock();
          state.failures += 1;
          state.lastError =
            error instanceof Error ? error.name : "UnknownError";
          emit({
            type: "failed",
            name,
            at: finished,
            durationMs: Math.max(0, finished - at),
            error,
          });
        },
      )
      .finally(() => {
        state.running = false;
        state.lastFinishedAt = clock();
        state.lastDurationMs = Math.max(0, state.lastFinishedAt - at);
        // 从完成时开始等待下一周期，慢动作不会结束后立刻积压重跑。
        state.nextRunAt = state.lastFinishedAt + job.intervalMs;
        running.delete(name);
      });
    running.set(name, promise);
    return true;
  };
  const drain = async () => {
    await Promise.all(running.values());
  };
  return {
    async tick(at = clock()) {
      if (!Number.isFinite(at))
        throw new RangeError("maintenance tick time must be finite");
      if (controller.signal.aborted) return;
      for (const job of jobs.values()) {
        const state = snapshots.get(job.name)!;
        if (at >= state.nextRunAt) await run(job.name);
      }
    },
    run,
    snapshot: () => [...snapshots.values()].map((state) => ({ ...state })),
    drain,
    async stop() {
      controller.abort();
      await drain();
    },
    signal: controller.signal,
  };
}

/** 可取消等待会主动移除监听器，正常轮询不在 AbortSignal 上累积闭包。 */
export function waitForMaintenance(
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** 运维摘要只暴露错误类型，不把可能带凭据的上游错误消息写进健康快照。 */
export function maintenanceHealth(
  states: readonly MaintenanceSnapshot[],
  now = Date.now(),
): {
  healthy: boolean;
  stalled: string[];
  failing: string[];
  running: string[];
} {
  const stalled = states
    .filter(
      (state) =>
        state.running &&
        state.lastStartedAt !== null &&
        now - state.lastStartedAt >
          Math.max(60_000, (state.nextRunAt - state.lastStartedAt) * 3),
    )
    .map((state) => state.name);
  const failing = states
    .filter((state) => state.lastError !== null)
    .map((state) => state.name);
  return {
    healthy: stalled.length === 0 && failing.length === 0,
    stalled,
    failing,
    running: states.filter((state) => state.running).map((state) => state.name),
  };
}
