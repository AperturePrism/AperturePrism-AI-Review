/**
 * 备份：导出和恢复已有数据库快照。
 * 调用示例：handleBackupExport(request, response, requestId)。
 * HTTP 路径保持兼容；跨文件依赖在下方显式列出。
 */
import type { HttpRoute } from "../utils/routes.js";
import {
  buildBackupSnapshot,
  applyBackupSnapshot,
} from "../../../../packages/database/src/index.js";
import { audit } from "../identity.js";
import { database, logger } from "../runtime.js";
import { json, readBody } from "../utils/http.js";
import { type IncomingMessage, type ServerResponse } from "node:http";

/** Config backup: exports settings + policies (secrets masked, no keys). */
export async function handleBackupExport(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  try {
    const snapshot = await buildBackupSnapshot(database.db);
    audit(request, "backup.export");
    json(response, 200, snapshot, requestId);
  } catch (error) {
    logger.warn({ err: error }, "backup export failed");
    json(
      response,
      500,
      { status: "error", reason: "export_failed" },
      requestId,
    );
  }
}

/** Config restore: applies non-secret settings + policies from a snapshot. */
export async function handleBackupImport(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const body = await readBody(request);
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(body.toString("utf8"));
  } catch {
    json(response, 400, { status: "error", reason: "invalid JSON" }, requestId);
    return;
  }
  try {
    const result = await applyBackupSnapshot(database.db, snapshot);
    // 导入会批量改写设置与策略，属敏感操作，留痕。
    audit(request, "backup.import", undefined, {
      settings: result.settings,
      policies: result.policies,
    });
    json(response, 200, { status: "ok", ...result }, requestId);
  } catch (error) {
    const reason =
      error instanceof Error ? error.message.slice(0, 120) : "import_failed";
    json(response, 400, { status: "error", reason }, requestId);
  }
}

// HTTP 入口与业务放在同一处：新增同类入口只修改本文件。
export const routes = [
  {
    path: "/backup",
    methods: ["GET"],
    handle: handleBackupExport,
  },
  {
    path: "/backup/import",
    methods: ["POST"],
    admin: true,
    handle: handleBackupImport,
  },
] satisfies readonly HttpRoute[];
