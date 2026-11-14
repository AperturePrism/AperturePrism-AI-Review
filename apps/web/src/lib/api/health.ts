/**
 * 服务健康检查与依赖状态。
 * 本文件保留原有请求路径与返回契约；认证和 GET 缓存由 http.ts 统一提供。
 * @example import { fetchHealth } from './api/health';
 */
import { getJson } from "./http";

export type HealthDependency = {
  name: string;
  status: "ok" | "error";
};

export type ReadyHealth = {
  status: "ok" | "error";
  dependencies: { database: HealthDependency; redis: HealthDependency };
};

export type HealthResult =
  { kind: "live"; status: "ok" } | { kind: "ready"; data: ReadyHealth };

/** Fetches both liveness and readiness; the UI shows a clear error on failure. */
export async function fetchHealth(): Promise<HealthResult> {
  const live = (await getJson("/health/live")) as { status?: string };
  if (live.status !== "ok") throw new Error("liveness check failed");
  const ready = (await getJson("/health/ready")) as ReadyHealth;
  return { kind: "ready", data: ready };
}
