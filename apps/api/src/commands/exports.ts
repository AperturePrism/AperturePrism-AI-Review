/**
 * 审查数据导出：任务摘要与结果按稳定游标逐页读取，边读边发送 JSONL 或 CSV。
 * 调用：GET /exports/tasks?format=jsonl&limit=1000；GET /exports/results?type=pr&format=csv。
 * 导出沿用仓库查看权限；任务 payload 不进入文件；CSV 文本防止被表格当公式执行。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, asc, eq, gt, inArray, lte, or } from "drizzle-orm";
import {
  analysisTasks,
  subjectResults,
} from "../../../../packages/database/src/index.js";
import { visibleRepoScope } from "../identity.js";
import { database } from "../runtime.js";
import { HttpError, UUID_PATTERN } from "../utils/http.js";
import type { HttpRoute } from "../utils/routes.js";

export type ExportCursor = { id: string; createdAt: Date };
export type ExportOptions = {
  format: "jsonl" | "csv";
  limit: number;
  type: "issue" | "pr";
  after: ExportCursor | null;
  snapshot: Date;
};

type ExportRow = Record<string, unknown> & ExportCursor;
export type ExportPage = {
  items: readonly ExportRow[];
  nextCursor: string | null;
};
export type ExportServices = {
  list: (
    options: ExportOptions,
    pageSize: number,
  ) => Promise<readonly ExportRow[]>;
};

/** 游标携带导出开始时间，断线后可排除开始时间之后新增的记录。 */
export function encodeExportCursor(
  cursor: ExportCursor,
  snapshot: Date,
): string {
  return Buffer.from(
    JSON.stringify({
      id: cursor.id,
      createdAt: cursor.createdAt.toISOString(),
      snapshot: snapshot.toISOString(),
    }),
  ).toString("base64url");
}

/** 外部游标只在入口解析；后续页面之间使用同一份已校验日期和 ID。 */
function decodeExportCursor(raw: string): {
  cursor: ExportCursor;
  snapshot: Date;
} {
  if (raw.length > 1024) throw new HttpError(400, "invalid export cursor");
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      !parsed ||
      typeof parsed.id !== "string" ||
      !UUID_PATTERN.test(parsed.id) ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.snapshot !== "string"
    )
      throw new Error("cursor fields");
    const createdAt = new Date(parsed.createdAt);
    const snapshot = new Date(parsed.snapshot);
    if (
      !Number.isFinite(createdAt.getTime()) ||
      !Number.isFinite(snapshot.getTime()) ||
      createdAt > snapshot
    )
      throw new Error("cursor dates");
    return { cursor: { id: parsed.id, createdAt }, snapshot };
  } catch {
    throw new HttpError(400, "invalid export cursor");
  }
}

/** 解析导出输入，限制单次结果总量，避免一次请求拖住整个连接池。 */
export function parseExportOptions(url: URL, now = new Date()): ExportOptions {
  const format = url.searchParams.get("format") ?? "jsonl";
  if (format !== "jsonl" && format !== "csv")
    throw new HttpError(400, "format must be jsonl or csv");
  const limit = Number(url.searchParams.get("limit") ?? "1000");
  if (!Number.isInteger(limit) || limit < 1 || limit > 50_000)
    throw new HttpError(400, "limit must be between 1 and 50000");
  const type = url.searchParams.get("type") ?? "pr";
  if (type !== "pr" && type !== "issue")
    throw new HttpError(400, "type must be issue or pr");
  const rawCursor = url.searchParams.get("cursor");
  const resumed = rawCursor ? decodeExportCursor(rawCursor) : null;
  return {
    format,
    limit,
    type,
    after: resumed?.cursor ?? null,
    snapshot: resumed?.snapshot ?? now,
  };
}

/** CSV 单元格：JSON 值使用一格，文本公式加单引号，双引号按 CSV 规则转义。 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  if (typeof value === "string" && /^[=+\-@\t\r\n]/.test(text.trimStart()))
    text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

/** 等待接收方可读后再写下一页，慢速客户端下载不会在内存堆积整份结果。 */
async function writeChunk(
  response: ServerResponse,
  text: string,
): Promise<boolean> {
  if (response.destroyed || response.writableEnded) return false;
  if (response.write(text)) return true;
  return new Promise<boolean>((resolve, reject) => {
    const cleanup = (): void => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
    };
    const onDrain = (): void => {
      cleanup();
      resolve(true);
    };
    const onClose = (): void => {
      cleanup();
      resolve(false);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
  });
}

/**
 * 可恢复导出：每页发送一个游标注释事件；JSONL 每行保留独立 {record,cursor} 封装。
 * CSV 在最后以 HTTP trailer 回传游标；SSE 模式每条记录的 id 都是恢复游标。
 * @returns 实际发送的记录数。
 */
