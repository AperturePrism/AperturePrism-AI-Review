/**
 * 在线更新状态、历史与应用流。
 * 本文件保留原有请求路径与返回契约；更新状态与进度绕过 GET 缓存，认证由 http.ts 统一提供。
 * @example import { fetchUpdateStatus } from './api/update';
 */
import { authHeaders, notifyUnauthorized } from "../auth";
import { fetchJson } from "./http";

export type UpdateStatus = {
  current: { version: string; composeProject: string };
  latest: {
    tags: string[];
    version: string | null;
    digest: string | null;
    source?: string;
    stale?: boolean;
  };
  updateAvailable: boolean | null;
  updateChannel: string;
  inProgress?: boolean;
  degraded?: boolean;
};

export type UpdateHistoryEntry = {
  at: string;
  from: string;
  to: string;
  ok: boolean;
  reason?: string;
  id?: string;
  status?: "running" | "pending" | "success" | "failed";
  updatedAt?: string;
};

export type UpdateProgress = {
  items: UpdateHistoryEntry[];
  /** Older APIs omit these fields; missing metadata is not confirmation. */
  currentVersion?: string;
  inProgress?: boolean;
};

/** Online update: current vs latest version comparison (registry check). */
export async function fetchUpdateStatus(signal?: AbortSignal): Promise<UpdateStatus> {
  const response = await fetch("/update/status", {
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: { accept: "application/json", ...authHeaders() },
  });
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (!response.ok) {
    if (response.status === 503)
      throw new Error("暂时无法连接镜像仓库（registry_unreachable）");
    throw new Error(`update status ${response.status}`);
  }
  return (await response.json()) as UpdateStatus;
}

/** Fresh runtime/attempt reconciliation; never use the short-lived GET cache. */
export async function fetchUpdateProgress(signal?: AbortSignal): Promise<UpdateProgress> {
  return (await fetchJson("/update/history", {
    cache: "no-store",
    signal,
  })) as UpdateProgress;
}

/** Online update: recent update history (admin), kept for existing callers. */
export async function fetchUpdateHistory(): Promise<UpdateHistoryEntry[]> {
  return (await fetchUpdateProgress()).items;
}

/**
 * Online update: triggers an update, returning the SSE body stream of log
 * lines (`started` / `log` / `stage` / `done` events). Admin only.
 */
export async function applyUpdate(
  target: string,
  backupBefore: boolean,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array> | null> {
  const response = await fetch("/update/apply", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ target, backupBefore }),
  });
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (response.status === 403) throw new Error("需要管理员权限（403）");
  if (response.status === 409) throw new Error("已有更新任务在运行（409）");
  if (!response.ok) throw new Error(`update apply ${response.status}`);
  return response.body;
}
