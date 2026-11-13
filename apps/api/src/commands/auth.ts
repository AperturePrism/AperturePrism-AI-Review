/**
 * 登录与账号：OAuth、本地密码、个人资料和会话管理。
 * 调用示例：handleAuth(request, response, requestId)。
 * HTTP 路径保持兼容；跨文件依赖在下方显式列出。
 */
import { parseJsonObject } from "../utils/http.js";
import type { HttpRoute } from "../utils/routes.js";
import {
  ensureUser,
  needsPasswordBootstrap,
  getUser,
  updateDisplayName,
  verifyPassword,
  createSession,
  setLastLogin,
  setUserRoles,
  setPassword,
  hashPassword,
  revokeSession,
  revokeUserSessions,
  listUserSessions,
  revokeSessionById,
} from "../../../../packages/database/src/index.js";
import {
  signSession,
  sessionLogin,
  audit,
  SESSION_TTL_MS,
  sessionCookieHeader,
  sessionCookieToken,
  extractBearerOrQueryToken,
  clearSessionCookie,
} from "../identity.js";
import { oauthConfigured, currentOAuth } from "../preferences.js";
import { database } from "../runtime.js";
import { json, readBody, clientIp } from "../utils/http.js";
import { randomUUID } from "node:crypto";
import { type IncomingMessage, type ServerResponse } from "node:http";

// 7 days
/** In-memory OAuth `state` → expiry, verified in the callback. */
const oauthStates = new Map<string, number>();

/**
 * OAuth redirect URI resolution order:
 *  1. explicit OAUTH_REDIRECT_URI env (most reliable — e.g. behind a reverse
 *     proxy that rewrites Host or terminates TLS), then
 *  2. derive from X-Forwarded-Proto + Host for direct/localhost deployments.
 */
function oauthRedirectUri(request: IncomingMessage): string {
  const explicit = process.env.OAUTH_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  const proto =
    request.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  const host = request.headers.host ?? "localhost";
  return `${proto}://${host}/auth/callback`;
}

/** GitHub OAuth entry: /auth/status, /auth/login (redirect), /auth/callback. */
export async function handleAuth(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (path === "/auth/status") {
    json(response, 200, { oauthConfigured: oauthConfigured() }, requestId);
    return;
  }

  if (path === "/auth/login") {
    if (!oauthConfigured()) {
      json(
        response,
        503,
        { status: "error", reason: "oauth_not_configured" },
        requestId,
      );
      return;
    }
    const state = randomUUID();
    oauthStates.set(state, Date.now() + 10 * 60 * 1000);
    const { clientId } = currentOAuth();
    const redirectUri = oauthRedirectUri(request);
    const authorizeUrl =
      `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}` +
      `&scope=read:user&state=${state}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}`;
    response.writeHead(302, { Location: authorizeUrl });
    response.end();
    return;
  }

  if (path === "/auth/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const exp = state ? oauthStates.get(state) : undefined;
    if (!state || exp === undefined || exp < Date.now()) {
      oauthStates.delete(state ?? "");
      response.writeHead(302, { Location: "/#/?oauth_error=bad_state" });
      response.end();
      return;
    }
    oauthStates.delete(state);
    if (!code) {
      response.writeHead(302, { Location: "/#/?oauth_error=missing_code" });
      response.end();
      return;
    }
    try {
      const { clientId, clientSecret } = currentOAuth();
      const tokenRes = await fetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code,
          }),
        },
      );
      const tokenJson = (await tokenRes.json()) as {
        access_token?: string;
        error?: string;
      };
      if (typeof tokenJson.access_token !== "string")
        throw new Error(tokenJson.error ?? "no_access_token");
      const userRes = await fetch("https://api.github.com/user", {
        headers: {
          authorization: `Bearer ${tokenJson.access_token}`,
          "user-agent": "apertureprism",
        },
      });
      const user = (await userRes.json()) as { login?: string };
      if (typeof user.login !== "string") throw new Error("no_login");
      // Persist the recognized user so the personal settings page can address them.
      await ensureUser(database.db, user.login);
      const session = signSession(user.login);
      await createSession(database.db, {
        userLogin: user.login,
        token: session,
        authMethod: "oauth",
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        ...browserFingerprint(request),
      });
      response.writeHead(302, {
        Location: `/#/?token=${encodeURIComponent(session)}`,
      });
      response.end();
    } catch {
      response.writeHead(302, { Location: "/#/?oauth_error=login_failed" });
      response.end();
    }
    return;
  }

  json(response, 404, { status: "error", reason: "not_found" }, requestId);
}

