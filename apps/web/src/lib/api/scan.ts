/**
 * 仓库扫描配置与运行历史。
 * 本文件保留原有请求路径与返回契约；认证和 GET 缓存由 http.ts 统一提供。
 * @example import { fetchScansConfig } from './api/scan';
 */
import { authHeaders, notifyUnauthorized } from "../auth";
import { bumpCache, getJson } from "./http";

/* ---------- repository scanning (scan-worker) ---------- */

export type ScanConfigItem = {
  repositoryId: string;
  owner: string;
  name: string;
  fullName: string;
  installed: boolean;
  enabled: boolean;
  intervalMinutes: number;
  maxIssues: number;
  maxPrs: number;
  autoAnalyzeIssues: boolean;
  autoAnalyzePrs: boolean;
  createTrackingIssues: boolean;
  updatedAt: string | null;
};

export type ScansConfig = {
  enabled: boolean;
  items: ScanConfigItem[];
};

export type ScanRun = {
  id: string;
  repositoryId: string | null;
  repositoryFullName: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "completed" | "failed";
  trigger: "scheduled" | "manual";
  scannedIssues: number;
  scannedPrs: number;
  createdIssueTasks: number;
  createdPrTasks: number;
  createdTrackingIssues: number;
  skipped: number;
  error: string | null;
};

export type ScanRunsResult = {
  items: ScanRun[];
  nextOffset?: number;
};

/** Global scan switch + per-repository effective scan configs. */
export async function fetchScansConfig(): Promise<ScansConfig> {
  return (await getJson("/scans/config")) as ScansConfig;
}

/** Updates the global scan switch, or one repository's scan config (admin). */
export async function saveScansConfig(
  input: Partial<ScanConfigItem> & { repositoryId?: string; enabled?: boolean },
): Promise<void> {
  const response = await fetch("/scans/config", {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (response.status === 403) throw new Error("需要管理员权限（403）");
  if (!response.ok) throw new Error(`save scan config ${response.status}`);
  bumpCache();
}

/** Requests an immediate scan pass (scan-worker picks it up on next loop). */
export async function triggerScan(): Promise<void> {
  const response = await fetch("/scans/run", {
    method: "POST",
    headers: { accept: "application/json", ...authHeaders() },
  });
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (response.status === 403) throw new Error("需要管理员权限（403）");
  if (!response.ok) throw new Error(`trigger scan ${response.status}`);
  bumpCache();
}

/** Scan run history, newest first, offset-paginated. */
export async function fetchScanRuns(
  offset?: number,
  limit = 50,
): Promise<ScanRunsResult> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (offset !== undefined) params.set("offset", String(offset));
  return (await getJson(`/scans/runs?${params.toString()}`)) as ScanRunsResult;
}
