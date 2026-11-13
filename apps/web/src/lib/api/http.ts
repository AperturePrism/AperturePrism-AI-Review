/**
 * HTTP 请求与 GET 缓存的唯一持有者。
 * 现有主体共享此缓存；凭据切换、写操作和 TTL 都会使旧响应失效。
 * @example import { bumpCache } from './api/http';
 */
import { authHeaders, notifyUnauthorized } from "../auth";

/* ---------- 短期 GET 缓存（改善切页/轮询的响应体感） ----------
   只缓存只读 GET，5s 后自动失效；显式"刷新/写操作"调用 bumpCache()
   递增版本号，使下一个请求绕过缓存拿到最新数据。 */
const CACHE_TTL_MS = 5_000;

let cacheVersion = 0;
let cachedAuthorization = "";
const pendingResponses = new Map<string, Promise<unknown>>();
const MAX_CACHED_RESPONSES = 100;

const responseCache = new Map<string, { at: number; data: unknown }>();

/** 使下一次请求绕过缓存（页面"刷新"按钮、写操作后调用）。 */
export function bumpCache(): void {
  cacheVersion += 1;
  // 写操作后旧缓存全部失效：直接清空比等 5s TTL 过期更干净，
  // 也避免旧版本键位（cacheKey 带版本号）残留为孤儿条目占用内存。
  responseCache.clear();
  pendingResponses.clear();
}

function cacheKey(url: string): string {
  return `${cacheVersion}|${url}`;
}

/** 同一个认证范围内合并并发 GET；新用户绝不复用上一位用户的响应。 */
export async function getJson(url: string): Promise<unknown> {
  const authorization = authHeaders().authorization ?? ""; // 当前登录身份只用于隔离缓存。
  if (authorization !== cachedAuthorization) {
    bumpCache(); // 切换账号和退出登录均需要立刻作废旧数据。
    cachedAuthorization = authorization;
  }
  const key = cacheKey(url);
  const hit = responseCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const pending = pendingResponses.get(key);
  if (pending) return pending; // 多个页面同时轮询不会重复访问同一端点。
  const requestedVersion = cacheVersion;
  const request = fetchJson(url)
    .then((data) => {
      // 写操作或账号变化后，晚到的旧响应不能回填新身份的缓存。
      if (
        requestedVersion !== cacheVersion ||
        authorization !== (authHeaders().authorization ?? "")
      )
        return data;
      responseCache.set(key, { at: Date.now(), data });
      while (responseCache.size > MAX_CACHED_RESPONSES) {
        const oldest = responseCache.keys().next().value;
        if (oldest !== undefined) responseCache.delete(oldest); // 保留有界缓存，URL 很多时也不会无界增长。
      }
      return data;
    })
    .finally(() => {
      if (pendingResponses.get(key) === request) pendingResponses.delete(key);
    });
  pendingResponses.set(key, request);
  return request;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { accept: "application/json", ...authHeaders() },
  });
  if (response.status === 401) {
    // 令牌失效：通知应用回到登录页（密码门禁）。仅顶层一次，避免重复触发。
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (!response.ok) {
    const reason =
      response.status === 404
        ? "not found"
        : `request failed with ${response.status}`;
    throw new Error(reason);
  }
  return response.json();
}

/** POST to a public setup config endpoint; surfaces a readable error. */
export async function postSetup(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as {
    reason?: string;
    hint?: string;
    httpStatus?: number;
    endpoint?: string;
    detail?: string;
  };
  if (!response.ok) {
    if (!data.reason) throw new Error(`request failed with ${response.status}`);
    // 带上上游状态码、实际请求的端点与返回正文：这些才是用户判断
    // 「密钥无效 / 余额不足 / 地址不对」的依据，丢掉就只剩一个错误码。
    const parts = [data.reason];
    if (data.hint) parts.push(`— ${data.hint}`);
    const extras: string[] = [];
    if (data.httpStatus) extras.push(`上游状态 ${data.httpStatus}`);
    if (data.endpoint) extras.push(`请求 ${data.endpoint}`);
    if (data.detail) extras.push(`返回 ${data.detail}`);
    if (extras.length > 0) parts.push(`（${extras.join("；")}）`);
    throw new Error(parts.join(" "));
  }
  return data;
}
