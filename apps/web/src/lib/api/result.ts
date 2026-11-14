/**
 * 分析结果、撤回与删除。
 * 本文件保留原有请求路径与返回契约；认证和 GET 缓存由 http.ts 统一提供。
 * @example import { revokeSubject } from './api/result';
 */
import { authHeaders, notifyUnauthorized } from "../auth";
import { getJson } from "./http";

export type RevokeResult = {
  status: string;
  revoked: { comments: number; reviews: number; labels: number };
};

/**
 * One-click revoke of a published AI analysis / review: deletes issue
 * comments, dismisses PR reviews, and removes suggested labels (admin only).
 */
export async function revokeSubject(input: {
  repositoryFullName: string;
  number: number;
  type: "issue" | "pr";
}): Promise<RevokeResult> {
  const response = await fetch("/repos/revoke", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(input),
  });
  const text = await response.text();
  let parsed: {
    status?: string;
    reason?: string;
    revoked?: RevokeResult["revoked"];
  } = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // keep default
  }
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (response.status === 403) throw new Error("需要管理员权限（403）");
  if (!response.ok) {
    throw new Error(parsed.reason ?? `revoke subject ${response.status}`);
  }
  return {
    status: parsed.status ?? "ok",
    revoked: parsed.revoked ?? { comments: 0, reviews: 0, labels: 0 },
  };
}

export type SubjectResult = {
  subjectType: "issue" | "pr";
  subjectNumber: number;
  repositoryFullName: string;
  revision: string;
  result: unknown;
  published: boolean;
  createdAt: string;
};

export type ResultList = {
  items: SubjectResult[];
  nextOffset?: number;
};

/** Lists persisted issue/PR results, newest first, offset-paginated. */
export async function fetchResults(
  type: "issue" | "pr",
  offset?: number,
): Promise<ResultList> {
  const params = new URLSearchParams({ type });
  if (offset !== undefined) params.set("offset", String(offset));
  return (await getJson(`/results?${params.toString()}`)) as ResultList;
}

export type ResultsDeleteResult = {
  status: string;
  deleted: number;
  notFound: number;
};

/** Batch-deletes persisted results (admin only). */
export async function deleteResults(
  items: {
    subjectType: "issue" | "pr";
    subjectNumber: number;
    repositoryFullName: string;
    revision: string;
  }[],
): Promise<ResultsDeleteResult> {
  const response = await fetch("/results/delete", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ items }),
  });
  const text = await response.text();
  let parsed: {
    status?: string;
    reason?: string;
    deleted?: number;
    notFound?: number;
  } = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // keep default
  }
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (response.status === 403) throw new Error("需要管理员权限（403）");
  if (!response.ok) {
    throw new Error(parsed.reason ?? `delete results ${response.status}`);
  }
  return {
    status: parsed.status ?? "ok",
    deleted: parsed.deleted ?? 0,
    notFound: parsed.notFound ?? 0,
  };
}
