import type {
  AnalysisTask,
  CreateTaskInput,
  TaskCreationResult,
  TaskStatus,
} from "../../../packages/domain/src/index.js";

export interface ManualTaskServices {
  create: (input: CreateTaskInput) => Promise<TaskCreationResult>;
  reset: (taskId: string) => Promise<boolean>;
  find: (taskId: string) => Promise<AnalysisTask | null>;
}

export interface ManualTaskResult {
  taskId: string;
  outcome: "created" | "requeued" | "duplicate";
  taskStatus: TaskStatus;
}

export async function triggerManualAnalysis(
  services: ManualTaskServices,
  input: CreateTaskInput,
): Promise<ManualTaskResult> {
  const result = await services.create(input);
  if (result.outcome === "created") {
    return {
      taskId: result.task.id,
      outcome: "created",
      taskStatus: result.task.status,
    };
  }
  const { task } = result;
  if (task.status === "failed" || task.status === "canceled") {
    // resetTaskToQueued conditionally updates only failed/canceled rows, clears
    // old attempts and emits retry_ready. Concurrent clicks cannot reset twice.
    if (await services.reset(task.id)) {
      return { taskId: task.id, outcome: "requeued", taskStatus: "queued" };
    }
    const current = await services.find(task.id);
    if (!current) throw new Error("manual task disappeared during requeue");
    return {
      taskId: current.id,
      outcome: "duplicate",
      taskStatus: current.status,
    };
  }
  return { taskId: task.id, outcome: "duplicate", taskStatus: task.status };
}