export async function streamExport(
  options: ExportOptions,
  response: ServerResponse,
  services: ExportServices,
  columns: readonly string[],
  mode: "download" | "sse" = "download",
): Promise<number> {
  if (options.format === "csv" && mode === "download") {
    if (!(await writeChunk(response, columns.map(csvField).join(",") + "\r\n")))
      return 0;
  }
  let count = 0;
  let after = options.after;
  let cursor: string | null = null;
  while (count < options.limit && !response.destroyed) {
    const pageSize = Math.min(200, options.limit - count);
    const items = await services.list({ ...options, after }, pageSize);
    if (!items.length) break;
    for (const row of items) {
      cursor = encodeExportCursor(row, options.snapshot);
      const line =
        mode === "sse"
          ? `id: ${cursor}\nevent: record\ndata: ${JSON.stringify(row)}\n\n`
          : options.format === "jsonl"
            ? JSON.stringify({ record: row, cursor }) + "\n"
            : columns.map((column) => csvField(row[column])).join(",") + "\r\n";
      if (!(await writeChunk(response, line))) return count;
      count += 1;
      after = row;
    }
    if (items.length < pageSize) break;
  }
  if (mode === "sse")
    await writeChunk(
      response,
      `event: complete\ndata: ${JSON.stringify({ count, cursor })}\n\n`,
    );
  else if (cursor) response.addTrailers({ "x-next-cursor": cursor });
  response.end();
  return count;
}

const TASK_COLUMNS = [
  "id",
  "taskType",
  "repositoryId",
  "subjectNumber",
  "subjectRevision",
  "status",
  "priority",
  "attemptCount",
  "maxAttempts",
  "lastErrorCategory",
  "createdAt",
  "updatedAt",
] as const;
const RESULT_COLUMNS = [
  "id",
  "subjectType",
  "subjectNumber",
  "repositoryFullName",
  "revision",
  "published",
  "createdAt",
  "result",
] as const;

/** GET /exports/tasks|results：在发送第一字节前确认权限范围和输入。 */
export async function handleExport(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const options = parseExportOptions(url);
  if (!options.after && request.headers["last-event-id"]) {
    const resumed = decodeExportCursor(
      String(request.headers["last-event-id"]),
    );
    options.after = resumed.cursor;
    options.snapshot = resumed.snapshot;
  }
  const scope = await visibleRepoScope(request);
  const tasks = url.pathname === "/exports/tasks";
  const mode = url.searchParams.get("stream") === "sse" ? "sse" : "download";
  const services: ExportServices = {
    list: async (page, pageSize) => {
      if (tasks) {
        const rows = await database.db
          .select({
            id: analysisTasks.id,
            taskType: analysisTasks.taskType,
            repositoryId: analysisTasks.repositoryId,
            subjectNumber: analysisTasks.subjectNumber,
            subjectRevision: analysisTasks.subjectRevision,
            status: analysisTasks.status,
            priority: analysisTasks.priority,
            attemptCount: analysisTasks.attemptCount,
            maxAttempts: analysisTasks.maxAttempts,
            lastErrorCategory: analysisTasks.lastErrorCategory,
            createdAt: analysisTasks.createdAt,
            updatedAt: analysisTasks.updatedAt,
          })
          .from(analysisTasks)
          .where(
            and(
              lte(analysisTasks.createdAt, page.snapshot),
              scope && scope.ids !== null
                ? inArray(analysisTasks.repositoryId, [...scope.ids])
                : undefined,
              page.after
                ? or(
                    gt(analysisTasks.createdAt, page.after.createdAt),
                    and(
                      eq(analysisTasks.createdAt, page.after.createdAt),
                      gt(analysisTasks.id, page.after.id),
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(asc(analysisTasks.createdAt), asc(analysisTasks.id))
          .limit(pageSize);
        return rows;
      }
      return database.db
        .select({
          id: subjectResults.id,
          subjectType: subjectResults.subjectType,
          subjectNumber: subjectResults.subjectNumber,
          repositoryFullName: subjectResults.repositoryFullName,
          revision: subjectResults.revision,
          published: subjectResults.published,
          createdAt: subjectResults.createdAt,
          result: subjectResults.result,
        })
        .from(subjectResults)
        .where(
          and(
            eq(subjectResults.subjectType, page.type),
            lte(subjectResults.createdAt, page.snapshot),
            scope && scope.fullNames !== null
              ? inArray(subjectResults.repositoryFullName, [...scope.fullNames])
              : undefined,
            page.after
              ? or(
                  gt(subjectResults.createdAt, page.after.createdAt),
                  and(
                    eq(subjectResults.createdAt, page.after.createdAt),
                    gt(subjectResults.id, page.after.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(asc(subjectResults.createdAt), asc(subjectResults.id))
        .limit(pageSize);
    },
  };
  response.writeHead(200, {
    "content-type":
      mode === "sse"
        ? "text/event-stream; charset=utf-8"
        : options.format === "csv"
          ? "text/csv; charset=utf-8"
          : "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-request-id": requestId,
    ...(mode === "sse"
      ? { "x-accel-buffering": "no" }
      : {
          "content-disposition": `attachment; filename="aperture-${tasks ? "tasks" : "results"}.${options.format === "csv" ? "csv" : "jsonl"}"`,
          trailer: "x-next-cursor",
        }),
  });
  await streamExport(
    options,
    response,
    services,
    tasks ? TASK_COLUMNS : RESULT_COLUMNS,
    mode,
  );
}

export const routes = [
  { path: "/exports/tasks", methods: ["GET"], handle: handleExport },
  { path: "/exports/results", methods: ["GET"], handle: handleExport },
] satisfies readonly HttpRoute[];
