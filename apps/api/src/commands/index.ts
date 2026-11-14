/**
 * 仓库索引：统计、重建、近似关联与触发向量入库。
 * 调用示例：handleVector(request, response, requestId)。
 * HTTP 路径保持兼容；跨文件依赖在下方显式列出。
 */
import type { HttpRoute } from "../utils/routes.js";
import {
  systemSettings,
  issueDocuments,
} from "../../../../packages/database/src/index.js";
import {
  extractIssueSignals,
  recallCandidatesWithRepos,
  type SqlTag,
  normalizedIndexText,
} from "../../../../packages/duplicate-detection/src/index.js";
import { audit } from "../identity.js";
import { embeddingConfig } from "../preferences.js";
import { database, logger } from "../runtime.js";
import { json } from "../utils/http.js";
import { eq, or } from "drizzle-orm";
import { type ServerResponse, type IncomingMessage } from "node:http";

/** Vector/duplicate-index stats from issue_documents (nvidia/nv-embed-v1). */
export async function handleVector(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const [stats, repoCoverage, lastIndex] = await Promise.all([
    database.sql<
      { docs: number; with_embedding: number; with_signals: number }[]
    >`
      SELECT count(*)::int AS docs,
             count(embedding)::int AS with_embedding,
             count(*) FILTER (WHERE cardinality(error_codes) > 0)::int AS with_signals
      FROM issue_documents
    `,
    database.sql<{ repositories: number }[]>`
      SELECT count(DISTINCT repository_id)::int AS repositories
      FROM issue_documents WHERE repository_id IS NOT NULL
    `,
    database.sql<{ at: Date | null }[]>`
      SELECT max(indexed_at) AS at FROM issue_documents
    `,
  ]);
  const row = stats[0];
  json(
    response,
    200,
    {
      documents: row?.docs ?? 0,
      withEmbedding: row?.with_embedding ?? 0,
      withSignals: row?.with_signals ?? 0,
      repositoryCoverage: repoCoverage[0]?.repositories ?? 0,
      embeddingModel: embeddingConfig().model,
      embeddingConfigured: Boolean(
        embeddingConfig().baseUrl && embeddingConfig().apiKey,
      ),
      lastIndexedAt: lastIndex[0]?.at ?? null,
    },
    requestId,
  );
}

/** Requests an immediate index pass by writing the index_trigger setting. */
export async function handleIndexRun(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  try {
    await database.db
      .insert(systemSettings)
      .values({ key: "index_trigger", value: new Date().toISOString() })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: new Date().toISOString(), updatedAt: new Date() },
      });
    audit(request, "index.run");
    json(response, 200, { status: "ok", triggered: true }, requestId);
  } catch (error) {
    logger.warn({ err: error }, "index trigger failed");
    json(
      response,
      500,
      { status: "error", reason: "trigger_failed" },
      requestId,
    );
  }
}

/** Index health: last worker pass summary + pending trigger/rebuild flags. */
export async function handleIndexStatus(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const [rows, pending] = await Promise.all([
    database.db
      .select({ key: systemSettings.key, value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, "index_last_pass"))
      .limit(1),
    database.db
      .select({ key: systemSettings.key })
      .from(systemSettings)
      .where(
        or(
          eq(systemSettings.key, "index_trigger"),
          eq(systemSettings.key, "index_rebuild"),
        ),
      )
      .limit(5),
  ]);
  const raw = rows[0]?.value;
  let lastPass: unknown = null;
  if (raw) {
    try {
      lastPass = JSON.parse(raw);
    } catch {
      lastPass = null;
    }
  }
  const keys = new Set(pending.map((row) => row.key));
  json(
    response,
    200,
    {
      lastPass,
      pendingTrigger: keys.has("index_trigger"),
      pendingRebuild: keys.has("index_rebuild"),
    },
    requestId,
  );
}

/** Full index rebuild: clears issue_documents and triggers a fresh pass. */
export async function handleIndexRebuild(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  try {
    await database.db.delete(issueDocuments);
    await database.db
      .insert(systemSettings)
      .values({ key: "index_rebuild", value: new Date().toISOString() })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: new Date().toISOString(), updatedAt: new Date() },
      });
    audit(request, "index.rebuild");
    json(response, 200, { status: "ok", rebuilt: true }, requestId);
  } catch (error) {
    logger.warn({ err: error }, "index rebuild failed");
    json(
      response,
      500,
      { status: "error", reason: "rebuild_failed" },
      requestId,
    );
  }
}

/** Read-only RAG recall: candidates similar to a lead issue, never decides. */
export async function handleIndexRelated(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const title = url.searchParams.get("title") ?? "";
  const body = url.searchParams.get("body") ?? "";
  const topK = Math.min(
    Math.max(Number(url.searchParams.get("topK")) || 5, 1),
    20,
  );
  const repositoryFullName = url.searchParams.get("repositoryFullName") ?? "";
  const repository =
    repositoryFullName && repositoryFullName.includes("/")
      ? (() => {
          const [owner, name] = repositoryFullName.split("/");
          return owner && name ? { owner, name } : null;
        })()
      : null;
  if (title.length === 0 && body.length === 0) {
    json(
      response,
      400,
      { status: "error", reason: "title or body required" },
      requestId,
    );
    return;
  }
  try {
    const signals = extractIssueSignals({ title, body, labels: [] });
    const candidates = await recallCandidatesWithRepos(
      database.sql as unknown as SqlTag,
      {
        title: normalizedIndexText({ title, body: "" }),
        body: normalizedIndexText({ title, body }),
        signals,
        topK,
        // 可选：限制在同一仓库内召回，避免跨项目“相关”Issue。
        repository,
      },
    );
    json(response, 200, { candidates }, requestId);
  } catch (error) {
    // Index unavailable is a degrade-not-fail condition for the caller.
    logger.warn({ err: error }, "index recall failed");
    json(response, 200, { candidates: [], degraded: true }, requestId);
  }
}

// HTTP 入口与业务放在同一处：新增同类入口只修改本文件。
export const routes = [
  {
    path: "/vector",
    methods: ["GET"],
    handle: (_request, response, id) => handleVector(response, id),
  },
  { path: "/index/run", methods: ["POST"], handle: handleIndexRun },
  { path: "/index/rebuild", methods: ["POST"], handle: handleIndexRebuild },
  {
    path: "/index/status",
    methods: ["GET"],
    handle: (_request, response, id) => handleIndexStatus(response, id),
  },
  { path: "/index/related", methods: ["GET"], handle: handleIndexRelated },
] satisfies readonly HttpRoute[];
