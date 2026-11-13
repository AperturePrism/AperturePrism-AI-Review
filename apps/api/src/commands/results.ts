/**
 * 审查结果：按仓库、主体与版本查询和删除。
 * 调用示例：handleResults(request, response, requestId)。
 * HTTP 路径保持兼容；跨文件依赖在下方显式列出。
 */
import { parseJsonObject } from "../utils/http.js";
import type { HttpRoute } from "../utils/routes.js";
import {
  subjectResults,
  externalPublications,
} from "../../../../packages/database/src/index.js";
import { visibleRepoScope, isAdminRequest, audit } from "../identity.js";
import { database } from "../runtime.js";
import { json, readBody } from "../utils/http.js";
import { and, eq, desc, inArray } from "drizzle-orm";
import { type IncomingMessage, type ServerResponse } from "node:http";

const resultColumns = {
  subjectType: subjectResults.subjectType,
  subjectNumber: subjectResults.subjectNumber,
  repositoryFullName: subjectResults.repositoryFullName,
  revision: subjectResults.revision,
  result: subjectResults.result,
  published: subjectResults.published,
  createdAt: subjectResults.createdAt,
} as const;

/**
 * Lists persisted results by type (`/results?type=issue|pr`) or all revisions
 * for one subject (`/results/:type/:number`). Used by the WebUI result pages.
 */
export async function handleResults(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  const path = url.pathname;

  // /results/:type/:number -> all revisions of one subject
  if (path.startsWith("/results/")) {
    const parts = path.split("/").filter(Boolean);
    const type = parts[1];
    const number = Number(parts[2]);
    if (
      (type !== "issue" && type !== "pr") ||
      !Number.isInteger(number) ||
      number <= 0
    ) {
      json(
        response,
        400,
        { status: "error", reason: "invalid result path" },
        requestId,
      );
      return;
    }
    const scope = await visibleRepoScope(request);
    const items = await database.db
      .select(resultColumns)
      .from(subjectResults)
      .where(
        and(
          eq(subjectResults.subjectType, type),
          eq(subjectResults.subjectNumber, number),
          scope && scope.fullNames !== null
            ? inArray(subjectResults.repositoryFullName, [...scope.fullNames])
            : undefined,
        ),
      )
      .orderBy(desc(subjectResults.createdAt))
      .limit(50);
    json(response, 200, { items }, requestId);
    return;
  }

  // /results?type=issue|pr
  const type = url.searchParams.get("type");
  if (type !== "issue" && type !== "pr") {
    json(
      response,
      400,
      { status: "error", reason: "type=issue|pr required" },
      requestId,
    );
    return;
  }
  const limitRaw = Number(url.searchParams.get("limit") ?? "25");
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100)
    : 25;
  // Offset pagination avoids skipping rows that share a createdAt millisecond.
  const offsetRaw = Number(url.searchParams.get("offset"));
  const offset = Number.isFinite(offsetRaw)
    ? Math.max(Math.trunc(offsetRaw), 0)
    : 0;
  // 方向七：非 admin 仅列出被授权仓库的结果。
  const scope = await visibleRepoScope(request);
  const where =
    scope && scope.fullNames !== null
      ? and(
          eq(subjectResults.subjectType, type),
          inArray(subjectResults.repositoryFullName, [...scope.fullNames]),
        )
      : eq(subjectResults.subjectType, type);
  const items = await database.db
    .select(resultColumns)
    .from(subjectResults)
    .where(where)
    .orderBy(desc(subjectResults.createdAt), desc(subjectResults.id))
    .limit(limit)
    .offset(offset);
  const nextOffset = items.length === limit ? offset + limit : undefined;
  json(
    response,
    200,
    nextOffset === undefined ? { items } : { items, nextOffset },
    requestId,
  );
}

/**
 * POST /results/delete — batch-deletes persisted results (admin only).
 * Body: `{"items":[{"subjectType","subjectNumber","repositoryFullName","revision"}]}`.
 * Each item removes the matching subject_results row(s). Returns how many rows
 * were deleted and how many items matched nothing. Also removes the task's
 * external publications so revoke bookkeeping does not linger.
 */
export async function handleResultsDelete(
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
  let parsed: { items?: unknown };
  try {
    parsed = parseJsonObject(body);
  } catch {
    json(response, 400, { status: "error", reason: "invalid JSON" }, requestId);
    return;
  }
  const items = Array.isArray(parsed.items)
    ? (parsed.items as Record<string, unknown>[]).filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null,
      )
    : [];
  if (items.length === 0) {
    json(
      response,
      400,
      { status: "error", reason: "items must be a non-empty array" },
      requestId,
    );
    return;
  }

  let deleted = 0;
  let notFound = 0;
  for (const item of items) {
    const subjectType = item.subjectType === "pr" ? "pr" : "issue";
    const subjectNumber = Number(item.subjectNumber);
    const repositoryFullName =
      typeof item.repositoryFullName === "string"
        ? item.repositoryFullName
        : "";
    const revision = typeof item.revision === "string" ? item.revision : "";
    if (
      !Number.isInteger(subjectNumber) ||
      subjectNumber <= 0 ||
      !repositoryFullName
    ) {
      notFound += 1;
      continue;
    }
    const conditions = [
      eq(subjectResults.subjectType, subjectType),
      eq(subjectResults.subjectNumber, subjectNumber),
      eq(subjectResults.repositoryFullName, repositoryFullName),
    ];
    if (revision) conditions.push(eq(subjectResults.revision, revision));

    const rows = await database.db
      .select({ id: subjectResults.id, taskId: subjectResults.taskId })
      .from(subjectResults)
      .where(and(...conditions));
    if (rows.length === 0) {
      notFound += 1;
      continue;
    }
    const resultIds = rows.map((r) => r.id);
    await database.db
      .delete(subjectResults)
      .where(inArray(subjectResults.id, resultIds)); // 只删除刚才选中的版本，保留同一主体的其他版本。
    deleted += resultIds.length;
    // 清理该主体的 external_publications 书签，避免撤回/Check Run 查询残留。
    const taskIds = rows
      .map((r) => r.taskId)
      .filter((t): t is string => Boolean(t));
    if (taskIds.length > 0) {
      await database.db
        .delete(externalPublications)
        .where(inArray(externalPublications.taskId, taskIds));
    }
  }
  audit(request, "results.delete", undefined, {
    items: items.length,
    deleted,
    notFound,
  });
  json(response, 200, { status: "ok", deleted, notFound }, requestId);
}

// HTTP 入口与业务放在同一处：新增同类入口只修改本文件。
export const routes = [
  {
    path: "/results/delete",
    methods: ["POST"],
    admin: true,
    handle: handleResultsDelete,
  },
  { path: "/results", prefix: true, methods: ["GET"], handle: handleResults },
] satisfies readonly HttpRoute[];
