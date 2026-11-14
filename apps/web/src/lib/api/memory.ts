/**
 * 仓库记忆、整合与删除。
 * 本文件保留原有请求路径与返回契约；认证和 GET 缓存由 http.ts 统一提供。
 * @example import { fetchRepoMemory } from './api/memory';
 */
import { authHeaders, notifyUnauthorized } from "../auth";
import { getJson } from "./http";

export type RepoMemoryKind = "reflection" | "rule" | "knowledge";

export type RepoMemoryItem = {
  id: string;
  repositoryId: string | null;
  kind: RepoMemoryKind;
  title: string;
  content: string;
  sourceType: string | null;
  sourceRef: string | null;
  consolidated: boolean;
  createdAt: string;
  updatedAt: string;
};

export type RepoMemoryList = {
  items: RepoMemoryItem[];
  counts: { reflection: number; rule: number; knowledge: number };
  nextOffset?: number;
};

export type MemoryFilter = {
  repositoryId?: string;
  kind?: RepoMemoryKind;
  limit?: number;
  offset?: number;
};

/** Lists repository memory, newest first; counts always included. */
export async function fetchRepoMemory(
  filter: MemoryFilter = {},
): Promise<RepoMemoryList> {
  const params = new URLSearchParams();
  if (filter.repositoryId) params.set("repositoryId", filter.repositoryId);
  if (filter.kind) params.set("kind", filter.kind);
  if (filter.limit !== undefined) params.set("limit", String(filter.limit));
  if (filter.offset !== undefined) params.set("offset", String(filter.offset));
  const query = params.toString();
  return (await getJson(
    `/memory${query ? `?${query}` : ""}`,
  )) as RepoMemoryList;
}

export type MemoryConsolidationResult = {
  status: string;
  repositories: number;
  rules: number;
};

/** 手动创建仓库记忆条目（规则/知识，管理员）；kind 限 rule | knowledge。 */
export async function createRepoMemory(input: {
  kind: "rule" | "knowledge";
  title: string;
  content: string;
  repositoryId?: string;
}): Promise<void> {
  const response = await fetch("/memory", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (!response.ok) {
    const reason =
      response.status === 403
        ? "需要管理员权限（403）"
        : `memory create ${response.status}`;
    throw new Error(reason);
  }
}

/** Runs one memory-consolidation sweep (admin only). */
export async function triggerMemoryConsolidation(): Promise<MemoryConsolidationResult> {
  const response = await fetch("/memory/consolidate", {
    method: "POST",
    headers: { accept: "application/json", ...authHeaders() },
  });
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (!response.ok) {
    const reason =
      response.status === 403
        ? "需要管理员权限（403）"
        : `memory consolidate ${response.status}`;
    throw new Error(reason);
  }
  return (await response.json()) as MemoryConsolidationResult;
}

/** Deletes a single memory row (admin only); missing row is not an error. */
export async function deleteRepoMemory(id: string): Promise<void> {
  const response = await fetch(`/memory/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (!response.ok && response.status !== 403 && response.status !== 404) {
    throw new Error(`memory delete ${response.status}`);
  }
}
