/**
 * 审查任务：查询、手动触发、重新入队、取消和 Check Run。
 * 调用示例：handleTasks(request, response, requestId)。
 * HTTP 路径保持兼容；跨文件依赖在下方显式列出。
 */
import type { TaskStatus } from "../../../../packages/domain/src/index.js";
import { HttpError, UUID_PATTERN, parseJsonBody } from "../utils/http.js";
import { parseJsonObject } from "../utils/http.js";
import type { HttpRoute } from "../utils/routes.js";
import {
  analysisTasks,
  taskEvents,
  taskAttempts,
  externalPublications,
  repositories,
} from "../../../../packages/database/src/index.js";
import { GitHubApiError } from "../../../../packages/github-adapter/src/index.js";
import {
  repositoryOwnerName,
  ISSUE_ANALYSIS_POLICY_VERSION,
} from "../../../../packages/issue-analysis/src/index.js";
import { PR_REVIEW_POLICY_VERSION } from "../../../../packages/pr-review/src/index.js";
import {
  createAnalysisTask,
  resetTaskToQueued,
  cancelTask,
} from "../../../../packages/task-engine/src/index.js";
import { githubClientPromise } from "../github.js";
import {
  visibleRepoScope,
  sessionLogin,
  canAccessRepo,
  audit,
  isAdminRequest,
} from "../identity.js";
import { triggerManualAnalysis } from "../manual-task.js";
import { database } from "../runtime.js";
import { json, readBody } from "../utils/http.js";
import {
  inArray,
  desc,
  eq,
  asc,
  and,
  or,
  lt,
  gte,
  lte,
  ilike,
} from "drizzle-orm";
import { type IncomingMessage, type ServerResponse } from "node:http";

/** Column set shared by the list and detail views (payload is heavy). */
const taskSummaryColumns = {
  id: analysisTasks.id,
  taskType: analysisTasks.taskType,
  repositoryId: analysisTasks.repositoryId,
  subjectNumber: analysisTasks.subjectNumber,
  subjectRevision: analysisTasks.subjectRevision,
  policyVersion: analysisTasks.policyVersion,
  status: analysisTasks.status,
  priority: analysisTasks.priority,
  attemptCount: analysisTasks.attemptCount,
  maxAttempts: analysisTasks.maxAttempts,
  lastErrorCategory: analysisTasks.lastErrorCategory,
  createdAt: analysisTasks.createdAt,
  updatedAt: analysisTasks.updatedAt,
} as const;

/**
 * Lists tasks (cursor-paginated by creation time, newest first) or returns a
 * single task by id. Public reads for the WebUI; no secrets are exposed (the
 * task payload is only included in the detail view).
 */
