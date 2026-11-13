/**
 * 身份与仓库权限：所有业务路由共用同一份身份判断。
 * 调用示例：await canAccessRepo(request, repositoryId, "manage")。
 * HTTP 路径保持兼容；跨文件依赖在下方显式列出。
 */
import {
  getUser,
  findValidSession,
  listGrantsForUser,
  repositories,
  canAccessGrant,
  writeAuditLog,
} from "../../../packages/database/src/index.js";
import { currentOAuth, webuiToken } from "./preferences.js";
import { config, database, logger } from "./runtime.js";
import { createSessionSigner } from "./session.js";
import { clientIp } from "./utils/http.js";
import { inArray } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import { type IncomingMessage } from "node:http";

/* ---------- GitHub OAuth (progressive; enabled when configured) ---------- */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 密码登录与 OAuth 共用签名配置；纯本地部署使用已有主密钥或管理令牌。 */
function sessionSigner() {
  const { clientId, clientSecret } = currentOAuth();
  return createSessionSigner({
    clientId: clientId || "apertureprism-local",
    clientSecret: clientSecret || config.credentialMasterKey || webuiToken(),
    ttlMs: SESSION_TTL_MS,
  });
}

export function signSession(login: string): string {
  return sessionSigner().sign(login);
}

function parseSessionToken(token: string): string | null {
  return sessionSigner().parse(token);
}

/** Auth is disabled when no WebUI token is configured (open dev / intranet mode). */
const authorizationResults = new WeakMap<IncomingMessage, Promise<boolean>>();

/** 签名和持久会话同时有效才允许请求；同一请求内复用查询结果，长连接可强制刷新。 */
export async function isAuthorized(
  request: IncomingMessage,
  refresh = false,
): Promise<boolean> {
  if (!refresh) {
    const cached = authorizationResults.get(request);
    if (cached) return cached;
  }
  const result = checkAuthorization(request);
  authorizationResults.set(request, result);
  return result;
}

async function checkAuthorization(request: IncomingMessage): Promise<boolean> {
  const expected = webuiToken();
  if (!expected) return true;
  const token = extractBearerOrQueryToken(request); // 鉴权与角色识别使用完全相同的凭据来源。
  if (token === null || token.length === 0) return false;
  const actualBytes = Buffer.from(token);
  const expectedBytes = Buffer.from(expected);
  if (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  )
    return true;
  const login = parseSessionToken(token);
  if (!login) return false;
  const session = await findValidSession(database.db, token);
  return session?.userLogin === login; // 吊销、过期或未落库的签名都不能继续使用。
}

/** HttpOnly 会话 cookie 名（方向四A）：把签名 token 放 cookie，前端 JS 不可读。 */
const SESSION_COOKIE = "__ap_session";

/** 从 Cookie 头解析会话 token（URL 编码处理）。 */
export function sessionCookieToken(request: IncomingMessage): string | null {
  const header = request.headers.cookie;
  if (typeof header !== "string" || header.length === 0) return null;
  for (const part of header.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const name = part.slice(0, eqIdx).trim();
    if (name === SESSION_COOKIE) {
      try {
        return decodeURIComponent(part.slice(eqIdx + 1).trim()) || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Set-Cookie 片段：HttpOnly + SameSite=Strict；生产（经 https）追加 Secure。 */
export function sessionCookieHeader(
  token: string,
  maxAgeSeconds: number,
): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return (
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; ` +
    `SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`
  );
}

/** 清空会话 cookie（登出时）。 */
export function clearSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${secure}`;
}

/** Login of the current signed session (cookie or Authorization header), if any. */
export function sessionLogin(request: IncomingMessage): string | null {
  const token = extractBearerOrQueryToken(request);
  return token ? parseSessionToken(token) : null;
}

export function extractBearerOrQueryToken(
  request: IncomingMessage,
): string | null {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer "))
    return header.slice(7);
  const url = new URL(request.url ?? "/", "http://localhost");
  const query = url.searchParams.get("token");
  if (query) return query;
  return sessionCookieToken(request);
}

/**
 * Admin check for the current request. A valid OAuth/password session is admin
 * only when the persisted user has `is_admin`; a shared WebUI bearer-token
 * request (matching webuiToken) is treated as admin.
 */
export async function isAdminRequest(
  request: IncomingMessage,
): Promise<boolean> {
  if (!(await isAuthorized(request))) return false; // 管理员检查本身不能把匿名请求当作 bearer。
  const login = sessionLogin(request);
  if (!login) return true;
  const user = await getUser(database.db, login);
  return user?.isAdmin === true;
}

/**
 * 只读操作员判定（OAuth 用户）。Bearer token 是管理员凭据，永不视为只读。
 * 只读用户可登录查看，但一切写操作都会被全局拦截。
 */
export async function isReadOnlyRequest(
  request: IncomingMessage,
): Promise<boolean> {
  const login = sessionLogin(request);
  if (!login) return false;
  const user = await getUser(database.db, login);
  return user?.isReadOnly === true;
}

/**
 * 方向七：仓库可见性授权作用域。
 * 返回 `null` 表示"全部仓库可见/可管"（admin 或匿名开放模式）；否则返回当前用户
 * 被授权的一组仓库 id 与 full_name。列表型 handler 用它过滤展示行。
 */
export async function visibleRepoScope(
  request: IncomingMessage,
): Promise<{ ids: Set<string> | null; fullNames: Set<string> | null } | null> {
  const login = sessionLogin(request);
  if (!login) return null; // bearer/open 模式：全可见
  const user = await getUser(database.db, login);
  if (user?.isAdmin === true) return null; // admin 兜底全可见
  const grants = await listGrantsForUser(database.db, login);
  if (grants.length === 0) return { ids: new Set(), fullNames: new Set() };
  const ids = new Set<string>();
  const fullNames = new Set<string>();
  const repoRows = await database.db
    .select({
      id: repositories.id,
      owner: repositories.owner,
      name: repositories.name,
    })
    .from(repositories)
    .where(
      inArray(repositories.id, [...new Set(grants.map((g) => g.repositoryId))]),
    );
  for (const row of repoRows) {
    ids.add(row.id);
    fullNames.add(`${row.owner}/${row.name}`);
  }
  return { ids, fullNames };
}

/** admin → 全放行；否则校验仓库授权是否满足指定等级（view 或 manage）。 */
export async function canAccessRepo(
  request: IncomingMessage,
  repositoryId: string,
  need: "view" | "manage",
): Promise<boolean> {
  const login = sessionLogin(request);
  if (!login) return true; // 开放/bearer 模式放行
  const user = await getUser(database.db, login);
  if (user?.isAdmin === true) return true;
  return canAccessGrant(database.db, login, repositoryId, need);
}

/**
 * Best-effort security audit entry. Never blocks the operation it records;
 * a write failure is logged and swallowed.
 */
export function audit(
  request: IncomingMessage,
  action: string,
  target?: string,
  detail?: Record<string, unknown>,
): void {
  const login = sessionLogin(request);
  const entry: {
    actor: string;
    action: string;
    target?: string | undefined;
    detail?: Record<string, unknown> | undefined;
    ip?: string | undefined;
  } = { actor: login ?? "bearer", action, ip: clientIp(request) };
  if (target !== undefined) entry.target = target;
  if (detail !== undefined) entry.detail = detail;
  void writeAuditLog(database.db, entry).catch((error: unknown) =>
    logger.warn({ err: error, action }, "audit log write failed"),
  );
}
