/**
 * 任务队列、取消、重跑与手动触发。
 * 本文件保留原有请求路径与返回契约；认证和 GET 缓存由 http.ts 统一提供。
 * @example import { fetchTasks } from './api/task';
 */
import { authHeaders, notifyUnauthorized } from "../auth";
import { getJson } from "./http";

export type TaskSummary = {
  id: string;
  taskType: "issue_analysis" | "pr_review" | "repository_index";
  repositoryId: string | null;
  subjectNumber: number | null;
  subjectRevision: string;
  policyVersion: string;
  status: string;
  priority: number;
  attemptCount: number;
  maxAttempts: number;
  lastErrorCategory: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskList = {
  items: TaskSummary[];
  nextOffset?: number;
};

export type TaskEvent = {
  eventType: string;
  data: unknown;
  createdAt: string;
};

export type TaskAttempt = {
  attemptNumber: number;
  workerId: string;
  startedAt: string;
  finishedAt: string | null;
  errorCategory: string | null;
};

export type Publication = {
  channel: string;
  externalObjectId: string | null;
  createdAt: string;
};

export type TaskDetail = TaskSummary & {
  payload: unknown;
  timeline: TaskEvent[];
  attempts: TaskAttempt[];
  publications?: Publication[];
};

/** Lists tasks, newest first, offset-paginated by the previous response. */
export async function fetchTasks(options?: {
  limit?: number;
  offset?: number;
}): Promise<TaskList> {
  const params = new URLSearchParams();
  if (options?.limit) params.set("limit", String(options.limit));
  if (options?.offset !== undefined)
    params.set("offset", String(options.offset));
  const query = params.toString();
  return (await getJson(`/tasks${query ? `?${query}` : ""}`)) as TaskList;
}

/** Fetches a single task with its timeline and attempts. */
export async function fetchTaskDetail(id: string): Promise<TaskDetail> {
  return (await getJson(`/tasks/${encodeURIComponent(id)}`)) as TaskDetail;
}

export type RerunResult = {
  status: string;
  rerun: number;
  skipped: number;
};

export type CheckRunStatus = {
  id: number;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  title: string | null;
  htmlUrl: string | null;
};

export type TaskCheckRunResult = {
  status: string;
  present: boolean;
  degraded?: boolean;
  checkRun?: CheckRunStatus;
};

/** Live status of a task's published GitHub Check Run (polled by the WebUI). */
export async function fetchTaskCheckRun(
  taskId: string,
): Promise<TaskCheckRunResult> {
  return (await getJson(
    `/tasks/check-run?taskId=${encodeURIComponent(taskId)}`,
  )) as TaskCheckRunResult;
}

/** Re-queues finished tasks (failed / canceled) for another run (admin only). */
export async function rerunTasks(taskIds: string[]): Promise<RerunResult> {
  const response = await fetch("/tasks/rerun", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ taskIds }),
  });
  const text = await response.text();
  let parsed: {
    status?: string;
    reason?: string;
    rerun?: number;
    skipped?: number;
  } = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // keep default
  }
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (response.status === 403) throw new Error("需要管理员权限（403）");
  if (!response.ok) {
    throw new Error(parsed.reason ?? `rerun tasks ${response.status}`);
  }
  return {
    status: parsed.status ?? "ok",
    rerun: parsed.rerun ?? 0,
    skipped: parsed.skipped ?? 0,
  };
}

export type CancelResult = {
  status: string;
  canceled: number;
  skipped: number;
};

export async function cancelTasks(taskIds: string[]): Promise<CancelResult> {
  const response = await fetch("/tasks/cancel", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ taskIds }),
  });
  const text = await response.text();
  let parsed: {
    status?: string;
    reason?: string;
    canceled?: number;
    skipped?: number;
  } = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // keep default
  }
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (response.status === 403) throw new Error("需要管理员权限（403）");
  if (!response.ok) {
    throw new Error(parsed.reason ?? `cancel tasks ${response.status}`);
  }
  return {
    status: parsed.status ?? "ok",
    canceled: parsed.canceled ?? 0,
    skipped: parsed.skipped ?? 0,
  };
}

export type ManualTriggerInput = {
  type: "issue" | "pr";
  repositoryFullName: string;
  subjectNumber: number;
};

export type ManualTriggerResult = {
  status: string;
  taskId: string;
  outcome: "created" | "requeued" | "duplicate";
  taskStatus?: TaskSummary["status"];
};

/**
 * Manually enqueues an issue analysis or PR review task for an installed
 * repository. Failed/canceled tasks get a fresh attempt budget; active or
 * successfully completed tasks retain their idempotency record.
 */
export async function triggerManualTask(
  input: ManualTriggerInput,
): Promise<ManualTriggerResult> {
  const response = await fetch("/tasks/manual", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(input),
  });
  const text = await response.text();
  let parsed: {
    status?: string;
    reason?: string;
    taskId?: string;
    outcome?: ManualTriggerResult["outcome"];
    taskStatus?: TaskSummary["status"];
  } = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // keep default
  }
  if (!response.ok) {
    const reason = parsed.reason ?? `manual trigger ${response.status}`;
    throw new Error(reason);
  }
  return {
    status: parsed.status ?? "ok",
    taskId: parsed.taskId ?? "",
    outcome: parsed.outcome ?? "created",
    ...(parsed.taskStatus ? { taskStatus: parsed.taskStatus } : {}),
  };
}
