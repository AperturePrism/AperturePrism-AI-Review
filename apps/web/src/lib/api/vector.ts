/**
 * 向量索引、重建与相似 Issue。
 * 本文件保留原有请求路径与返回契约；认证和 GET 缓存由 http.ts 统一提供。
 * @example import { fetchVectorStats } from './api/vector';
 */
import { authHeaders } from "../auth";
import { getJson, postSetup } from "./http";

export type VectorStats = {
  documents: number;
  withEmbedding: number;
  withSignals: number;
  repositoryCoverage: number;
  embeddingModel: string;
  embeddingConfigured: boolean;
  lastIndexedAt: string | null;
};

/** Duplicate-index / vector-store stats from issue_documents. */
export async function fetchVectorStats(): Promise<VectorStats> {
  return (await getJson("/vector")) as VectorStats;
}

/** Requests an immediate index-worker pass. */
export async function triggerIndexRun(): Promise<void> {
  const response = await fetch("/index/run", {
    method: "POST",
    headers: { accept: "application/json", ...authHeaders() },
  });
  if (!response.ok) throw new Error(`trigger index ${response.status}`);
}

export type IndexPassSummary = {
  pass: number;
  rebuild: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  repos: number;
  indexed: number;
  skippedUnchanged: number;
  embedded: number;
  errors: string[];
};

export type IndexStatus = {
  lastPass: IndexPassSummary | null;
  pendingTrigger: boolean;
  pendingRebuild: boolean;
};

/** Index-worker health: last pass summary + pending trigger/rebuild flags. */
export async function fetchIndexStatus(): Promise<IndexStatus> {
  return (await getJson("/index/status")) as IndexStatus;
}

/** Full index rebuild: clears issue_documents and re-indexes everything. */
export async function rebuildIndex(): Promise<void> {
  const response = await fetch("/index/rebuild", {
    method: "POST",
    headers: { accept: "application/json", ...authHeaders() },
  });
  if (!response.ok) throw new Error(`rebuild index ${response.status}`);
}

export type RelatedIssue = {
  id: string;
  repositoryId: string | null;
  repositoryFullName: string | null;
  issueNumber: number;
  score: number;
  reasons: string[];
};

/** Read-only RAG recall: candidates similar to a lead issue. */
export async function fetchRelatedIssues(input: {
  title: string;
  body: string;
  topK?: number;
  /** Optional: restrict recall to one repository (owner/name) to avoid cross-project hits. */
  repositoryFullName?: string;
}): Promise<{ candidates: RelatedIssue[]; degraded?: boolean }> {
  const params = new URLSearchParams({
    title: input.title,
    body: input.body,
    topK: String(input.topK ?? 5),
  });
  if (input.repositoryFullName) {
    params.set("repositoryFullName", input.repositoryFullName);
  }
  return (await getJson(`/index/related?${params.toString()}`)) as {
    candidates: RelatedIssue[];
    degraded?: boolean;
  };
}

/** Stores the embedding endpoint as a hot runtime setting. */
export async function saveEmbedding(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
}): Promise<{ status: string; baseUrl: string; model: string }> {
  return (await postSetup("/setup/embedding", input)) as {
    status: string;
    baseUrl: string;
    model: string;
  };
}