export async function handleTasks(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  const path = url.pathname;
  const id = path.startsWith("/tasks/")
    ? decodeURIComponent(path.slice("/tasks/".length)).trim()
    : null;

  // A well-formed task id is a UUID. Guard the detail lookup so a short or
  // malformed id (e.g. /tasks/1) returns 404 instead of a Postgres uuid parse
  // error bubbling up as a 500.
  if (
    id &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    json(
      response,
      404,
      { status: "error", reason: "task not found" },
      requestId,
    );
    return;
  }

  if (!id) {
    const query = parseTaskList(url);
    const scope = await visibleRepoScope(request);
    const items = await database.db
      .select(taskSummaryColumns)
      .from(analysisTasks)
      .where(
        and(
          scope && scope.ids !== null
            ? inArray(analysisTasks.repositoryId, [...scope.ids])
            : undefined,
          query.statuses.length
            ? inArray(analysisTasks.status, [...query.statuses])
            : undefined,
          query.taskType
            ? eq(analysisTasks.taskType, query.taskType)
            : undefined,
          query.repositoryId
            ? eq(analysisTasks.repositoryId, query.repositoryId)
            : undefined,
          query.from ? gte(analysisTasks.createdAt, query.from) : undefined,
          query.to ? lte(analysisTasks.createdAt, query.to) : undefined,
          query.search
            ? or(
                ilike(analysisTasks.dedupeKey, `%${query.search}%`),
                ilike(analysisTasks.subjectRevision, `%${query.search}%`),
              )
            : undefined,
          query.cursor
            ? or(
                lt(analysisTasks.createdAt, query.cursor.createdAt),
                and(
                  eq(analysisTasks.createdAt, query.cursor.createdAt),
                  lt(analysisTasks.id, query.cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(analysisTasks.createdAt), desc(analysisTasks.id))
      .limit(query.limit + 1)
      .offset(query.cursor ? 0 : query.offset);
    const hasMore = items.length > query.limit;
    const page = items.slice(0, query.limit);
    const last = page.at(-1);
    json(
      response,
      200,
      {
        items: page,
        ...(hasMore ? { nextOffset: query.offset + query.limit } : {}),
        ...(hasMore && last ? { nextCursor: encodeTaskCursor(last) } : {}),
      },
      requestId,
    );
    return;
  }

  const rows = await database.db
    .select({ ...taskSummaryColumns, payload: analysisTasks.payload })
    .from(analysisTasks)
    .where(eq(analysisTasks.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    json(
      response,
      404,
      { status: "error", reason: "task not found" },
      requestId,
    );
    return;
  }
  // 同一份仓库授权用于列表、详情、批量操作和导出。
  const visible = row.repositoryId
    ? await canAccessRepo(request, row.repositoryId, "view")
    : await isAdminRequest(request);
  if (!visible) {
    json(
      response,
      404,
      { status: "error", reason: "task not found" },
      requestId,
    );
    return;
  }

  const [timeline, attempts, publications] = await Promise.all([
    database.db
      .select({
        eventType: taskEvents.eventType,
        data: taskEvents.data,
        createdAt: taskEvents.createdAt,
      })
      .from(taskEvents)
      .where(eq(taskEvents.taskId, id))
      .orderBy(asc(taskEvents.createdAt))
      .limit(200),
    database.db
      .select({
        attemptNumber: taskAttempts.attemptNumber,
        workerId: taskAttempts.workerId,
        startedAt: taskAttempts.startedAt,
        finishedAt: taskAttempts.finishedAt,
        errorCategory: taskAttempts.errorCategory,
      })
      .from(taskAttempts)
      .where(eq(taskAttempts.taskId, id))
      .orderBy(asc(taskAttempts.attemptNumber)),
    database.db
      .select({
        channel: externalPublications.channel,
        externalObjectId: externalPublications.externalObjectId,
        createdAt: externalPublications.createdAt,
      })
      .from(externalPublications)
      .where(eq(externalPublications.taskId, id))
      .orderBy(asc(externalPublications.createdAt)),
  ]);
  json(response, 200, { ...row, timeline, attempts, publications }, requestId);
}

/**
 * Manual task trigger (POST /tasks/manual). Looks up the installed repository
 * by owner/name, resolves the subject revision (PR head SHA via GitHub, or the
 * current time for issues), and enqueues an analysis/review task shaped exactly
 * like a webhook-derived task.
 */
export async function handleManualTask(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const body = await readBody(request);
  let parsed: {
    type?: unknown;
    repositoryFullName?: unknown;
    subjectNumber?: unknown;
  };
  try {
    parsed = parseJsonObject(body);
  } catch {
    json(response, 400, { status: "error", reason: "invalid JSON" }, requestId);
    return;
  }
  const type = parsed.type;
  if (type !== "issue" && type !== "pr") {
    json(
      response,
      400,
      { status: "error", reason: "type must be 'issue' or 'pr'" },
      requestId,
    );
    return;
  }
  const repositoryFullName =
    typeof parsed.repositoryFullName === "string"
      ? parsed.repositoryFullName.trim()
      : "";
  const identity = repositoryOwnerName(repositoryFullName);
  if (!identity) {
    json(
      response,
      400,
      { status: "error", reason: "repositoryFullName must be owner/repo" },
      requestId,
    );
    return;
  }
  const subjectNumber = parsed.subjectNumber;
  if (
    typeof subjectNumber !== "number" ||
    !Number.isInteger(subjectNumber) ||
    subjectNumber <= 0
  ) {
    json(
      response,
      400,
      { status: "error", reason: "subjectNumber must be a positive integer" },
      requestId,
    );
    return;
  }

  const rows = await database.db
    .select({
      id: repositories.id,
      githubId: repositories.githubId,
      installationId: repositories.installationId,
    })
    .from(repositories)
    .where(
      and(
        eq(repositories.owner, identity.owner),
        eq(repositories.name, identity.name),
      ),
    )
    .limit(1);
  const repo = rows[0];
  if (!repo || !repo.installationId) {
    json(
      response,
      404,
      { status: "error", reason: "repository_not_installed" },
      requestId,
    );
    return;
  }

  if (!(await canAccessRepo(request, repo.id, "manage"))) {
    json(
      response,
      403,
      { status: "error", reason: "repository_manage_required" },
      requestId,
    );
    return;
  }

  const github = await githubClientPromise;
  let subjectRevision: string;
  if (type === "pr") {
    if (!github) {
      json(
        response,
        503,
        { status: "error", reason: "github_not_configured" },
        requestId,
      );
      return;
    }
    try {
      const pullRequest = await github.getPullRequest({
        installationId: repo.installationId,
        owner: identity.owner,
        name: identity.name,
        number: subjectNumber,
      });
      subjectRevision = pullRequest.headSha;
    } catch (error) {
      if (error instanceof GitHubApiError) {
        const reason =
          error.category === "not_found"
            ? "pull_request_not_found"
            : error.category;
        json(response, 400, { status: "error", reason }, requestId);
        return;
      }
      throw error;
    }
  } else {
    subjectRevision = new Date().toISOString();
  }

  const policyVersion =
    type === "issue" ? ISSUE_ANALYSIS_POLICY_VERSION : PR_REVIEW_POLICY_VERSION;
  const taskType = type === "issue" ? "issue_analysis" : "pr_review";
  const keyPrefix = type === "issue" ? "issue-analysis" : "pr-review";
  const result = await triggerManualAnalysis(
    {
      create: (input) => createAnalysisTask(database.db, input),
      reset: (taskId) => resetTaskToQueued(database.db, { taskId }),
      find: async (taskId) => {
        const [task] = await database.db
          .select({
            id: analysisTasks.id,
            taskType: analysisTasks.taskType,
            status: analysisTasks.status,
            dedupeKey: analysisTasks.dedupeKey,
          })
          .from(analysisTasks)
          .where(eq(analysisTasks.id, taskId))
          .limit(1);
        return task ? { ...task, taskType } : null;
      },
    },
    {
      taskType,
      repositoryId: repo.id,
      subjectNumber,
      subjectRevision,
      policyVersion,
      dedupeKey: `${keyPrefix}:${repo.id}:${subjectNumber}:${subjectRevision}:${policyVersion}`,
      payload: {
        installationId: repo.installationId,
        repositoryExternalId: repo.githubId,
        repositoryFullName,
        subjectNumber,
        subjectRevision,
        sourceEvent: "manual",
      },
    },
  );

  audit(request, "task.manual_trigger", repositoryFullName, {
    type,
    subjectNumber,
    outcome: result.outcome,
    taskId: result.taskId,
  });
  json(response, 200, { status: "ok", ...result }, requestId);
}

/**
 * Re-queues finished tasks (failed / canceled) for another run. Accepts a list
 * of task ids; each is reset to `queued` with a fresh attempt budget. Tasks in
 * non-finished states are skipped, not errored. Admin only.
 */
export async function handleTaskRerun(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  if (!(await isAdminRequest(request))) {
    json(
      response,
      403,
      { status: "error", reason: "admin required" },
      requestId,
    );
    return;
  }
  const body = await readBody(request);
  let parsed: { taskIds?: unknown };
  try {
    parsed = parseJsonObject(body);
  } catch {
    json(response, 400, { status: "error", reason: "invalid JSON" }, requestId);
    return;
  }
  const ids = parseTaskIds(parsed.taskIds);
  let rerun = 0;
  let skipped = 0;
  for (const taskId of ids) {
    const ok = await resetTaskToQueued(database.db, { taskId });
    if (ok) rerun += 1;
    else skipped += 1;
  }
  audit(request, "task.rerun", undefined, {
    taskIds: ids.length,
    rerun,
    skipped,
  });
  json(response, 200, { status: "ok", rerun, skipped }, requestId);
}

/**
 * POST /tasks/cancel — manually cancel running tasks from the WebUI.
 *
 * Mirrors handleTaskRerun: admin-only, batch by taskIds, reports how many were
 * actually canceled vs skipped. A task is only canceled when it is in a
 * non-terminal state (queued/leased/running/publishing/retry_wait); tasks
 * already completed/failed/canceled are skipped. Running workers notice the
 * cleared lease on their next heartbeat and stop (see runOnce lease_lost path).
 */
export async function handleTaskCancel(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  if (!(await isAdminRequest(request))) {
    json(
      response,
      403,
      { status: "error", reason: "admin required" },
      requestId,
    );
    return;
  }
  const body = await readBody(request);
  let parsed: { taskIds?: unknown };
  try {
    parsed = parseJsonObject(body);
  } catch {
    json(response, 400, { status: "error", reason: "invalid JSON" }, requestId);
    return;
  }
  const ids = parseTaskIds(parsed.taskIds);
  let canceled = 0;
  let skipped = 0;
  for (const taskId of ids) {
    const ok = await cancelTask(database.db, {
      taskId,
      reason: "manual_cancel",
    });
    if (ok) {
      canceled += 1;
      // Persist cancellation first; the scheduler retries Check Run completion
      // until acknowledged, with fencing against a concurrent manual rerun.
    } else skipped += 1;
  }
  audit(request, "task.cancel", undefined, {
    taskIds: ids.length,
    canceled,
    skipped,
  });
  json(response, 200, { status: "ok", canceled, skipped }, requestId);
}

/**
 * GET /tasks/check-run?taskId=<uuid> — live status of a task's published
 * GitHub Check Run. Looks up the check_run publication for the task and
 * queries GitHub for its current status/conclusion so the WebUI can poll
 * without keeping an SSE channel open. Degrades gracefully (no publication /
 * GitHub unconfigured / GitHub error) with a `degraded` flag.
 */
export async function handleTaskCheckRun(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  const taskId = url.searchParams.get("taskId") ?? "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      taskId,
    )
  ) {
    json(
      response,
      400,
      { status: "error", reason: "taskId must be a UUID" },
      requestId,
    );
    return;
  }

  const task = await database.db
    .select({
      payload: analysisTasks.payload,
      repositoryId: analysisTasks.repositoryId,
    })
    .from(analysisTasks)
    .where(eq(analysisTasks.id, taskId))
    .limit(1);
  const payload = task[0]?.payload as
    | {
        installationId?: unknown;
        repositoryFullName?: unknown;
        subjectNumber?: unknown;
      }
    | null
    | undefined;
  if (!payload) {
    json(
      response,
      404,
      { status: "error", reason: "task not found" },
      requestId,
    );
    return;
  }

  const allowed = task[0]?.repositoryId
    ? await canAccessRepo(request, task[0].repositoryId, "view")
    : await isAdminRequest(request);
  if (!allowed) {
    json(
      response,
      404,
      { status: "error", reason: "task not found" },
      requestId,
    );
    return;
  }

  const publication = await database.db
    .select({ externalObjectId: externalPublications.externalObjectId })
    .from(externalPublications)
    .where(
      and(
        eq(externalPublications.taskId, taskId),
        eq(externalPublications.channel, "check_run"),
      ),
    )
    .limit(1);
  const checkRunId = Number(publication[0]?.externalObjectId ?? 0);
  if (!Number.isInteger(checkRunId) || checkRunId <= 0) {
    json(
      response,
      200,
      { status: "ok", present: false, degraded: false },
      requestId,
    );
    return;
  }

  const github = await githubClientPromise;
  const installationId = String(payload.installationId ?? "");
  const repositoryFullName = String(payload.repositoryFullName ?? "");
  const [owner, name] = repositoryFullName.split("/");
  if (!github || !installationId || !owner || !name) {
    json(
      response,
      200,
      { status: "ok", present: true, degraded: true },
      requestId,
    );
    return;
  }

  try {
    const run = await github.getCheckRun({
      installationId,
      owner,
      name,
      checkRunId,
    });
    json(
      response,
      200,
      {
        status: "ok",
        present: true,
        degraded: false,
        checkRun: {
          id: run.id,
          status: run.status,
          conclusion: run.conclusion,
          title: run.title,
          htmlUrl: run.htmlUrl,
        },
      },
      requestId,
    );
  } catch {
    json(
      response,
      200,
      { status: "ok", present: true, degraded: true },
      requestId,
    );
  }
}

// HTTP 入口与业务放在同一处：新增同类入口只修改本文件。
export const routes = [
  { path: "/tasks/batch", methods: ["POST"], handle: handleTaskBatch },
  { path: "/tasks/manual", methods: ["POST"], handle: handleManualTask },
  { path: "/tasks/rerun", methods: ["POST"], handle: handleTaskRerun },
  { path: "/tasks/cancel", methods: ["POST"], handle: handleTaskCancel },
  { path: "/tasks/check-run", methods: ["GET"], handle: handleTaskCheckRun },
  { path: "/tasks", prefix: true, methods: ["GET"], handle: handleTasks },
] satisfies readonly HttpRoute[];

export type TaskBatchAction = "retry" | "cancel" | "priority";
export type TaskBatchInput = {
  taskIds: readonly string[];
  action: TaskBatchAction;
  dryRun: boolean;
  reason: string;
  priority?: number;
};
export type BatchTask = {
  id: string;
  repositoryId: string | null;
  status: string;
};
export type TaskBatchServices = {
  list: (taskIds: readonly string[]) => Promise<readonly BatchTask[]>;
  canManage: (task: BatchTask) => Promise<boolean>;
  retry: (taskId: string) => Promise<boolean>;
  cancel: (taskId: string, reason: string) => Promise<boolean>;
  priority: (taskId: string, priority: number) => Promise<boolean>;
};
export type TaskBatchOutcome = {
  taskId: string;
  outcome: "updated" | "would_update" | "skipped" | "forbidden" | "not_found";
  previousStatus?: string;
  status?: string;
};

/** 外部批量任务 ID 一次校验和去重，避免 PostgreSQL UUID 转换错误及重复计数。 */
export function parseTaskIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) {
    throw new HttpError(400, "taskIds must contain between 1 and 200 UUIDs");
  }
  if (
    value.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id.trim()))
  ) {
    throw new HttpError(400, "every taskId must be a UUID");
  }
  return [...new Set((value as string[]).map((id) => id.trim().toLowerCase()))];
}

