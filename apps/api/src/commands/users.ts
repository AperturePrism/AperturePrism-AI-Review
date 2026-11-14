/**
 * 用户管理：角色、仓库授权和审计日志。
 * 调用示例：handleAuditLog(request, response, requestId)。
 * HTTP 路径保持兼容；跨文件依赖在下方显式列出。
 */
import { parseJsonObject } from "../utils/http.js";
import type { HttpRoute } from "../utils/routes.js";
import {
  listAuditLogs,
  listUsers,
  setUserRoles,
  listAllGrants,
  repositories,
  getUser,
  setGrant,
  deleteGrant,
} from "../../../../packages/database/src/index.js";
import { audit, isAdminRequest } from "../identity.js";
import { database, logger } from "../runtime.js";
import { json, readBody } from "../utils/http.js";
import { eq } from "drizzle-orm";
import { type IncomingMessage, type ServerResponse } from "node:http";

/** Security audit trail: GET /audit?limit=&offset= (admin only). */
export async function handleAuditLog(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const limit = Number(url.searchParams.get("limit")) || 50;
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
  try {
    const items = await listAuditLogs(database.db, { limit, offset });
    json(response, 200, { items }, requestId);
  } catch (error) {
    logger.warn({ err: error }, "audit log list failed");
    json(response, 500, { status: "error", reason: "audit_failed" }, requestId);
  }
}

/** User management: list users; PUT /users/:login toggles admin. */
export async function handleUsers(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (path === "/users" && request.method === "GET") {
    const items = await listUsers(database.db);
    json(response, 200, { items }, requestId);
    return;
  }

  if (path.startsWith("/users/") && request.method === "PUT") {
    const login = decodeURIComponent(path.slice("/users/".length)).trim();
    if (!login) {
      json(
        response,
        400,
        { status: "error", reason: "login required" },
        requestId,
      );
      return;
    }
    const body = await readBody(request);
    let parsed: { isAdmin?: unknown; isReadOnly?: unknown };
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
    // 角色位：管理员 / 只读操作员，各自独立、未提供则保持不变。
    const roles: { isAdmin?: boolean; isReadOnly?: boolean } = {};
    if (typeof parsed.isAdmin === "boolean") roles.isAdmin = parsed.isAdmin;
    if (typeof parsed.isReadOnly === "boolean")
      roles.isReadOnly = parsed.isReadOnly;
    const user = await setUserRoles(database.db, login, roles);
    if (!user) {
      json(
        response,
        404,
        { status: "error", reason: "user not found" },
        requestId,
      );
      return;
    }
    // 权限变更是高敏感操作，必须留痕。
    audit(request, "users.update_role", login, {
      isAdmin: roles.isAdmin ?? null,
      isReadOnly: roles.isReadOnly ?? null,
    });
    json(response, 200, { status: "ok", ...user }, requestId);
    return;
  }

  json(
    response,
    405,
    { status: "error", reason: "method not allowed" },
    requestId,
  );
}

/* ---------- 方向七：仓库可见性授权管理（admin） ---------- */
export async function handleGrants(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  if (!(await isAdminRequest(request))) {
    json(
      response,
      403,
      { status: "error", reason: "admin required" },
      requestId,
    );
    return;
  }
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;

  // GET /grants[?user=&repository=]  → 列出授权（可按用户/仓库筛选）
  if (path === "/grants" && request.method === "GET") {
    const user = url.searchParams.get("user")?.trim() || undefined;
    const repository = url.searchParams.get("repository")?.trim() || undefined;
    let grants = await listAllGrants(
      database.db,
      user ? { userLogin: user } : {},
    );
    if (repository) {
      // 找出匹配该仓库（by id 或 full_name owner/name）的 repositoryId 集合。
      const allRepos = await database.db
        .select({
          id: repositories.id,
          owner: repositories.owner,
          name: repositories.name,
        })
        .from(repositories);
      const wanted = new Set<string>();
      for (const row of allRepos) {
        if (
          row.id === repository ||
          `${row.owner}/${row.name}`.toLowerCase() === repository.toLowerCase()
        )
          wanted.add(row.id);
      }
      grants = grants.filter((g) => wanted.has(g.repositoryId));
    }
    json(response, 200, { items: grants }, requestId);
    return;
  }

  // PUT /grants/:user/:repository  → 设/改授权，body { access: 'view' | 'manage' }
  if (path.startsWith("/grants/") && request.method === "PUT") {
    const rest = path.slice("/grants/".length).trim();
    const slash = rest.indexOf("/");
    if (slash <= 0 || slash === rest.length - 1) {
      json(
        response,
        400,
        { status: "error", reason: "bad grant path" },
        requestId,
      );
      return;
    }
    const userLogin = decodeURIComponent(rest.slice(0, slash)).trim();
    const repositoryId = decodeURIComponent(rest.slice(slash + 1)).trim();
    const body = await readBody(request);
    let parsed: { access?: unknown };
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
    const access = parsed.access === "manage" ? "manage" : "view";
    if (!userLogin || !repositoryId) {
      json(
        response,
        400,
        { status: "error", reason: "user and repo required" },
        requestId,
      );
      return;
    }
    // 校验用户与仓库确实存在，避免往授权表写悬空外键。
    const [user, repo] = await Promise.all([
      getUser(database.db, userLogin),
      database.db
        .select({ id: repositories.id })
        .from(repositories)
        .where(eq(repositories.id, repositoryId))
        .limit(1),
    ]);
    if (!user || repo.length === 0) {
      json(
        response,
        404,
        { status: "error", reason: "user or repo not found" },
        requestId,
      );
      return;
    }
    await setGrant(database.db, userLogin, repositoryId, access);
    audit(request, "grants.set", `${userLogin}@${repositoryId}`, { access });
    json(
      response,
      200,
      { status: "ok", userLogin, repositoryId, access },
      requestId,
    );
    return;
  }

  // DELETE /grants/:user/:repository → 移除授权
  if (path.startsWith("/grants/") && request.method === "DELETE") {
    const rest = path.slice("/grants/".length).trim();
    const slash = rest.indexOf("/");
    if (slash <= 0 || slash === rest.length - 1) {
      json(
        response,
        400,
        { status: "error", reason: "bad grant path" },
        requestId,
      );
      return;
    }
    const userLogin = decodeURIComponent(rest.slice(0, slash)).trim();
    const repositoryId = decodeURIComponent(rest.slice(slash + 1)).trim();
    const removed = await deleteGrant(database.db, userLogin, repositoryId);
    if (!removed) {
      json(
        response,
        404,
        { status: "error", reason: "grant not found" },
        requestId,
      );
      return;
    }
    audit(request, "grants.remove", `${userLogin}@${repositoryId}`, {});
    json(response, 200, { status: "ok", removed: true }, requestId);
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
  { path: "/users", prefix: true, admin: true, handle: handleUsers },
  { path: "/audit", methods: ["GET"], admin: true, handle: handleAuditLog },
  { path: "/grants", prefix: true, handle: handleGrants },
] satisfies readonly HttpRoute[];
