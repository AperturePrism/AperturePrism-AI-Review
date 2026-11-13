/**
 * 标签规则：规则列表、新增、修改和删除。
 * 调用示例：handleLabelRules(request, response, requestId)。
 * HTTP 路径保持兼容；跨文件依赖在下方显式列出。
 */
import { parseJsonObject } from "../utils/http.js";
import type { HttpRoute } from "../utils/routes.js";
import {
  listLabelRules,
  seedDefaultLabelRules,
  LABEL_RULE_PREFIXES,
  upsertLabelRule,
  deleteLabelRule,
} from "../../../../packages/database/src/index.js";
import { audit } from "../identity.js";
import { database, logger } from "../runtime.js";
import { json, readBody } from "../utils/http.js";
import { type IncomingMessage, type ServerResponse } from "node:http";

/** Label rules: list all, or upsert/delete by path. */
export async function handleLabelRules(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (path === "/label-rules" && request.method === "GET") {
    let items = await listLabelRules(database.db);
    // 首次使用自动填充默认常用标签，方便用户直接编辑/启用。
    if (items.length === 0) {
      await seedDefaultLabelRules(database.db);
      items = await listLabelRules(database.db);
    }
    json(response, 200, { items, prefixes: LABEL_RULE_PREFIXES }, requestId);
    return;
  }

  if (path === "/label-rules" && request.method === "PUT") {
    const body = await readBody(request);
    let parsed: { key?: unknown; label?: unknown; enabled?: unknown };
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
    const key = typeof parsed.key === "string" ? parsed.key.trim() : "";
    const label = typeof parsed.label === "string" ? parsed.label.trim() : "";
    const enabled = parsed.enabled !== false;
    if (!key) {
      json(
        response,
        400,
        { status: "error", reason: "rule key required" },
        requestId,
      );
      return;
    }
    try {
      await upsertLabelRule(database.db, { key, label, enabled });
      json(response, 200, { status: "ok", key, label, enabled }, requestId);
    } catch (error) {
      logger.warn({ err: error }, "label rule upsert failed");
      json(
        response,
        500,
        { status: "error", reason: "upsert_failed" },
        requestId,
      );
    }
    return;
  }

  if (path.startsWith("/label-rules/") && request.method === "DELETE") {
    const key = decodeURIComponent(path.slice("/label-rules/".length)).trim();
    if (!key) {
      json(
        response,
        400,
        { status: "error", reason: "rule key required" },
        requestId,
      );
      return;
    }
    const deleted = await deleteLabelRule(database.db, key);
    if (deleted) audit(request, "label_rule.delete", key);
    json(
      response,
      deleted ? 200 : 404,
      { status: deleted ? "ok" : "error" },
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
  { path: "/label-rules", prefix: true, handle: handleLabelRules },
] satisfies readonly HttpRoute[];
