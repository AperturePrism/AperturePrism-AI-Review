/**
 * 任务：领取、租约和从payload读取Issue或PR身份。
 * 调用示例：await engine.claim()。
 * 仅拆分内部实现；任务与数据契约保持兼容，依赖在下方显式列出。
 */
import {
  parseIssueTaskPayload,
  repositoryOwnerName,
} from "../../../packages/issue-analysis/src/index.js";
import { parsePrReviewTaskPayload } from "../../../packages/pr-review/src/index.js";
import {
  beginPublishing,
  claimTask,
  completeTask,
  failTask,
  heartbeatTask,
  startTask,
} from "../../../packages/task-engine/src/index.js";
import { type TaskEngineOperations } from "./loop.js";
import {
  database,
  leaseDurationMs,
  retryDelayMs,
  workerId,
} from "./runtime.js";

export const engine: TaskEngineOperations = {
  claim: () => claimTask(database.db, { workerId, leaseDurationMs }),
  start: (task) => startTask(database.db, { taskId: task.id, workerId }),
  heartbeat: async (task) =>
    (await heartbeatTask(database.db, {
      taskId: task.id,
      workerId,
      leaseDurationMs,
    })) !== null,
  beginPublishing: (task) =>
    beginPublishing(database.db, { taskId: task.id, workerId }),
  complete: (task) => completeTask(database.db, { taskId: task.id, workerId }),
  fail: async (task, errorCategory, errorMessage) => {
    return await failTask(database.db, {
      taskId: task.id,
      workerId,
      errorCategory,
      retryDelayMs,
      ...(errorMessage === undefined ? {} : { errorMessage }),
    });
  },
};

export function issueIdentity(task: { payload: unknown }) {
  const payload = parseIssueTaskPayload(task.payload);
  if (!payload) throw new Error("task payload is missing issue identity");
  const identity = repositoryOwnerName(payload.repositoryFullName);
  if (!identity)
    throw new Error(
      `invalid repository name in payload: ${payload.repositoryFullName}`,
    );
  return { payload, identity };
}

export function prIdentity(task: { payload: unknown }) {
  const payload = parsePrReviewTaskPayload(task.payload);
  if (!payload) throw new Error("task payload is missing PR identity");
  const identity = repositoryOwnerName(payload.repositoryFullName);
  if (!identity)
    throw new Error(
      `invalid repository name in payload: ${payload.repositoryFullName}`,
    );
  return { payload, identity };
}