/** Personal settings: GET current user, PUT display name. */
export async function handleAccount(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const login = sessionLogin(request);

  if (request.method === "GET") {
    if (!login) {
      // 未登录：告诉前端是否需要先引导创建本地管理员（无任何本地 admin 时）。
      json(
        response,
        200,
        {
          login: null,
          displayName: null,
          isAdmin: false,
          isReadOnly: false,
          hasPassword: false,
          authMethod: "bearer",
          needsBootstrap: await needsPasswordBootstrap(database.db),
        },
        requestId,
      );
      return;
    }
    const user = await getUser(database.db, login);
    json(
      response,
      200,
      {
        login,
        displayName: user?.displayName ?? "",
        isAdmin: user?.isAdmin === true,
        isReadOnly: user?.isReadOnly === true,
        hasPassword: user?.hasPassword === true,
        authMethod: "oauth",
      },
      requestId,
    );
    return;
  }

  if (request.method === "PUT") {
    if (!login) {
      json(
        response,
        401,
        { status: "error", reason: "oauth login required" },
        requestId,
      );
      return;
    }
    const body = await readBody(request);
    let parsed: { displayName?: unknown };
    try {
      parsed = parseJsonObject(body);
    } catch {
      json(
        response,
        400,
        { status: "error", reason: "invalid JSON" },
        requestId,
      );
      return;
    }
    const displayName =
      typeof parsed.displayName === "string"
        ? parsed.displayName.slice(0, 120)
        : "";
    const user = await updateDisplayName(database.db, login, displayName);
    json(
      response,
      200,
      { status: "ok", login, displayName: user?.displayName ?? "" },
      requestId,
    );
    return;
  }

  json(
    response,
    405,
    { status: "error", reason: "method not allowed" },
    requestId,
  );
}

/**
 * 本地账号密码认证（方向一）。用现有 signSession(login) 签发 bearer 兼容令牌
 * （可过 parseSessionToken / isAuthorized），并落一条 user_sessions 以支持过期、
 * 吊销与会话管控。当前入口：
 *   POST /auth/login               本地用户名/密码登录
 *   POST /auth/register            引导创建首个本地管理员（仅当无本地管理员时）
 *   POST /auth/logout              吊销当前会话
 *   POST /auth/password            改密（仅本地账号；非本地需先设密码）
 *   GET  /auth/sessions            列出本人活跃会话
 *   DELETE /auth/sessions/:id      吊销本人指定会话
 */
const SESSION_UA_MAX = 400;

function browserFingerprint(request: IncomingMessage): {
  userAgent: string | null;
  ip: string | null;
} {
  const ua = request.headers["user-agent"];
  return {
    userAgent: typeof ua === "string" ? ua.slice(0, SESSION_UA_MAX) : null,
    ip: clientIp(request),
  };
}

