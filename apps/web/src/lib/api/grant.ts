/**
 * 仓库授权与访问范围。
 * 本文件保留原有请求路径与返回契约；认证和 GET 缓存由 http.ts 统一提供。
 * @example import { fetchGrants } from './api/grant';
 */
import { authHeaders } from "../auth";
import { getJson } from "./http";

/* ---------- 方向七：仓库可见性授权 ---------- */

export type GrantAccess = "view" | "manage";

export type RepoGrant = {
  userLogin: string;
  repositoryId: string;
  access: GrantAccess;
};

export type RepoGrantList = { items: RepoGrant[] };

/** 列出仓库授权（admin）。支持按用户 / 仓库筛选。 */
export async function fetchGrants(opts?: {
  user?: string;
  repository?: string;
}): Promise<RepoGrant[]> {
  const params = new URLSearchParams();
  if (opts?.user) params.set("user", opts.user);
  if (opts?.repository) params.set("repository", opts.repository);
  const qs = params.toString();
  const result = (await getJson(
    `/grants${qs ? `?${qs}` : ""}`,
  )) as RepoGrantList;
  return result.items;
}

/** 设置 / 更新某用户对某仓库的授权（admin）。 */
export async function setGrant(
  userLogin: string,
  repositoryId: string,
  access: GrantAccess,
): Promise<RepoGrant> {
  const response = await fetch(
    `/grants/${encodeURIComponent(userLogin)}/${encodeURIComponent(repositoryId)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ access }),
    },
  );
  if (!response.ok) throw new Error(`set grant ${response.status}`);
  return (await response.json()) as RepoGrant;
}

/** 移除某用户对某仓库的授权（admin）。 */
export async function deleteGrant(
  userLogin: string,
  repositoryId: string,
): Promise<void> {
  const response = await fetch(
    `/grants/${encodeURIComponent(userLogin)}/${encodeURIComponent(repositoryId)}`,
    { method: "DELETE", headers: { ...authHeaders() } },
  );
  if (!response.ok) throw new Error(`delete grant ${response.status}`);
}
