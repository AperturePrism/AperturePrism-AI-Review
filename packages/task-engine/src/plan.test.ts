import { describe, expect, it, vi } from "vitest";
import {
  affectedPlanSteps,
  inspectExecutionPlan,
  parseExecutionPlan,
  parsePlanCheckpoint,
  readyPlanSteps,
  restartPlan,
  runExecutionPlan,
  type ExecutionPlan,
  type PlanCheckpoint,
} from "./plan.js";

const plan: ExecutionPlan<number> = {
  key: "release",
  steps: [
    { key: "index", dependsOn: [], input: 1 },
    { key: "review-a", dependsOn: ["index"], input: 2 },
    { key: "review-b", dependsOn: ["index"], input: 3 },
    { key: "report", dependsOn: ["review-a", "review-b"], input: 4 },
  ],
};
const pending = (key: string) => ({
  key,
  status: "pending" as const,
  startedAt: null,
  finishedAt: null,
});
const completed = (key: string, value = 10) => ({
  key,
  status: "completed" as const,
  startedAt: "2026-11-13T00:00:00Z",
  finishedAt: "2026-11-13T00:00:01Z",
  value,
});

describe("execution plan boundaries", () => {
  it("reports roots, leaves, layers and the longest dependency path", () => {
    expect(inspectExecutionPlan(plan)).toEqual({
      order: ["index", "review-a", "review-b", "report"],
      layers: [["index"], ["review-a", "review-b"], ["report"]],
      roots: ["index"],
      leaves: ["report"],
      longestPath: 3,
      edges: 4,
    });
  });
  it("normalizes keys and deduplicates dependency edges", () => {
    const parsed = parseExecutionPlan({
      key: " p ",
      steps: [
        { key: " a ", dependsOn: [], input: 1 },
        { key: " b ", dependsOn: ["a", " a "], input: 2 },
      ],
    });
    expect(parsed).toMatchObject({
      key: "p",
      steps: [
        { key: "a", dependsOn: [] },
        { key: "b", dependsOn: ["a"] },
      ],
    });
  });
  it.each([
    { key: "", steps: plan.steps },
    { key: "empty", steps: [] },
    { key: "duplicate", steps: [plan.steps[0]!, plan.steps[0]!] },
    { key: "missing", steps: [{ key: "a", dependsOn: ["missing"], input: 1 }] },
    { key: "self", steps: [{ key: "a", dependsOn: ["a"], input: 1 }] },
    {
      key: "cycle",
      steps: [
        { key: "a", dependsOn: ["b"], input: 1 },
        { key: "b", dependsOn: ["a"], input: 1 },
      ],
    },
  ])("rejects invalid plan %s", (input) => {
    expect(() => parseExecutionPlan(input)).toThrow();
  });
  it("inspects long chains without recursive stack growth", () => {
    const chain = {
      key: "long",
      steps: Array.from({ length: 4_000 }, (_, index) => ({
        key: `step-${index}`,
        dependsOn: index ? [`step-${index - 1}`] : [],
        input: index,
      })),
    };
    expect(parseExecutionPlan(chain).steps).toHaveLength(4_000);
    expect(inspectExecutionPlan(chain).longestPath).toBe(4_000);
  });
  it("finds the exact rerun influence set", () => {
    expect(affectedPlanSteps(plan, ["review-a"])).toEqual([
      "review-a",
      "report",
    ]);
    expect(affectedPlanSteps(plan, ["index"])).toEqual([
      "index",
      "review-a",
      "review-b",
      "report",
    ]);
    expect(() => affectedPlanSteps(plan, ["outside"])).toThrow();
  });
});

