/**
 * 任务实时事件：共享 Redis 传输，按每个连接的仓库授权过滤后发送 SSE。
 * 调用：await startEventStream(); await handleSse(request, response)。
 * task_events 的 (created_at,id) 是稳定补发游标；同一毫秒的事件不会跨页丢失。
 */
import {
  analysisTasks,
  taskEvents,
} from "../../../packages/database/src/index.js";
import {
  serializeSseEvent,
  SSE_HEADERS,
} from "../../../packages/event-stream/src/index.js";
import { and, asc, desc, eq, gt, inArray, or } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAuthorized, visibleRepoScope } from "./identity.js";
import { database, logger, redis } from "./runtime.js";
import { HttpError, UUID_PATTERN } from "./utils/http.js";

export type EventFrame = {
  seq: number;
  type: "task" | "heartbeat";
  data: unknown;
  repositoryId?: string | null;
};
type EventBookmark = { id: string; at: Date };
type StreamClient = {
  request: IncomingMessage;
  scope: Set<string> | null;
  refreshedAt: number;
};

const clients = new Map<ServerResponse, StreamClient>();
const EVENT_CHANNEL = "apertureprism:task:events";
const MAX_CLIENTS = 1000;
let sequence = 0;
let watermark: EventBookmark | null = null;
let eventSubscriber: ReturnType<typeof redis.duplicate> | null = null;
let eventPublisher: ReturnType<typeof redis.duplicate> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let pumpTimer: ReturnType<typeof setInterval> | null = null;
let pumping = false;

/** 来自 Redis 的数据属于外部边界，先校验信封再交给已连接浏览器。 */
export function parseEventFrame(message: string): EventFrame | null {
  try {
    const frame = JSON.parse(message) as Record<string, unknown>;
    if (
      !frame ||
      typeof frame.seq !== "number" ||
      !Number.isSafeInteger(frame.seq) ||
      frame.seq < 0 ||
      (frame.type !== "task" && frame.type !== "heartbeat")
    )
      return null;
    if (
      frame.repositoryId !== undefined &&
      frame.repositoryId !== null &&
      (typeof frame.repositoryId !== "string" ||
        !UUID_PATTERN.test(frame.repositoryId))
    )
      return null;
    return frame as EventFrame;
  } catch {
    return null;
  }
}

/** 未带仓库的旧版本事件只能发送给管理员；受限账号绝不会看到其他仓库数据。 */
export function canReceiveEvent(
  scope: ReadonlySet<string> | null,
  frame: EventFrame,
): boolean {
  return (
    frame.type === "heartbeat" ||
    scope === null ||
    (typeof frame.repositoryId === "string" && scope.has(frame.repositoryId))
  );
}

/** 慢客户端直接断开，由页面重新连接并补发，避免写缓冲在服务端无限增长。 */
function broadcast(frame: EventFrame): void {
  const text = serializeSseEvent(frame);
  for (const [response, client] of clients) {
    if (!canReceiveEvent(client.scope, frame)) continue;
    if (response.destroyed || response.writableEnded) {
      clients.delete(response);
      continue;
    }
    if (!response.write(text) && response.writableLength > 1024 * 1024) {
      clients.delete(response);
      response.end();
    }
  }
}

/** 每分钟刷新连接权限；撤回仓库授权后长期 SSE 连接也会收紧。 */
async function refreshClientScopes(now: number): Promise<void> {
  for (const [response, client] of clients) {
    if (now - client.refreshedAt < 60_000) continue;
    try {
      if (!(await isAuthorized(client.request, true))) {
        clients.delete(response);
        response.end();
        continue;
      }
      const scope = await visibleRepoScope(client.request);
      client.scope = scope?.ids ?? null;
      client.refreshedAt = now;
    } catch (error) {
      clients.delete(response);
      response.end();
      logger.warn(
        { err: error },
        "SSE permission refresh failed; connection closed",
      );
    }
  }
}

/**
 * 建立一个通过主入口鉴权的 SSE 连接；?since=ISO 保留旧客户端的补发方式。
 * 每次补发都联结 analysis_tasks 过滤仓库，权限限制同时覆盖历史与实时事件。
 */
