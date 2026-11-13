/**
 * QQ 机器人启停与状态。
 * 本文件保留原有请求路径与返回契约；认证和 GET 缓存由 http.ts 统一提供。
 * @example import { fetchBotStatus } from './api/bot';
 */
import { authHeaders, notifyUnauthorized } from "../auth";
import { getJson } from "./http";

/* ---------- qq-bot lifecycle (container start/stop) ---------- */

export type BotStatus = {
  status: "running" | "exited" | "absent" | "unknown";
  ok: boolean;
};

export type BotActionResult = {
  status: string;
  detail?: string;
  code?: number | null;
};

/** GET /bot/status — qq-bot 容器运行状态（管理员）。 */
export async function fetchBotStatus(): Promise<BotStatus> {
  return (await getJson("/bot/status")) as BotStatus;
}

async function botAction(action: "start" | "stop"): Promise<BotActionResult> {
  const response = await fetch(`/bot/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
  });
  const text = await response.text();
  let parsed: {
    status?: string;
    reason?: string;
    detail?: string;
    code?: number | null;
  } = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // keep default
  }
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (response.status === 403) throw new Error("需要管理员权限（403）");
  if (!response.ok) {
    throw new Error(
      parsed.detail || parsed.reason || `bot ${action} ${response.status}`,
    );
  }
  return {
    status: parsed.status ?? "ok",
    detail: parsed.detail,
    code: parsed.code,
  };
}

/** POST /bot/start — 启动 qq-bot 容器（管理员）。 */
export async function startBot(): Promise<BotActionResult> {
  return botAction("start");
}

/** POST /bot/stop — 停止 qq-bot 容器（管理员）。 */
export async function stopBot(): Promise<BotActionResult> {
  return botAction("stop");
}