describe("plan checkpoints", () => {
  it("rejects corrupt or incompatible durable checkpoints before running work", () => {
    expect(() =>
      parsePlanCheckpoint(plan, {
        planKey: plan.key,
        steps: [pending("outside")],
      }),
    ).toThrow("unknown step");
    expect(() =>
      parsePlanCheckpoint(plan, {
        planKey: plan.key,
        steps: [pending("index"), pending("index")],
      }),
    ).toThrow("duplicate step");
    expect(() =>
      parsePlanCheckpoint(plan, {
        planKey: plan.key,
        steps: [{ ...pending("index"), startedAt: "bad" }],
      }),
    ).toThrow("timestamp");
    expect(() =>
      parsePlanCheckpoint(plan, {
        planKey: plan.key,
        steps: [{ ...completed("index"), finishedAt: "2026-11-12T00:00:00Z" }],
      }),
    ).toThrow("precedes");
  });
  it("only makes a step ready after all dependencies have completed", () => {
    expect(readyPlanSteps(plan, []).map((step) => step.key)).toEqual(["index"]);
    expect(
      readyPlanSteps(plan, [completed("index")]).map((step) => step.key),
    ).toEqual(["review-a", "review-b"]);
    expect(
      readyPlanSteps(plan, [
        completed("index"),
        completed("review-a"),
        pending("review-b"),
      ]).map((step) => step.key),
    ).toEqual(["review-b"]);
  });
  it("restarts changed steps and their dependents while retaining unrelated results", () => {
    const checkpoint: PlanCheckpoint<number> = {
      planKey: "release",
      steps: plan.steps.map((step) => completed(step.key)),
    };
    const restarted = restartPlan(plan, checkpoint, ["review-a"]);
    expect(restarted.steps.map((step) => [step.key, step.status])).toEqual([
      ["index", "completed"],
      ["review-a", "pending"],
      ["review-b", "completed"],
      ["report", "pending"],
    ]);
    expect(checkpoint.steps.every((step) => step.status === "completed")).toBe(
      true,
    );
    expect(() =>
      restartPlan(plan, { ...checkpoint, planKey: "other" }, ["index"]),
    ).toThrow();
  });
});