/**
 * 批量命令输入边界。dryRun 只计算可执行项，不调用任何写入操作。
 * @param value 用户提交的 JSON 对象。
 * @returns 已整理且内部可以直接信任的命令参数。
 */
export function parseTaskBatch(value: Record<string, unknown>): TaskBatchInput {
  const taskIds = parseTaskIds(value.taskIds);
  const action = value.action;
  if (action !== "retry" && action !== "cancel" && action !== "priority") {
    throw new HttpError(400, "action must be retry, cancel or priority");
  }
  if (value.dryRun !== undefined && typeof value.dryRun !== "boolean") {
    throw new HttpError(400, "dryRun must be a boolean");
  }
  if (value.reason !== undefined && typeof value.reason !== "string") {
    throw new HttpError(400, "reason must be a string");
  }
  const reason =
    typeof value.reason === "string"
      ? value.reason.trim()
      : "manual_batch_cancel";
  if (reason.length > 500)
    throw new HttpError(400, "reason must not exceed 500 characters");
  if (action === "priority") {
    if (
      typeof value.priority !== "number" ||
      !Number.isInteger(value.priority) ||
      value.priority < -100 ||
      value.priority > 100
    ) {
      throw new HttpError(
        400,
        "priority must be an integer between -100 and 100",
      );
    }
    return {
      taskIds,
      action,
      dryRun: value.dryRun === true,
      reason,
      priority: value.priority,
    };
  }
  return { taskIds, action, dryRun: value.dryRun === true, reason };
}

