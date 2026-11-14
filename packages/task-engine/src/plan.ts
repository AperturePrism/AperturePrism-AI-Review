/**
 * 执行计划：显式依赖图、失败传播、并发窗口和可重放的执行结果。
 *
 * @example
 * const plan = parseExecutionPlan({ key: "release", steps: [
 *   { key: "index", dependsOn: [], input: { type: "repository_index" } },
 *   { key: "review", dependsOn: ["index"], input: { type: "pr_review" } },
 * ] });
 * const result = await runExecutionPlan(plan, { execute: async (step) => submit(step.input), concurrency: 2 });
 *
 * 计划不隐式发布事件，也不自带第二个任务表。execute 由调用方提供，能直接
 * 调用 createAnalysisTask 或外部 CI；检查点由调用方选择持久化位置。
 */
export type PlanStep<T = unknown> = {
  key: string;
  dependsOn: readonly string[];
  input: T;
  /** continue 允许依赖步骤失败后仍运行，如统一导出失败诊断。 */
  onDependencyFailure?: "skip" | "continue";
};
export type ExecutionPlan<T = unknown> = {
  key: string;
  steps: readonly PlanStep<T>[];
};
export type PlanStepState<T = unknown> = {
  key: string;
  status:
    "pending" | "running" | "completed" | "failed" | "skipped" | "canceled";
  startedAt: string | null;
  finishedAt: string | null;
  value?: T;
  reason?: string;
};
export type PlanCheckpoint<T = unknown> = {
  planKey: string;
  steps: readonly PlanStepState<T>[];
};
export type PlanInspection = {
  order: string[];
  layers: string[][];
  roots: string[];
  leaves: string[];
  longestPath: number;
  edges: number;
};
export type PlanRunResult<T = unknown> = PlanCheckpoint<T> & {
  outcome: "completed" | "failed" | "canceled";
  startedAt: string;
  finishedAt: string;
};

/**
 * 从磁盘或外部运行器恢复前检查状态，不接受未知步骤、重复步骤或未知状态。
 * planKey 应包含调用方自己的计划版本；修改步骤含义时应使用新的 planKey。
 */
export function parsePlanCheckpoint<T>(
  plan: ExecutionPlan,
  checkpoint: PlanCheckpoint<T>,
): PlanCheckpoint<T> {
  if (checkpoint.planKey !== plan.key)
    throw new TypeError("checkpoint belongs to a different plan");
  if (!Array.isArray(checkpoint.steps))
    throw new TypeError("checkpoint steps must be an array");
  const known = new Set(plan.steps.map((step) => step.key));
  const seen = new Set<string>();
  for (const state of checkpoint.steps) {
    if (!known.has(state.key))
      throw new TypeError(`checkpoint contains unknown step ${state.key}`);
    if (seen.has(state.key))
      throw new TypeError(`checkpoint contains duplicate step ${state.key}`);
    seen.add(state.key);
    if (
      ![
        "pending",
        "running",
        "completed",
        "failed",
        "skipped",
        "canceled",
      ].includes(state.status)
    )
      throw new TypeError(
        `checkpoint contains unknown status for step ${state.key}`,
      );
    for (const [name, value] of [
      ["startedAt", state.startedAt],
      ["finishedAt", state.finishedAt],
    ] as const) {
      if (
        value !== null &&
        (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
      )
        throw new TypeError(
          `checkpoint ${name} must be a valid timestamp or null`,
        );
    }
    if (
      state.startedAt &&
      state.finishedAt &&
      Date.parse(state.finishedAt) < Date.parse(state.startedAt)
    )
      throw new TypeError(
        `checkpoint finish precedes start for step ${state.key}`,
      );
  }
  return structuredClone(checkpoint);
}

/** 验证图边界并复制数组，运行中的计划不会被调用方意外改写依赖。 */
export function parseExecutionPlan<T>(
  input: ExecutionPlan<T>,
): ExecutionPlan<T> {
  const key = input.key.trim();
  if (!key || key.length > 200)
    throw new TypeError("plan key must contain 1 to 200 characters");
  if (
    !Array.isArray(input.steps) ||
    input.steps.length < 1 ||
    input.steps.length > 5_000
  )
    throw new RangeError("plan must contain 1 to 5000 steps");
  const keys = new Set<string>();
  const steps = input.steps.map((step) => {
    const stepKey = step.key.trim();
    if (!stepKey || stepKey.length > 200)
      throw new TypeError("step key must contain 1 to 200 characters");
    if (keys.has(stepKey))
      throw new TypeError(`duplicate plan step: ${stepKey}`);
    keys.add(stepKey);
    if (
      !Array.isArray(step.dependsOn) ||
      step.dependsOn.some(
        (dependency: unknown) =>
          typeof dependency !== "string" || !dependency.trim(),
      )
    )
      throw new TypeError(`dependsOn must contain step keys: ${stepKey}`);
    if (
      step.onDependencyFailure !== undefined &&
      !["skip", "continue"].includes(step.onDependencyFailure)
    )
      throw new TypeError(`unknown dependency failure policy: ${stepKey}`);
    return {
      ...step,
      key: stepKey,
      dependsOn: [
        ...new Set(
          step.dependsOn.map((dependency: string) => dependency.trim()),
        ),
      ],
    };
  });
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!keys.has(dependency))
        throw new TypeError(
          `unknown dependency ${dependency} for step ${step.key}`,
        );
      if (dependency === step.key)
        throw new TypeError(`step ${step.key} cannot depend on itself`);
    }
  }
  const plan = { key, steps };
  inspectExecutionPlan(plan); // 拓扑排序同时验证图中没有环。
  return plan;
}

