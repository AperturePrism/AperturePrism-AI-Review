/**
 * 在线更新状态、历史与应用流。
 * 本文件保留原有请求路径与返回契约；认证和 GET 缓存由 http.ts 统一提供。
 * @example import { fetchUpdateStatus } from './api/update';
 */
import { authHeaders, notifyUnauthorized } from "../auth";
import { getJson } from "./http";

export type UpdateStatus = {
  current: { version: string; composeProject: string };
  latest: { tags: string[]; version: string | null; digest: string | null };
  updateAvailable: boolean;
  updateChannel: string;
  inProgress?: boolean;
};

export type UpdateHistoryEntry = {
  at: string;
  from: string;
  to: string;
  ok: boolean;
  reason?: string;
};

/** Online update: current vs latest version comparison (registry check). */
export async function fetchUpdateStatus(): Promise<UpdateStatus> {
  const response = await fetch("/update/status", {
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

/** Online update: recent update history (admin). */
export async function fetchUpdateHistory(): Promise<UpdateHistoryEntry[]> {
  const result = (await getJson("/update/history")) as {
    items: UpdateHistoryEntry[];
  };
  return result.items;
}

/**
 * Online update: triggers an update, returning the SSE body stream of log
 * lines (`log` / `done` events). Admin only.
 */
export async function applyUpdate(
  target: string,
  backupBefore: boolean,
): Promise<ReadableStream<Uint8Array> | null> {
  const response = await fetch("/update/apply", {
    method: "POST",
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