/**
 * 按输入顺序执行一个有界批次，逐任务检查仓库管理权限。
 * 状态写入交给已有 task-engine 的带条件事务，预览与实际写入之间的竞态返回 skipped。
 */
export async function executeTaskBatch(
  input: TaskBatchInput,
  services: TaskBatchServices,
): Promise<readonly TaskBatchOutcome[]> {
  const found = new Map(
    (await services.list(input.taskIds)).map((task) => [task.id, task]),
  );
  const outcomes: TaskBatchOutcome[] = [];
  for (const taskId of input.taskIds) {
    const task = found.get(taskId);
    if (!task) {
      outcomes.push({ taskId, outcome: "not_found" });
      continue;
    }
    if (!(await services.canManage(task))) {
      outcomes.push({ taskId, outcome: "forbidden" });
      continue;
    }
    const eligible =
      input.action === "retry"
        ? ["failed", "canceled"]
        : input.action === "priority"
          ? ["queued", "retry_wait"]
          : ["queued", "leased", "running", "publishing", "retry_wait"];
    if (!eligible.includes(task.status)) {
      outcomes.push({
        taskId,
        outcome: "skipped",
        previousStatus: task.status,
        status: task.status,
      });
      continue;
    }
    const next =
      input.action === "retry"
        ? "queued"
        : input.action === "cancel"
          ? "canceled"
          : task.status;
    if (input.dryRun) {
      outcomes.push({
        taskId,
        outcome: "would_update",
        previousStatus: task.status,
        status: next,
      });
      continue;
    }
    const updated =
      input.action === "retry"
        ? await services.retry(taskId)
        : input.action === "cancel"
          ? await services.cancel(taskId, input.reason)
          : await services.priority(taskId, input.priority!);
    outcomes.push({
      taskId,
      outcome: updated ? "updated" : "skipped",
      previousStatus: task.status,
      status: updated ? next : task.status,
    });
  }
  return outcomes;
}

