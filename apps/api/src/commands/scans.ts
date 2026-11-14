/**
 * 仓库扫描：计划配置、手动触发与历史记录。
 * 调用示例：handleScansConfig(request, response, requestId)。
 * HTTP 路径保持兼容；跨文件依赖在下方显式列出。
 */
import { parseJsonObject } from "../utils/http.js";
import type { HttpRoute } from "../utils/routes.js";
import {
  parseBool,
  BOOLEAN_DEFAULTS,
} from "../../../../packages/config/src/index.js";
import {
  loadSettings,
  repositories,
  getScanConfig,
  systemSettings,
  upsertScanConfig,
  listScanRuns,
} from "../../../../packages/database/src/index.js";
import { isAdminRequest, audit } from "../identity.js";
import { database } from "../runtime.js";
import { json, readBody } from "../utils/http.js";
import { eq, inArray } from "drizzle-orm";
import { type ServerResponse, type IncomingMessage } from "node:http";

/* ---------- repository scanning (config / manual trigger / history) ---------- */

/** Global scheduled-scan switch from `system_settings` (absent = enabled). */
async function scanGloballyEnabled(): Promise<boolean> {
  try {
    const settings = await loadSettings(database.db, ["scan_enabled"]);
    return parseBool(
      settings.get("scan_enabled"),
      BOOLEAN_DEFAULTS.scan_enabled ?? true,
    );
  } catch {
    return true;
  }
}

/**
 * GET /scans/config — global switch + per-repository effective scan configs
 * (explicit rows merged over defaults). Used by the WebUI scan management page.
 */
export async function handleScansConfig(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const repoRows = await database.db
    .select({
      id: repositories.id,
      owner: repositories.owner,
      name: repositories.name,
      installationId: repositories.installationId,
    })
    .from(repositories)
    .orderBy(repositories.name);
  const items = await Promise.all(
    repoRows.map(async (repo) => {
      const cfg = await getScanConfig(database.db, repo.id);
      return {
        repositoryId: repo.id,
        owner: repo.owner,
        name: repo.name,
        fullName: `${repo.owner}/${repo.name}`,
        installed: Boolean(repo.installationId),
        enabled: cfg.enabled,
        intervalMinutes: cfg.intervalMinutes,
        maxIssues: cfg.maxIssues,
        maxPrs: cfg.maxPrs,
        autoAnalyzeIssues: cfg.autoAnalyzeIssues,
        autoAnalyzePrs: cfg.autoAnalyzePrs,
        createTrackingIssues: cfg.createTrackingIssues,
        updatedAt: cfg.updatedAt,
      };
    }),
  );
  json(
    response,
    200,
    { enabled: await scanGloballyEnabled(), items },
    requestId,
  );
}

/**
 * PUT /scans/config — updates the global switch or one repository's config.
 * Global: `{"enabled": boolean}`. Per-repo: `{"repositoryId": string, ...}`.
 */
export async function handleScansConfigUpdate(
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
  const body = await readBody(request);
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonObject(body) as Record<string, unknown>;
  } catch {
    json(response, 400, { status: "error", reason: "invalid JSON" }, requestId);
    return;
  }

  const repositoryId =
    typeof parsed.repositoryId === "string" ? parsed.repositoryId.trim() : "";

  if (!repositoryId) {
    // Global switch: only `enabled` is honored at the top level.
    if (typeof parsed.enabled !== "boolean") {
      json(
        response,
        400,
        { status: "error", reason: "global update requires boolean enabled" },
        requestId,
      );
      return;
    }
    await database.db
      .insert(systemSettings)
      .values({ key: "scan_enabled", value: String(parsed.enabled) })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: String(parsed.enabled), updatedAt: new Date() },
      });
    audit(request, "scans.config.global", undefined, {
      enabled: parsed.enabled,
    });
    json(response, 200, { status: "ok", enabled: parsed.enabled }, requestId);
    return;
  }

  const exists = await database.db
    .select({ id: repositories.id })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);
  if (exists.length === 0) {
    json(
      response,
      404,
      { status: "error", reason: "repository not found" },
      requestId,
    );
    return;
  }
  const bool = (value: unknown, fallback: boolean): boolean =>
    typeof value === "boolean" ? value : fallback;
  const int = (
    value: unknown,
    fallback: number,
    min: number,
    max: number,
  ): number =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(Math.max(Math.trunc(value), min), max)
      : fallback;
  await upsertScanConfig(database.db, {
    repositoryId,
    enabled: bool(parsed.enabled, true),
    intervalMinutes: int(parsed.intervalMinutes, 1440, 1, 60 * 24 * 30),
    maxIssues: int(parsed.maxIssues, 50, 1, 1000),
    maxPrs: int(parsed.maxPrs, 20, 1, 1000),
    autoAnalyzeIssues: bool(parsed.autoAnalyzeIssues, true),
    autoAnalyzePrs: bool(parsed.autoAnalyzePrs, true),
    createTrackingIssues: bool(parsed.createTrackingIssues, false),
  });
  audit(request, "scans.config.update", repositoryId);
  json(response, 200, { status: "ok", repositoryId }, requestId);
}

/**
 * POST /scans/run — manual scan trigger. Writes a `scan_trigger` setting that
 * the scan-worker consumes on its next loop (mirrors the index trigger pattern).
 */
export async function handleScansRun(
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
  await database.db
    .insert(systemSettings)
    .values({ key: "scan_trigger", value: new Date().toISOString() })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: new Date().toISOString(), updatedAt: new Date() },
    });
  audit(request, "scans.run");
  json(response, 200, { status: "ok", triggered: true }, requestId);
}

/** GET /scans/runs — scan run history, newest first, offset-paginated. */
export async function handleScansRuns(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200)
    : 50;
  const offsetRaw = Number(url.searchParams.get("offset"));
  const offset = Number.isFinite(offsetRaw)
    ? Math.max(Math.trunc(offsetRaw), 0)
    : 0;
  const runs = await listScanRuns(database.db, { limit, offset });
  const repoIds = [
    ...new Set(
      runs
        .map((run) => run.repositoryId)
        .filter((v): v is string => Boolean(v)),
    ),
  ];
  const repos =
    repoIds.length > 0
      ? await database.db
          .select({
            id: repositories.id,
            owner: repositories.owner,
            name: repositories.name,
          })
          .from(repositories)
          .where(inArray(repositories.id, repoIds))
      : [];
  const byId = new Map(
    repos.map((repo) => [repo.id, `${repo.owner}/${repo.name}`]),
  );
  const items = runs.map((run) => ({
    ...run,
    repositoryFullName: run.repositoryId
      ? (byId.get(run.repositoryId) ?? null)
      : null,
  }));
  const nextOffset = items.length === limit ? offset + limit : undefined;
  json(
    response,
    200,
    nextOffset === undefined ? { items } : { items, nextOffset },
    requestId,
  );
}

// HTTP 入口与业务放在同一处：新增同类入口只修改本文件。
export const routes = [
  { path: "/scans/config", methods: ["PUT"], handle: handleScansConfigUpdate },
  {
    path: "/scans/config",
    methods: ["GET"],
    handle: (_request, response, id) => handleScansConfig(response, id),
  },
  { path: "/scans/run", methods: ["POST"], handle: handleScansRun },
  { path: "/scans/runs", methods: ["GET"], handle: handleScansRuns },
] satisfies readonly HttpRoute[];
