/**
 * 仓库记忆：查询、手工记录、整理与删除。
 * 调用示例：handleMemory(request, response, requestId)。
 * HTTP 路径保持兼容；跨文件依赖在下方显式列出。
 */
import { parseJsonObject } from "../utils/http.js";
import type { HttpRoute } from "../utils/routes.js";
import {
  listRepoMemory,
  writeRepoMemory,
  deleteRepoMemory,
} from "../../../../packages/database/src/index.js";
import { memoryConsolidationSweep } from "../../../scheduler/src/consolidation.js";
import { isAdminRequest, audit } from "../identity.js";
import { database, logger } from "../runtime.js";
import { json, readBody, UUID_PATTERN } from "../utils/http.js";
import { type IncomingMessage, type ServerResponse } from "node:http";

/**
 * Repository memory management:
 *  - GET /memory: list (any authenticated user), filterable by repositoryId /
 *    kind, offset-paginated; always returns per-kind counts for the UI cards.
 *  - POST /memory: admin, create a manual rule/knowledge entry (issue #32);
 *    consolidated=true so it is immediately part of the analysis context.
 *  - POST /memory/consolidate: admin, runs one memory-consolidation sweep.
 *  - DELETE /memory/:id: admin, removes a single memory row.
 */
export async function handleMemory(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  const path = url.pathname;

  if (path === "/memory" && request.method === "GET") {
    const repositoryId =
      url.searchParams.get("repositoryId")?.trim() || undefined;
    const kindRaw = url.searchParams.get("kind");
    const kind =
      kindRaw === "reflection" || kindRaw === "rule" || kindRaw === "knowledge"
        ? kindRaw
        : undefined;
    const limitRaw = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200)
      : 50;
    const offsetRaw = Number(url.searchParams.get("offset"));
    const offset = Number.isFinite(offsetRaw)
      ? Math.max(Math.trunc(offsetRaw), 0)
      : 0;
    try {
      const [items, countsRows] = await Promise.all([
        listRepoMemory(database.db, { repositoryId, kind, limit, offset }),
        database.sql<{ kind: string; c: number }[]>`
          SELECT kind, count(*)::int AS c FROM repo_memory GROUP BY kind
        `,
      ]);
      const counts: Record<string, number> = {
        reflection: 0,
        rule: 0,
        knowledge: 0,
      };
      for (const row of countsRows) {
        if (row.kind === "reflection") counts.reflection = Number(row.c);
        else if (row.kind === "rule") counts.rule = Number(row.c);
        else if (row.kind === "knowledge") counts.knowledge = Number(row.c);
      }
      const nextOffset = items.length === limit ? offset + limit : undefined;
      json(
        response,
        200,
        nextOffset === undefined
          ? { items, counts }
          : { items, counts, nextOffset },
        requestId,
      );
    } catch (error) {
      logger.warn({ err: error }, "memory list failed");
      json(
        response,
        500,
        { status: "error", reason: "memory_failed" },
        requestId,
      );
    }
    return;
  }

  if (path === "/memory" && request.method === "POST") {
    if (!(await isAdminRequest(request))) {
      json(
        response,
        403,
        { status: "error", reason: "admin required" },
        requestId,
      );
      return;
    }
    const body = await readBody(request);
    let parsed: {
      kind?: unknown;
      title?: unknown;
      content?: unknown;
      repositoryId?: unknown;
    };
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
    const kind = parsed.kind;
    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    const content =
      typeof parsed.content === "string" ? parsed.content.trim() : "";
    const repositoryId =
      typeof parsed.repositoryId === "string" &&
      parsed.repositoryId.trim().length > 0
        ? parsed.repositoryId.trim()
        : undefined;
    // 手动写入只允许 rule / knowledge：reflection 是自动沉淀的，不允许人工伪装。
    if (kind !== "rule" && kind !== "knowledge") {
      json(
        response,
        400,
        { status: "error", reason: "kind must be rule or knowledge" },
        requestId,
      );
      return;
    }
    if (!title || !content) {
      json(
        response,
        400,
        { status: "error", reason: "title and content required" },
        requestId,
      );
      return;
    }
    if (repositoryId && !UUID_PATTERN.test(repositoryId)) {
      json(
        response,
        400,
        { status: "error", reason: "invalid repositoryId" },
        requestId,
      );
      return;
    }
    try {
      // consolidated=true：手动规则/知识立即进入分析上下文（issue #32）。
      await writeRepoMemory(database.db, {
        repositoryId,
        kind,
        title,
        content,
        sourceType: "manual",
        consolidated: true,
      });
      audit(request, "memory.create", undefined, {
        kind,
        title,
        repositoryId: repositoryId ?? null,
      });
      json(response, 200, { status: "ok" }, requestId);
    } catch (error) {
      logger.warn({ err: error }, "memory create failed");
      json(
        response,
        500,
        { status: "error", reason: "memory_failed" },
        requestId,
      );
    }
    return;
  }

  if (path === "/memory/consolidate" && request.method === "POST") {
    if (!(await isAdminRequest(request))) {
      json(
        response,
        403,
        { status: "error", reason: "admin required" },
        requestId,
      );
      return;
    }
    try {
      const result = await memoryConsolidationSweep(database, logger);
      audit(request, "memory.consolidate", undefined, {
        repositories: result.repositories,
        rules: result.rules,
      });
      json(response, 200, { status: "ok", ...result }, requestId);
    } catch (error) {
      logger.warn({ err: error }, "memory consolidation failed");
      json(
        response,
        500,
        { status: "error", reason: "consolidate_failed" },
        requestId,
      );
    }
    return;
  }

  if (path.startsWith("/memory/") && request.method === "DELETE") {
    if (!(await isAdminRequest(request))) {
      json(
        response,
        403,
        { status: "error", reason: "admin required" },
        requestId,
      );
      return;
    }
    const id = decodeURIComponent(path.slice("/memory/".length)).trim();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    ) {
      json(
        response,
        400,
        { status: "error", reason: "invalid memory id" },
        requestId,
      );
      return;
    }
    try {
      const deleted = await deleteRepoMemory(database.db, id);
      if (deleted) audit(request, "memory.delete", id);
      json(
        response,
        deleted ? 200 : 404,
        { status: deleted ? "ok" : "error" },
        requestId,
      );
    } catch (error) {
      logger.warn({ err: error }, "memory delete failed");
      json(
        response,
        500,
        { status: "error", reason: "delete_failed" },
        requestId,
      );
    }
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
  { path: "/memory", prefix: true, handle: handleMemory },
] satisfies readonly HttpRoute[];