/** POST /tasks/batch — 预览、重试、取消或调整优先级，结果逐项返回。 */
export async function handleTaskBatch(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const body = await parseJsonBody(request);
  if (!body) throw new HttpError(400, "invalid JSON object");
  const input = parseTaskBatch(body);
  const admin = await isAdminRequest(request);
  const outcomes = await executeTaskBatch(input, {
    list: (taskIds) =>
      database.db
        .select({
          id: analysisTasks.id,
          repositoryId: analysisTasks.repositoryId,
          status: analysisTasks.status,
        })
        .from(analysisTasks)
        .where(inArray(analysisTasks.id, [...taskIds])),
    canManage: (task) =>
      admin
        ? Promise.resolve(true)
        : task.repositoryId
          ? canAccessRepo(request, task.repositoryId, "manage")
          : Promise.resolve(false),
    retry: (taskId) => resetTaskToQueued(database.db, { taskId }),
    cancel: (taskId, reason) => cancelTask(database.db, { taskId, reason }),
    priority: (taskId, priority) =>
      database.db.transaction(async (transaction) => {
        const updated = await transaction
          .update(analysisTasks)
          .set({ priority, updatedAt: new Date() })
          .where(
            and(
              eq(analysisTasks.id, taskId),
              inArray(analysisTasks.status, ["queued", "retry_wait"]),
            ),
          )
          .returning({ id: analysisTasks.id });
        if (!updated.length) return false;
        await transaction.insert(taskEvents).values({
          taskId,
          eventType: "task.priority_changed",
          data: {
            taskId,
            priority,
            actor: sessionLogin(request) ?? "bearer",
          },
        });
        return true;
      }),
  });
  const changed = outcomes.filter(
    (result) => result.outcome === "updated",
  ).length;
  if (!input.dryRun)
    audit(request, "task.batch", undefined, {
      action: input.action,
      requested: input.taskIds.length,
      changed,
    });
  json(
    response,
    200,
    {
      status: "ok",
      action: input.action,
      dryRun: input.dryRun,
      changed,
      items: outcomes,
    },
    requestId,
  );
}