/** 拓扑分层使用迭代算法，五千个步骤的长链也不会耗尽 JavaScript 调用栈。 */
export function inspectExecutionPlan<T>(
  plan: ExecutionPlan<T>,
): PlanInspection {
  const indegree = new Map(
    plan.steps.map((step) => [step.key, step.dependsOn.length]),
  );
  const dependents = new Map<string, string[]>();
  for (const step of plan.steps)
    for (const dependency of step.dependsOn) {
      const children = dependents.get(dependency) ?? [];
      children.push(step.key);
      dependents.set(dependency, children);
    }
  const order: string[] = [];
  const layers: string[][] = [];
  let ready = plan.steps
    .filter((step) => step.dependsOn.length === 0)
    .map((step) => step.key);
  const roots = [...ready];
  while (ready.length) {
    layers.push(ready);
    const next: string[] = [];
    for (const key of ready) {
      order.push(key);
      for (const child of dependents.get(key) ?? []) {
        const count = indegree.get(child)! - 1;
        indegree.set(child, count);
        if (count === 0) next.push(child);
      }
    }
    ready = next;
  }
  if (order.length !== plan.steps.length) {
    const cycle = plan.steps
      .filter((step) => !order.includes(step.key))
      .map((step) => step.key);
    throw new TypeError(
      `execution plan contains a dependency cycle: ${cycle.slice(0, 20).join(", ")}`,
    );
  }
  return {
    order,
    layers,
    roots,
    leaves: plan.steps
      .filter((step) => !dependents.has(step.key))
      .map((step) => step.key),
    longestPath: layers.length,
    edges: plan.steps.reduce((total, step) => total + step.dependsOn.length, 0),
  };
}

/** 计算在当前检查点下能运行的步骤；只接受依赖已进入终态的步骤。 */
export function readyPlanSteps<T>(
  plan: ExecutionPlan<T>,
  states: readonly PlanStepState[],
  limit = plan.steps.length,
): PlanStep<T>[] {
  const byKey = new Map(states.map((state) => [state.key, state]));
  return plan.steps
    .filter((step) => {
      const status = byKey.get(step.key)?.status ?? "pending";
      if (status !== "pending") return false;
      return step.dependsOn.every((key) => {
        const dependency = byKey.get(key)?.status;
        return (
          dependency === "completed" ||
          (step.onDependencyFailure === "continue" &&
            ["failed", "skipped", "canceled"].includes(dependency ?? "pending"))
        );
      });
    })
    .slice(0, limit);
}

/** 返回下游影响集合，运维界面可在重跑前显示会重新执行哪些步骤。 */
export function affectedPlanSteps<T>(
  plan: ExecutionPlan<T>,
  changed: readonly string[],
): string[] {
  const known = new Set(plan.steps.map((step) => step.key));
  if (changed.some((key) => !known.has(key)))
    throw new TypeError("changed steps must belong to the plan");
  const affected = new Set(changed);
  const order = inspectExecutionPlan(plan).order;
  const steps = new Map(plan.steps.map((step) => [step.key, step]));
  for (const key of order) {
    if (
      steps.get(key)!.dependsOn.some((dependency) => affected.has(dependency))
    )
      affected.add(key);
  }
  return order.filter((key) => affected.has(key));
}

/** 重跑影响范围内的步骤，范围外已完成结果保持原样，避免重复外部副作用。 */
export function restartPlan<T>(
  plan: ExecutionPlan,
  checkpoint: PlanCheckpoint<T>,
  from: readonly string[],
): PlanCheckpoint<T> {
  parsePlanCheckpoint(plan, checkpoint);
  const affected = new Set(affectedPlanSteps(plan, from));
  const previous = new Map(checkpoint.steps.map((step) => [step.key, step]));
  return {
    planKey: plan.key,
    steps: plan.steps.map((step) =>
      affected.has(step.key)
        ? {
            key: step.key,
            status: "pending",
            startedAt: null,
            finishedAt: null,
          }
        : structuredClone(
            previous.get(step.key) ?? {
              key: step.key,
              status: "pending",
              startedAt: null,
              finishedAt: null,
            },
          ),
    ),
  };
}

