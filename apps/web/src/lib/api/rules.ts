/**
 * 仓库审查规则文件与导入。
 * 本文件保留原有请求路径与返回契约；认证和 GET 缓存由 http.ts 统一提供。
 * @example import { fetchRepoRulesList } from './api/rules';
 */
import { authHeaders, notifyUnauthorized } from "../auth";
import { bumpCache, getJson } from "./http";

/* ---------- 仓库审核规则（WebUI「审核规则」功能页） ---------- */

export type RepoRulesItem = {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  enabled: boolean;
  hasRulesDir: boolean;
  files: { name: string; path: string }[];
};

export type RepoRulesList = {
  githubConfigured?: boolean;
  items: RepoRulesItem[];
};

export type RepoRulesDetail = {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  enabled: boolean;
  ref: string;
  files: { name: string; path: string }[];
};

/** GET /repo-rules —— 所有仓库 + 规则状态摘要。 */
export async function fetchRepoRulesList(): Promise<RepoRulesList> {
  return (await getJson("/repo-rules")) as RepoRulesList;
}

/** GET /repo-rules/:id —— 单仓库规则文件列表 + 开关状态。 */
export async function fetchRepoRulesDetail(
  repositoryId: string,
): Promise<RepoRulesDetail> {
  return (await getJson(
    `/repo-rules/${encodeURIComponent(repositoryId)}`,
  )) as RepoRulesDetail;
}

/** GET /repo-rules/:id/file?path=… —— 读取单个规则文件内容。 */
export async function fetchRepoRulesFile(
  repositoryId: string,
  filePath: string,
): Promise<{ path: string; content: string }> {
  return (await getJson(
    `/repo-rules/${encodeURIComponent(repositoryId)}/file?path=${encodeURIComponent(filePath)}`,
  )) as { path: string; content: string };
}

/** PUT /repo-rules/:id/file —— 创建 / 更新规则文件。 */
export async function saveRepoRulesFile(
  repositoryId: string,
  filePath: string,
  content: string,
  sha?: string,
): Promise<void> {
  const response = await fetch(
    `/repo-rules/${encodeURIComponent(repositoryId)}/file`,
    {
      method: "PUT",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({
        path: filePath,
        content,
        ...(sha ? { sha } : {}),
      }),
    },
  );
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (response.status === 403) throw new Error("需要管理员权限（403）");
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      detail?: unknown;
      reason?: unknown;
    } | null;
    throw new Error(
      String(
        body?.detail ??
          body?.reason ??
          `request failed with ${response.status}`,
      ),
    );
  }
  bumpCache();
}

/** DELETE /repo-rules/:id/file?path=… —— 删除规则文件。 */
export async function deleteRepoRulesFile(
  repositoryId: string,
  filePath: string,
): Promise<void> {
  const response = await fetch(
    `/repo-rules/${encodeURIComponent(repositoryId)}/file?path=${encodeURIComponent(filePath)}`,
    {
      method: "DELETE",
      headers: { accept: "application/json", ...authHeaders() },
    },
  );
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (response.status === 403) throw new Error("需要管理员权限（403）");
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      detail?: unknown;
      reason?: unknown;
    } | null;
    throw new Error(
      String(
        body?.detail ??
          body?.reason ??
          `request failed with ${response.status}`,
      ),
    );
  }
  bumpCache();
}

/** POST /repo-rules/:id/from-url —— 从 URL 拉取内容写入规则文件。 */
export async function importRepoRulesFromUrl(
  repositoryId: string,
  remoteUrl: string,
  filePath: string,
): Promise<void> {
  const response = await fetch(
    `/repo-rules/${encodeURIComponent(repositoryId)}/from-url`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({ url: remoteUrl, path: filePath }),
    },
  );
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (response.status === 403) throw new Error("需要管理员权限（403）");
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      detail?: unknown;
      reason?: unknown;
    } | null;
    throw new Error(
      String(
        body?.detail ??
          body?.reason ??
          `request failed with ${response.status}`,
      ),
    );
  }
  bumpCache();
}