describe("dependency execution", () => {
  it("runs dependency levels and passes completed results explicitly", async () => {
    const calls: string[] = [];
    const result = await runExecutionPlan(plan, {
      execute: async (step, dependencies) => {
        calls.push(step.key);
        if (step.key === "report")
          expect([...dependencies]).toEqual([
            ["review-a", 2],
            ["review-b", 3],
          ]);
        return step.input;
      },
    });
    expect(calls).toEqual(["index", "review-a", "review-b", "report"]);
    expect(result.outcome).toBe("completed");
    expect(result.steps.map((step) => step.value)).toEqual([1, 2, 3, 4]);
  });
  it("never exceeds the configured concurrency window", async () => {
    let active = 0;
    let peak = 0;
    const independent = {
      key: "parallel",
      steps: Array.from({ length: 20 }, (_, index) => ({
        key: `${index}`,
        dependsOn: [],
        input: index,
      })),
    };
    const result = await runExecutionPlan(independent, {
      concurrency: 3,
      execute: async (step) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return step.input;
      },
    });
    expect(peak).toBe(3);
    expect(active).toBe(0);
    expect(result.steps.every((step) => step.status === "completed")).toBe(
      true,
    );
  });
  it("skips failed dependencies while completing independent branches", async () => {
    const execute = vi.fn(async (step: { key: string }) => {
      if (step.key === "review-a") throw new Error("invalid review");
      return step.key;
    });
    const result = await runExecutionPlan(plan, { execute });
    expect(result.outcome).toBe("failed");
    expect(result.steps.find((step) => step.key === "review-b")?.status).toBe(
      "completed",
    );
    expect(result.steps.find((step) => step.key === "report")).toMatchObject({
      status: "skipped",
      reason: "dependency review-a did not complete",
    });
    expect(execute).toHaveBeenCalledTimes(3);
  });
  it("propagates skipped dependencies even when input order is reversed", async () => {
    const reversed = {
      key: "reversed",
      steps: [
        { key: "last", dependsOn: ["middle"], input: 3 },
        { key: "middle", dependsOn: ["first"], input: 2 },
        { key: "first", dependsOn: [], input: 1 },
      ],
    };
    const result = await runExecutionPlan(reversed, {
      execute: async () => {
        throw new Error("first failed");
      },
    });
    expect(result.steps.map((step) => step.status)).toEqual([
      "skipped",
      "skipped",
      "failed",
    ]);
  });
  it("runs explicit cleanup after a failed dependency", async () => {
    const cleanup = {
      key: "cleanup",
      steps: [
        { key: "run", dependsOn: [], input: 1 },
        {
          key: "cleanup",
          dependsOn: ["run"],
          input: 2,
          onDependencyFailure: "continue" as const,
        },
      ],
    };
    const calls: string[] = [];
    const result = await runExecutionPlan(cleanup, {
      execute: async (step, dependencies) => {
        calls.push(step.key);
        if (step.key === "run") throw new Error("broken");
        expect(dependencies.size).toBe(0);
        return "cleaned";
      },
    });
    expect(calls).toEqual(["run", "cleanup"]);
    expect(result.outcome).toBe("failed");
    expect(result.steps[1]?.status).toBe("completed");
  });
  it("does not repeat completed checkpoint steps", async () => {
    const execute = vi.fn(async (step: { input: number }) => step.input);
    const result = await runExecutionPlan(plan, {
      execute,
      checkpoint: { planKey: "release", steps: [completed("index")] },
    });
    expect(execute).toHaveBeenCalledTimes(3);
    expect(result.steps[0]?.value).toBe(10);
  });
  it("restarts interrupted running checkpoint steps", async () => {
    const result = await runExecutionPlan(
      { key: "one", steps: [plan.steps[0]!] },
      {
        checkpoint: {
          planKey: "one",
          steps: [{ ...pending("index"), status: "running" }],
        },
        execute: async () => 42,
      },
    );
    expect(result.steps[0]).toMatchObject({ status: "completed", value: 42 });
  });
  it("cancels pending work immediately when signaled", async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn(async () => 1);
    const result = await runExecutionPlan(plan, {
      execute,
      signal: controller.signal,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result.outcome).toBe("canceled");
    expect(result.steps.every((step) => step.status === "canceled")).toBe(true);
  });
  it("aborts in-flight peers after stopOnFailure", async () => {
    const result = await runExecutionPlan(
      {
        key: "stop",
        steps: [
          { key: "a", dependsOn: [], input: 1 },
          { key: "b", dependsOn: [], input: 2 },
          { key: "c", dependsOn: [], input: 3 },
        ],
      },
      {
        concurrency: 2,
        stopOnFailure: true,
        execute: async (step, _dependencies, signal) => {
          if (step.key === "a") throw new Error("stop");
          signal.throwIfAborted();
          return step.input;
        },
      },
    );
    expect(result.outcome).toBe("failed");
    expect(result.steps[2]?.status).toBe("canceled");
  });
  it("serializes durable saves and returns independent snapshots", async () => {
    const saved: PlanCheckpoint<number>[] = [];
    let activeSaves = 0;
    await runExecutionPlan(plan, {
      execute: async (step) => step.input,
      save: async (checkpoint) => {
        expect(activeSaves).toBe(0);
        activeSaves += 1;
        await Promise.resolve();
        saved.push(checkpoint);
        activeSaves -= 1;
      },
    });
    expect(saved[0]?.steps[0]?.status).toBe("running");
    expect(
      saved.at(-1)?.steps.every((step) => step.status === "completed"),
    ).toBe(true);
    expect(saved[0]?.steps[1]?.status).toBe("pending");
  });
  it("propagates checkpoint storage failures instead of pretending the step failed", async () => {
    await expect(
      runExecutionPlan(plan, {
        execute: async (step) => step.input,
        save: async () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow("disk full");
  });
  it.each([0, -1, 0.5, 101])(
    "rejects invalid concurrency %s",
    async (concurrency) => {
      await expect(
        runExecutionPlan(plan, { concurrency, execute: async () => 1 }),
      ).rejects.toThrow();
    },
  );
});