export type PlanRunOptions<T, R> = {
  execute: (
    step: PlanStep<T>,
    dependencies: ReadonlyMap<string, R>,
    signal: AbortSignal,
  ) => Promise<R>;
  concurrency?: number;
  signal?: AbortSignal;
  checkpoint?: PlanCheckpoint<R>;
  /** 每次状态变更后持久保存；保存失败终止计划，不能静默丢失幂等边界。 */
  save?: (checkpoint: PlanCheckpoint<R>) => Promise<void>;
  now?: () => Date;
  stopOnFailure?: boolean;
};

/**
 * 执行依赖图。已完成检查点不再运行；上次停在 running 的步骤回到 pending，
 * 调用方 execute 必须使用 step.key 作为幂等键保护跨进程崩溃后的副作用。
 */
export async function runExecutionPlan<T, R>(
  input: ExecutionPlan<T>,
  options: PlanRunOptions<T, R>,
): Promise<PlanRunResult<R>> {
  const plan = parseExecutionPlan(input);
  const concurrency = options.concurrency ?? 4;
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 100
  )
    throw new RangeError("concurrency must be between 1 and 100");
  if (options.checkpoint) parsePlanCheckpoint(plan, options.checkpoint);
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const previous = new Map(
    options.checkpoint?.steps.map((step) => [step.key, step]),
  );
  const states = new Map<string, PlanStepState<R>>(
    plan.steps.map((step) => {
      const saved = previous.get(step.key);
      return [
        step.key,
        saved && saved.status !== "running"
          ? structuredClone(saved)
          : {
              key: step.key,
              status: "pending",
              startedAt: null,
              finishedAt: null,
            },
      ];
    }),
  );
  const snapshot = (): PlanCheckpoint<R> => ({
    planKey: plan.key,
    steps: structuredClone([...states.values()]),
  });
  let saveChain = Promise.resolve();
  const save = async () => {
    const value = snapshot();
    saveChain = saveChain.then(() => options.save?.(value));
    await saveChain;
  };
  const running = new Map<string, Promise<void>>();
  let failureSeen = false;
  const execute = async (step: PlanStep<T>) => {
    const state = states.get(step.key)!;
    state.status = "running";
    state.startedAt = now().toISOString();
    await save();
    try {
      signal.throwIfAborted();
      const dependencies = new Map<string, R>();
      for (const dependency of step.dependsOn) {
        const prior = states.get(dependency)!;
        if (prior.status === "completed")
          dependencies.set(dependency, prior.value as R);
      }
      state.value = await options.execute(step, dependencies, signal);
      state.status = "completed";
    } catch (error) {
      state.status = signal.aborted ? "canceled" : "failed";
      state.reason =
        error instanceof Error ? error.message.slice(0, 500) : "step failed";
      failureSeen = true;
      if (options.stopOnFailure) controller.abort(error);
    }
    state.finishedAt = now().toISOString();
    await save();
  };

  while (true) {
    let changed = false;
    for (const step of plan.steps) {
      const state = states.get(step.key)!;
      if (state.status !== "pending") continue;
      if (signal.aborted) {
        state.status = "canceled";
        state.reason = "plan canceled";
        state.finishedAt = now().toISOString();
        changed = true;
        continue;
      }
      if (step.onDependencyFailure === "continue") continue;
      const failed = step.dependsOn.find((key) =>
        ["failed", "skipped", "canceled"].includes(states.get(key)!.status),
      );
      if (failed) {
        state.status = "skipped";
        state.reason = `dependency ${failed} did not complete`;
        state.finishedAt = now().toISOString();
        changed = true;
      }
    }
    if (changed) await save();
    const ready = signal.aborted
      ? []
      : readyPlanSteps(plan, [...states.values()], concurrency - running.size);
    for (const step of ready) {
      const promise = execute(step).finally(() => {
        running.delete(step.key);
      });
      running.set(step.key, promise);
    }
    if (!running.size) {
      if (
        changed &&
        [...states.values()].some((state) => state.status === "pending")
      )
        continue;
      break;
    }
    try {
      await Promise.race(running.values());
    } catch (error) {
      controller.abort(error);
      await Promise.allSettled(running.values());
      throw error; // 保存故障由入口统一处理，不能伪装成普通步骤失败。
    }
  }
  const final = snapshot();
  const failed =
    failureSeen ||
    final.steps.some((step) => ["failed", "skipped"].includes(step.status));
  return {
    ...final,
    outcome: options.signal?.aborted
      ? "canceled"
      : failed
        ? "failed"
        : "completed",
    startedAt,
    finishedAt: now().toISOString(),
  };
}
