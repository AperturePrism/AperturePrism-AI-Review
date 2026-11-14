/**
 * 控制台任务与仓库概况。
 * 本文件保留原有请求路径与返回契约；认证和 GET 缓存由 http.ts 统一提供。
 * @example import { STATUS_ORDER } from './api/overview';
 */
import { getJson } from "./http";

export type Summary = {
  tasks: {
    total: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
  };
  results: { issue: number; pr: number };
};

export const STATUS_ORDER = [
  "running",
  "queued",
  "publishing",
  "completed",
  "failed",
  "retry_wait",
  "canceled",
] as const;

/** Aggregated task + result counts for the overview KPIs. */
export async function fetchSummary(): Promise<Summary> {
  return (await getJson("/summary")) as Summary;
}
