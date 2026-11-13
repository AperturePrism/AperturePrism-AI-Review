/**
 * 仓库列表、同步与关联主体。
 * 本文件保留原有请求路径与返回契约；认证和 GET 缓存由 http.ts 统一提供。
 * @example import { syncRepositories } from './api/repository';
 */
import { authHeaders, notifyUnauthorized } from "../auth";
import { bumpCache, getJson } from "./http";

export type Repository = {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  taskCount: number;
  resultCount: number;
  createdAt: string;
};

export type RepositoryList = {
  items: Repository[];
  /** 能否真的实例化出 GitHub App 客户端（含 DB 覆盖）；前端用它区分空态。 */
  githubConfigured?: boolean;
};

export type RepoSyncResult = {
  status: string;
  installations: number;
  synced: number;
  errors: number;
  /** 已取消授权 / 已移除安装的仓库数（本次同步清理）。 */
  removed?: number;
  /** 已有同步在进行，本次被跳过。 */
  skipped?: boolean;
  details?: { installationId: string; reason: string }[];
  /** 本次生效的同步范围（metadata / issues_pr / full）。 */
  scope?: string;
  /** 是否触发了后续扫描/索引（范围 > metadata 时）。 */
  scanned?: boolean;
};

/** Pulls installed repositories from the GitHub App and upserts them (admin). */
export async function syncRepositories(): Promise<RepoSyncResult> {
  const response = await fetch("/repositories/sync", {
    method: "POST",
    headers: { accept: "application/json", ...authHeaders() },
  });
  // 只读一次 body：Response.body 是流，读完再读会抛
  // "Failed to execute 'json' on 'Response': body stream already read"。
  const body = (await response.json().catch(() => null)) as
    | (RepoSyncResult & {
        reason?: string;
        detail?: string;
        rateLimitedUntil?: string | null;
      })
    | null;
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (response.status === 403) throw new Error("需要管理员权限（403）");
  if (response.status === 409) {
    throw new Error(body?.reason ?? "sync_in_progress");
  }
  if (response.status === 429) {
    throw new Error(
      body?.detail ??
        (body?.reason === "rate_limited_until"
          ? "GitHub 限流暂停窗口内，请稍后再试"
          : "GitHub 限流，同步已中止"),
    );
  }
  if (!response.ok) {
    throw new Error(
      body?.detail ?? body?.reason ?? `sync repositories ${response.status}`,
    );
  }
  return body as RepoSyncResult;
}

/** Lists installed GitHub repos + per-repo task/result counts. */
export async function fetchRepositories(): Promise<RepositoryList> {
  return (await getJson("/repositories")) as RepositoryList;
}

export type RepoSubjectItem = { number: number; title: string };

/**
 * Recent open issues / pull requests of an installed repository. Used by the
 * manual-trigger form to offer a pickable dropdown instead of a bare number.
 */
export async function fetchRepoSubjects(
  fullName: string,
  type: "issue" | "pr",
  limit = 20,
): Promise<RepoSubjectItem[]> {
  const params = new URLSearchParams({
    fullName,
    type,
    limit: String(limit),
  });
  const result = (await getJson(
    `/repositories/issues?${params.toString()}`,
  )) as { items: RepoSubjectItem[] };
  return result.items;
}

/** 仓库级设置项：`overridden` 为 false 时该仓库跟随全局值。 */
export type RepositorySettingItem = {
  key: string;
  /** 字段文案由后端注册表提供，前端不再维护第二份。 */
  label: string;
  hint: string;
  kind: "boolean" | "string" | "secret" | "enum" | "number" | "multicheck";
  secret: boolean;
  options?: string[];
  overridden: boolean;
  value: string;
  globalValue: string;
  /** 全局也没配时的应用默认。 */
  defaultValue: string;
};

export type RepositorySettings = {
  repository: { id: string; fullName: string };
  items: RepositorySettingItem[];
};

export async function fetchRepositorySettings(
  repositoryId: string,
): Promise<RepositorySettings> {
  return (await getJson(
    `/repositories/${encodeURIComponent(repositoryId)}/settings`,
  )) as RepositorySettings;
}

/**
 * 写入或清除一个仓库级覆盖。`value: null` 表示删除覆盖、回到跟随全局。
 *
 * 不走 putJson：后者把 400 一律变成 "request failed with 400"，用户看不到
 * unsupported_setting_key 这类真实原因。
 */
export async function saveRepositorySetting(
  repositoryId: string,
  key: string,
  value: string | null,
): Promise<void> {
  const response = await fetch(
    `/repositories/${encodeURIComponent(repositoryId)}/settings`,
    {
      method: "PUT",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({ key, value }),
    },
  );
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (!response.ok) {
    const reason = await response
      .json()
      .then((body: unknown) =>
        typeof body === "object" && body !== null && "reason" in body
          ? String((body as { reason: unknown }).reason)
          : "",
      )
      .catch(() => "");
    throw new Error(reason || `request failed with ${response.status}`);
  }
  bumpCache();
}
