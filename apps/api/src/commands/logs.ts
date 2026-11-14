/**
 * 任务日志：按任务、类型与时间筛选审查事件。
 * 调用示例：handleLogs(request, response, requestId)。
 * HTTP 路径保持兼容；跨文件依赖在下方显式列出。
 */
import type { HttpRoute } from "../utils/routes.js";
import {
  taskEvents,
  analysisTasks,
  webhookDeliveries,
} from "../../../../packages/database/src/index.js";
import { visibleRepoScope } from "../identity.js";
import { database } from "../runtime.js";
import { json } from "../utils/http.js";
import { eq, inArray, desc, and, gt, asc } from "drizzle-orm";
import { type IncomingMessage, type ServerResponse } from "node:http";

/**
 * Activity log. Three modes driven by query params:
 *  - default: recent events (60) + webhook deliveries (30) — diagnostic bundle.
 *  - ?history=1&offset=N&limit=M: offset-paginated historical events.
 *  - ?since=<iso>: events created after `since` (resume from a bookmark).
 */
export async function handleLogs(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");

  const sinceRaw = url.searchParams.get("since");
  const isHistory = url.searchParams.get("history") === "1";
  // 方向七：非 admin 仅能看到被授权仓库的任务事件。
  const scope = await visibleRepoScope(request);
  const repoFilter = scope && scope.ids !== null ? [...scope.ids] : null;

  if (isHistory) {
    const limitRaw = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200)
      : 50;
    const offsetRaw = Number(url.searchParams.get("offset"));
    const offset = Number.isFinite(offsetRaw)
      ? Math.max(Math.trunc(offsetRaw), 0)
      : 0;
    const events = await database.db
      .select({
        taskId: taskEvents.taskId,
        eventType: taskEvents.eventType,
        data: taskEvents.data,
        createdAt: taskEvents.createdAt,
      })
      .from(taskEvents)
      .innerJoin(analysisTasks, eq(taskEvents.taskId, analysisTasks.id))
      .where(
        repoFilter
          ? inArray(analysisTasks.repositoryId, repoFilter)
          : undefined,
      )
      .orderBy(desc(taskEvents.createdAt), desc(taskEvents.id))
      .limit(limit)
      .offset(offset);
    const nextOffset = events.length === limit ? offset + limit : undefined;
    json(
      response,
      200,
      nextOffset === undefined
        ? { events, deliveries: [] }
        : { events, deliveries: [], nextOffset },
      requestId,
    );
    return;
  }

  if (sinceRaw && !Number.isNaN(Date.parse(sinceRaw))) {
    const since = new Date(sinceRaw);
    const events = await database.db
      .select({
        taskId: taskEvents.taskId,
        eventType: taskEvents.eventType,
        data: taskEvents.data,
        createdAt: taskEvents.createdAt,
      })
      .from(taskEvents)
      .innerJoin(analysisTasks, eq(taskEvents.taskId, analysisTasks.id))
      .where(
        and(
          gt(taskEvents.createdAt, since),
          ...(repoFilter
            ? [inArray(analysisTasks.repositoryId, repoFilter)]
            : []),
        ),
      )
      .orderBy(asc(taskEvents.createdAt))
      .limit(500);
    json(response, 200, { events, deliveries: [] }, requestId);
    return;
  }

  const [events, deliveries] = await Promise.all([
    database.db
      .select({
        taskId: taskEvents.taskId,
        eventType: taskEvents.eventType,
        data: taskEvents.data,
        createdAt: taskEvents.createdAt,
      })
      .from(taskEvents)
      .innerJoin(analysisTasks, eq(taskEvents.taskId, analysisTasks.id))
      .where(
        repoFilter
          ? inArray(analysisTasks.repositoryId, repoFilter)
          : undefined,
      )
      .orderBy(desc(taskEvents.createdAt))
      .limit(60),
    database.db
      .select({
        eventName: webhookDeliveries.eventName,
        status: webhookDeliveries.processingStatus,
        outcomeReason: webhookDeliveries.outcomeReason,
        receivedAt: webhookDeliveries.receivedAt,
      })
      .from(webhookDeliveries)
      .orderBy(desc(webhookDeliveries.receivedAt))
      .limit(30),
  ]);
  json(response, 200, { events, deliveries }, requestId);
}

// HTTP 入口与业务放在同一处：新增同类入口只修改本文件。
export const routes = [
  { path: "/logs", methods: ["GET"], handle: handleLogs },
] satisfies readonly HttpRoute[];
