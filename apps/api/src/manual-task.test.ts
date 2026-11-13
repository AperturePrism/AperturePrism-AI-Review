import { describe, expect, it, vi } from "vitest";
import type {
  AnalysisTask,
  CreateTaskInput,
  TaskStatus,
} from "../../../packages/domain/src/index.js";
import {
  triggerManualAnalysis,
  type ManualTaskServices,
} from "./manual-task.js";

const input: CreateTaskInput = {
  taskType: "pr_review",
  repositoryId: "repo",
  subjectNumber: 40,
  subjectRevision: "sha",
  policyVersion: "v3",
  dedupeKey: "pr-review:repo:40:sha:v3",
  payload: {},
};
function task(status: TaskStatus): AnalysisTask {
  return {
    id: "task-1",
    status,
    taskType: "pr_review",
    dedupeKey: input.dedupeKey,
  };
}
function services(status: TaskStatus) {
  return {
    create: vi
      .fn<ManualTaskServices["create"]>()
      .mockResolvedValue({ outcome: "duplicate", task: task(status) }),
    reset: vi.fn<ManualTaskServices["reset"]>().mockResolvedValue(true),
    find: vi.fn<ManualTaskServices["find"]>().mockResolvedValue(task("queued")),
  };
}

describe("manual task trigger after a failed review", () => {
  it.each(["failed", "canceled"] as const)(
    "requeues the existing %s task with no new dedupe identity",
    async (status) => {
      const deps = services(status);
      await expect(triggerManualAnalysis(deps, input)).resolves.toEqual({
        taskId: "task-1",
        outcome: "requeued",
        taskStatus: "queued",
      });
      expect(deps.reset).toHaveBeenCalledExactlyOnceWith("task-1");
      expect(deps.create).toHaveBeenCalledExactlyOnceWith(input);
      expect(deps.find).not.toHaveBeenCalled();
    },
  );

  it.each([
    "queued",
    "leased",
    "running",
    "publishing",
    "retry_wait",
    "completed",
  ] as const)("does not reset a %s duplicate", async (status) => {
    const deps = services(status);
    await expect(triggerManualAnalysis(deps, input)).resolves.toEqual({
      taskId: "task-1",
      outcome: "duplicate",
      taskStatus: status,
    });
    expect(deps.reset).not.toHaveBeenCalled();
  });

  it("reports a newly created task without resetting it", async () => {
    const deps = services("queued");
    deps.create.mockResolvedValueOnce({
      outcome: "created",
      task: task("queued"),
    });
    await expect(triggerManualAnalysis(deps, input)).resolves.toEqual({
      taskId: "task-1",
      outcome: "created",
      taskStatus: "queued",
    });
    expect(deps.reset).not.toHaveBeenCalled();
  });

  it("handles a concurrent rerun without claiming it queued the same task twice", async () => {
    const deps = services("failed");
    deps.reset.mockResolvedValueOnce(false);
    deps.find.mockResolvedValueOnce(task("running"));
    await expect(triggerManualAnalysis(deps, input)).resolves.toEqual({
      taskId: "task-1",
      outcome: "duplicate",
      taskStatus: "running",
    });
    expect(deps.reset).toHaveBeenCalledOnce();
  });

  it("propagates reset errors instead of reporting false success", async () => {
    const deps = services("failed");
    deps.reset.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(triggerManualAnalysis(deps, input)).rejects.toThrow(
      "database unavailable",
    );
  });
});
