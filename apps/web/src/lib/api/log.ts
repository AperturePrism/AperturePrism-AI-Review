/**
 * 任务历史日志与事件回放。
 * 本文件保留原有请求路径与返回契约；认证和 GET 缓存由 http.ts 统一提供。
 * @example import { fetchLogs } from './api/log';
 */
import { getJson } from "./http";

export type LogEvent = {
  taskId: string;
  eventType: string;
  data: unknown;
  createdAt: string;
};

export type DeliveryEntry = {
  eventName: string;
  status: string;
  outcomeReason: string | null;
  receivedAt: string;
};

export type AuditLog = { events: LogEvent[]; deliveries: DeliveryEntry[] };

export type HistoryPage = {
  events: LogEvent[];
  deliveries: DeliveryEntry[];
  nextOffset?: number;
};

/** Diagnostic bundle: recent events + webhook deliveries. */
export async function fetchLogs(): Promise<AuditLog> {
  return (await getJson("/logs")) as AuditLog;
}

/** Offset-paginated historical task events (newest first). */
export async function fetchLogHistory(
  offset: number,
  limit = 50,
): Promise<HistoryPage> {
  return (await getJson(
    `/logs?history=1&offset=${offset}&limit=${limit}`,
  )) as HistoryPage;
}

/** Events created after a bookmark (resume-from-breakpoint). */
export async function fetchLogsSince(since: string): Promise<AuditLog> {
  return (await getJson(
    `/logs?since=${encodeURIComponent(since)}`,
  )) as AuditLog;
}
