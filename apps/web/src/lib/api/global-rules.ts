/** 全局审核规则的唯一网页写入口；导入只取预览，保存才更新已有规则。 */
import { authHeaders, notifyUnauthorized } from "../auth";
import { bumpCache } from "./http";

export type GlobalRulesSnapshot = {
  content: string;
  contentHash: string;
  updatedAt: string | null;
  canManage: boolean;
  maxChars: number;
  maxBytes: number;
};

export type GlobalRulesPreview = { content: string; sourceUrl: string };

export class GlobalRulesError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GlobalRulesError";
  }
}

async function request<T>(
  method: "GET" | "PUT" | "POST",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...authHeaders(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });
  const value = (await response.json().catch(() => null)) as {
    reason?: string;
    message?: string;
    detail?: string;
    error?: { code?: string; message?: string };
  } | null;
  if (!response.ok) {
    if (response.status === 401) notifyUnauthorized();
    const code = value?.error?.code ?? value?.reason ?? "request_failed";
    const message =
      response.status === 403
        ? "只有管理员可以管理全局审核规则"
        : response.status === 409
          ? "全局规则已被其他人修改。你的草稿已保留，请复制需要的内容后重新加载最新版本再合并。"
          : (value?.detail ??
            value?.error?.message ??
            value?.message ??
            value?.reason ??
            `全局规则请求失败（${response.status}）`);
    throw new GlobalRulesError(response.status, code, message);
  }
  return value as T;
}

export function fetchGlobalRules(
  signal?: AbortSignal,
): Promise<GlobalRulesSnapshot> {
  // 不缓存编辑基线；每次读取都获得与 contentHash 对应的实际内容。
  return request("GET", "/repo-rules/global", undefined, signal);
}

export async function saveGlobalRules(
  content: string,
  expectedContentHash: string,
): Promise<GlobalRulesSnapshot> {
  const saved = await request<GlobalRulesSnapshot>(
    "PUT",
    "/repo-rules/global",
    {
      content,
      expectedContentHash,
    },
  );
  bumpCache();
  return saved;
}

export function previewGlobalRulesUrl(
  url: string,
): Promise<GlobalRulesPreview> {
  return request("POST", "/repo-rules/global/from-url", { url });
}