export type TaskListQuery = {
  limit: number;
  offset: number;
  cursor: { id: string; createdAt: Date } | null;
  statuses: readonly TaskStatus[];
  taskType: string | null;
  repositoryId: string | null;
  from: Date | null;
  to: Date | null;
  search: string;
};

/** 任务列表的稳定二元游标：同一毫秒的多个任务也不会被跨页跳过。 */
export function encodeTaskCursor(row: { id: string; createdAt: Date }): string {
  return Buffer.from(
    JSON.stringify({ id: row.id, createdAt: row.createdAt.toISOString() }),
  ).toString("base64url");
}

/** 列表查询的输入边界；保留旧 offset 参数，同时支持稳定游标和组合过滤。 */
export function parseTaskList(url: URL): TaskListQuery {
  const parameters = url.searchParams;
  const limit = Number(parameters.get("limit") ?? "50");
  const offset = Number(parameters.get("offset") ?? "0");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new HttpError(400, "limit must be between 1 and 200");
  if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000)
    throw new HttpError(400, "offset must be between 0 and 1000000");
  const statuses = [
    ...new Set(
      parameters
        .getAll("status")
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  const allowed = [
    "queued",
    "leased",
    "running",
    "publishing",
    "completed",
    "retry_wait",
    "failed",
    "canceled",
  ];
  if (statuses.some((value) => !allowed.includes(value)))
    throw new HttpError(400, "invalid task status");
  const taskType = parameters.get("taskType");
  if (
    taskType &&
    !["issue_analysis", "pr_review", "repository_index"].includes(taskType)
  )
    throw new HttpError(400, "invalid taskType");
  const repositoryId = parameters.get("repositoryId");
  if (repositoryId && !UUID_PATTERN.test(repositoryId))
    throw new HttpError(400, "repositoryId must be a UUID");
  const from = parameters.has("from")
    ? new Date(parameters.get("from")!)
    : null;
  const to = parameters.has("to") ? new Date(parameters.get("to")!) : null;
  if (
    (from && !Number.isFinite(from.getTime())) ||
    (to && !Number.isFinite(to.getTime())) ||
    (from && to && from > to)
  )
    throw new HttpError(400, "invalid task date range");
  const search = (parameters.get("q") ?? "").trim();
  if (search.length > 200)
    throw new HttpError(400, "search must not exceed 200 characters");
  let cursor: TaskListQuery["cursor"] = null;
  const rawCursor = parameters.get("cursor");
  if (rawCursor) {
    if (offset !== 0 || rawCursor.length > 1024)
      throw new HttpError(400, "cursor cannot be combined with offset");
    try {
      const value = JSON.parse(
        Buffer.from(rawCursor, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      if (
        !value ||
        typeof value.id !== "string" ||
        !UUID_PATTERN.test(value.id) ||
        typeof value.createdAt !== "string"
      )
        throw new Error("cursor fields");
      const createdAt = new Date(value.createdAt);
      if (!Number.isFinite(createdAt.getTime())) throw new Error("cursor date");
      cursor = { id: value.id, createdAt };
    } catch {
      throw new HttpError(400, "invalid task cursor");
    }
  }
  return {
    limit,
    offset,
    cursor,
    statuses: statuses as TaskStatus[],
    taskType,
    repositoryId,
    from,
    to,
    search,
  };
}
