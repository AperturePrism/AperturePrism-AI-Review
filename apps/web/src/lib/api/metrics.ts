/**
 * 服务运行指标与告警。
 * 本文件保留原有请求路径与返回契约；认证和 GET 缓存由 http.ts 统一提供。
 * @example import { fetchMetrics } from './api/metrics';
 */
import { getJson } from "./http";

export type MetricsDurationBucket = { count: number; totalMs: number };

export type MetricsSnapshot = {
  counters: Record<string, number>;
  durations: Record<string, MetricsDurationBucket>;
  gauges: Record<string, number>;
  since: string;
};

/** 管理员可见的运行时指标快照（进程计数 + 库内实时量规）。 */
export async function fetchMetrics(): Promise<MetricsSnapshot> {
  return (await getJson("/metrics")) as MetricsSnapshot;
}

export type AlertRecord = {
  id: string;
  severity: "info" | "warning" | "critical";
  message: string;
  status: "active" | "resolved";
  firstAt: string;
  lastAt: string;
  value: number;
};

/** 当前告警状态（active 在前）。 */
export async function fetchAlerts(): Promise<AlertRecord[]> {
  const result = (await getJson("/alerts")) as { items: AlertRecord[] };
  return result.items;
}