export async function handleSse(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (clients.size >= MAX_CLIENTS)
    throw new HttpError(503, "too many event stream connections");
  const url = new URL(request.url ?? "/", "http://localhost");
  const sinceRaw = url.searchParams.get("since");
  const since = sinceRaw ? new Date(sinceRaw) : null;
  if (since && !Number.isFinite(since.getTime()))
    throw new HttpError(400, "since must be an ISO timestamp");
  const scope = await visibleRepoScope(request);
  response.writeHead(200, SSE_HEADERS);
  response.write(": connected\n\n");
  if (since) {
    try {
      const rows = await database.db
        .select({
          id: taskEvents.id,
          taskId: taskEvents.taskId,
          eventType: taskEvents.eventType,
          data: taskEvents.data,
          createdAt: taskEvents.createdAt,
          repositoryId: analysisTasks.repositoryId,
        })
        .from(taskEvents)
        .innerJoin(analysisTasks, eq(analysisTasks.id, taskEvents.taskId))
        .where(
          and(
            gt(taskEvents.createdAt, since),
            scope?.ids !== null && scope?.ids !== undefined
              ? inArray(analysisTasks.repositoryId, [...scope.ids])
              : undefined,
          ),
        )
        .orderBy(asc(taskEvents.createdAt), asc(taskEvents.id))
        .limit(500);
      for (const row of rows) {
        sequence += 1;
        response.write(
          serializeSseEvent({
            seq: sequence,
            type: "task",
            data: {
              taskId: row.taskId,
              eventType: row.eventType,
              data: row.data,
              createdAt: row.createdAt,
              replayed: true,
            },
          }),
        );
      }
      logger.debug(
        { replayed: rows.length, since: sinceRaw },
        "SSE replay sent",
      );
    } catch (error) {
      logger.warn({ err: error }, "SSE replay failed; going live");
    }
  }
  if (response.destroyed || response.writableEnded) return;
  clients.set(response, {
    request,
    scope: scope?.ids ?? null,
    refreshedAt: Date.now(),
  });
  response.once("close", () => clients.delete(response));
}

/** Redis 或数据库暂不可用时保留健康探针与心跳，调用方可以看到依赖就绪状态。 */
export async function startEventStream(): Promise<void> {
  let relay = false;
  try {
    eventSubscriber = redis.duplicate();
    eventSubscriber.on("error", () => undefined);
    eventSubscriber.on("message", (_channel, message) => {
      const frame = parseEventFrame(message);
      if (frame) broadcast(frame);
    });
    await eventSubscriber.connect();
    await eventSubscriber.subscribe(EVENT_CHANNEL);
    eventPublisher = redis.duplicate();
    eventPublisher.on("error", () => undefined);
    await eventPublisher.connect();
    relay = true;
  } catch (error) {
    logger.warn({ err: error }, "event relay disabled: Redis unavailable");
    eventSubscriber?.disconnect();
    eventPublisher?.disconnect();
    eventSubscriber = null;
    eventPublisher = null;
  }
  try {
    const [last] = await database.db
      .select({ id: taskEvents.id, at: taskEvents.createdAt })
      .from(taskEvents)
      .orderBy(desc(taskEvents.createdAt), desc(taskEvents.id))
      .limit(1);
    watermark = last ?? null;
  } catch {
    watermark = null;
  }
  heartbeatTimer = setInterval(() => {
    void refreshClientScopes(Date.now())
      .then(() => {
        sequence += 1;
        broadcast({
          seq: sequence,
          type: "heartbeat",
          data: { at: new Date().toISOString() },
        });
      })
      .catch((error: unknown) =>
        logger.warn({ err: error }, "SSE heartbeat failed"),
      );
  }, 15_000);
  if (relay)
    pumpTimer = setInterval(() => {
      void pumpTaskEvents().catch((error: unknown) =>
        logger.warn({ err: error }, "task event pump failed"),
      );
    }, 1_000);
}

/** 同一进程只有一轮读取在途；数据库慢时不叠加新的轮询或重复发送。 */
async function pumpTaskEvents(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    const rows = await database.db
      .select({
        id: taskEvents.id,
        taskId: taskEvents.taskId,
        eventType: taskEvents.eventType,
        data: taskEvents.data,
        createdAt: taskEvents.createdAt,
        repositoryId: analysisTasks.repositoryId,
      })
      .from(taskEvents)
      .innerJoin(analysisTasks, eq(analysisTasks.id, taskEvents.taskId))
      .where(
        watermark
          ? or(
              gt(taskEvents.createdAt, watermark.at),
              and(
                eq(taskEvents.createdAt, watermark.at),
                gt(taskEvents.id, watermark.id),
              ),
            )
          : undefined,
      )
      .orderBy(asc(taskEvents.createdAt), asc(taskEvents.id))
      .limit(200);
    for (const row of rows) {
      sequence += 1;
      const frame: EventFrame = {
        seq: sequence,
        type: "task",
        repositoryId: row.repositoryId,
        data: {
          taskId: row.taskId,
          eventType: row.eventType,
          data: row.data,
          createdAt: row.createdAt,
        },
      };
      if (eventPublisher)
        await eventPublisher.publish(EVENT_CHANNEL, JSON.stringify(frame));
      watermark = { id: row.id, at: row.createdAt };
    }
  } finally {
    pumping = false;
  }
}

/** 关闭所有计时器和长连接，再释放 Redis 资源。 */
export async function stopEventStream(): Promise<void> {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (pumpTimer) clearInterval(pumpTimer);
  heartbeatTimer = null;
  pumpTimer = null;
  for (const response of clients.keys()) response.end();
  clients.clear();
  if (eventSubscriber) {
    try {
      await eventSubscriber.unsubscribe(EVENT_CHANNEL);
      await eventSubscriber.quit();
    } catch {
      eventSubscriber.disconnect();
    }
  }
  if (eventPublisher) {
    try {
      await eventPublisher.quit();
    } catch {
      eventPublisher.disconnect();
    }
  }
  eventSubscriber = null;
  eventPublisher = null;
}