export async function handleLocalAuth(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = request.method ?? "GET";
  const fp = browserFingerprint(request);
  const now = new Date();

  // POST /auth/login —— 本地密码登录
  if (path === "/auth/login" && method === "POST") {
    const body = await readBody(request);
    let parsed: { username?: unknown; password?: unknown };
    try {
      parsed = parseJsonObject(body);
    } catch {
      json(
        response,
        400,
        { status: "error", reason: "invalid JSON" },
        requestId,
      );
      return;
    }
    const username =
      typeof parsed.username === "string" ? parsed.username.trim() : "";
    const password = typeof parsed.password === "string" ? parsed.password : "";
    if (!username || !password) {
      json(
        response,
        400,
        { status: "error", reason: "username and password required" },
        requestId,
      );
      return;
    }
    const user = await getUser(database.db, username);
    // 统一模糊文案，避免枚举账号是否存在。
    const ok =
      user !== null &&
      user.hasPassword &&
      user.passwordHash !== null &&
      (await verifyPassword(password, user.passwordHash));
    audit(request, ok ? "auth.login" : "auth.login_failed", username, {
      ok,
      ip: fp.ip,
    });
    if (!ok) {
      json(
        response,
        401,
        { status: "error", reason: "invalid_credentials" },
        requestId,
      );
      return;
    }
    // 签发 bearer（HMAC 签名，含 login+exp），并落会话。
    const token = signSession(username);
    await createSession(database.db, {
      userLogin: username,
      token,
      authMethod: "password",
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      ...fp,
    });
    await setLastLogin(database.db, username);
    response.setHeader(
      "set-cookie",
      sessionCookieHeader(token, Math.floor(SESSION_TTL_MS / 1000)),
    );
    json(
      response,
      200,
      {
        status: "ok",
        token,
        user: {
          login: username,
          displayName: user.displayName,
          isAdmin: user.isAdmin,
          isReadOnly: user.isReadOnly,
          hasPassword: true,
        },
      },
      requestId,
    );
    return;
  }

  // POST /auth/register —— 引导创建首个本地管理员（一次性）。
  if (path === "/auth/register" && method === "POST") {
    const needsBootstrap = await needsPasswordBootstrap(database.db);
    if (!needsBootstrap) {
      json(
        response,
        409,
        { status: "error", reason: "bootstrap_already_done" },
        requestId,
      );
      return;
    }
    const body = await readBody(request);
    let parsed: { username?: unknown; password?: unknown };
    try {
      parsed = parseJsonObject(body);
    } catch {
      json(
        response,
        400,
        { status: "error", reason: "invalid JSON" },
        requestId,
      );
      return;
    }
    const username =
      typeof parsed.username === "string" ? parsed.username.trim() : "";
    const password = typeof parsed.password === "string" ? parsed.password : "";
    if (!username || !password || password.length < 8) {
      json(
        response,
        400,
        { status: "error", reason: "password too weak or username empty" },
        requestId,
      );
      return;
    }
    // 首个引导用户：不存在则建，存在则只设密码并保证是 admin。
    const existing = await getUser(database.db, username);
    if (!existing) {
      await ensureUser(database.db, username);
      await setUserRoles(database.db, username, { isAdmin: true });
    } else {
      await setUserRoles(database.db, username, { isAdmin: true });
    }
    await setPassword(database.db, username, await hashPassword(password));
    const token = signSession(username);
    await createSession(database.db, {
      userLogin: username,
      token,
      authMethod: "password",
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      ...fp,
    });
    response.setHeader(
      "set-cookie",
      sessionCookieHeader(token, Math.floor(SESSION_TTL_MS / 1000)),
    );
    audit(request, "auth.bootstrap", username, {});
    json(
      response,
      200,
      {
        status: "ok",
        token,
        user: {
          login: username,
          displayName:
            (await getUser(database.db, username))?.displayName ?? "",
          isAdmin: true,
          isReadOnly: false,
          hasPassword: true,
        },
      },
      requestId,
    );
    return;
  }

  // 以下端点需已登录（本地或 OAuth）。
  const login = sessionLogin(request);
  if (!login) {
    json(
      response,
      401,
      { status: "error", reason: "login required" },
      requestId,
    );
    return;
  }

  // POST /auth/logout —— 吊销当前会话
  if (path === "/auth/logout" && method === "POST") {
    const token =
      sessionCookieToken(request) ?? extractBearerOrQueryToken(request);
    if (token) await revokeSession(database.db, token, now);
    response.setHeader("set-cookie", clearSessionCookie());
    audit(request, "auth.logout", login, {});
    json(response, 200, { status: "ok" }, requestId);
    return;
  }

  // POST /auth/password —— 改密（本地账号）。旧密校验；成功吊销其它会话。
  if (path === "/auth/password" && method === "POST") {
    const body = await readBody(request);
    let parsed: { currentPassword?: unknown; newPassword?: unknown };
    try {
      parsed = parseJsonObject(body);
    } catch {
      json(
        response,
        400,
        { status: "error", reason: "invalid JSON" },
        requestId,
      );
      return;
    }
    const current =
      typeof parsed.currentPassword === "string" ? parsed.currentPassword : "";
    const next =
      typeof parsed.newPassword === "string" ? parsed.newPassword : "";
    const user = await getUser(database.db, login);
    if (!user || !user.hasPassword || user.passwordHash === null) {
      json(
        response,
        409,
        { status: "error", reason: "account has no local password set" },
        requestId,
      );
      return;
    }
    if (!next || next.length < 8) {
      json(
        response,
        400,
        { status: "error", reason: "new password too weak" },
        requestId,
      );
      return;
    }
    const verified = await verifyPassword(current, user.passwordHash);
    if (!verified) {
      audit(request, "auth.change_password_failed", login, {});
      json(
        response,
        401,
        { status: "error", reason: "invalid_credentials" },
        requestId,
      );
      return;
    }
    await setPassword(database.db, login, await hashPassword(next));
    // 吊销本人其它会话（保留当前）。
    const token = extractBearerOrQueryToken(request);
    if (token) await revokeUserSessions(database.db, login, token, now);
    audit(request, "auth.change_password", login, {});
    json(response, 200, { status: "ok" }, requestId);
    return;
  }

  // GET /auth/sessions —— 列出本人活跃会话
  if (path === "/auth/sessions" && method === "GET") {
    const rows = await listUserSessions(database.db, login, now);
    json(
      response,
      200,
      {
        sessions: rows.map((row) => ({
          id: row.id,
          authMethod: row.authMethod,
          issuedAt: row.issuedAt,
          lastSeenAt: row.lastSeenAt,
          userAgent: row.userAgent,
          ip: row.ip,
        })),
      },
      requestId,
    );
    return;
  }

  // DELETE /auth/sessions/:id —— 吊销本人指定会话
  if (path.startsWith("/auth/sessions/") && method === "DELETE") {
    const sessionId = decodeURIComponent(
      path.slice("/auth/sessions/".length),
    ).trim();
    if (!sessionId) {
      json(
        response,
        400,
        { status: "error", reason: "session id required" },
        requestId,
      );
      return;
    }
    const revoked = await revokeSessionById(database.db, sessionId, login, now);
    audit(request, "auth.session_revoke", login, { sessionId, revoked });
    json(
      response,
      revoked ? 200 : 404,
      revoked
        ? { status: "ok" }
        : { status: "error", reason: "session not found" },
      requestId,
    );
    return;
  }

  json(
    response,
    405,
    { status: "error", reason: "method not allowed" },
    requestId,
  );
}

// HTTP 入口与业务放在同一处：新增同类入口只修改本文件。
export const routes = [
  { path: "/auth/status", methods: ["GET"], handle: handleAuth },
  { path: "/auth/login", methods: ["GET"], handle: handleAuth },
  { path: "/auth/login", methods: ["POST"], handle: handleLocalAuth },
  { path: "/auth/callback", methods: ["GET"], handle: handleAuth },
  { path: "/auth/register", handle: handleLocalAuth },
  { path: "/auth/logout", handle: handleLocalAuth },
  { path: "/auth/password", handle: handleLocalAuth },
  { path: "/auth/sessions", prefix: true, handle: handleLocalAuth },
  { path: "/auth/me", handle: handleAccount },
] satisfies readonly HttpRoute[];
