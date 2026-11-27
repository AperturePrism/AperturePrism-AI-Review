/** 仓库自动合并的配置与执行记录；一次请求原子提交，null 键表示回到跟随全局。 */
import { authHeaders, notifyUnauthorized } from "../auth";
import { bumpCache, getJson } from "./http";

export type AutoMergeMethod = "merge" | "squash" | "rebase";
export type AutoMergeStatus =
  "pending" | "waiting" | "blocked" | "merged" | "canceled";

export type AutoMergeSettings = {
  enabled: boolean;
  method: AutoMergeMethod;
  requiredChecks: string[];
};

/** 写接口按键盘值覆盖；null 表示删除该仓库覆盖、回到跟随全局。 */
export type AutoMergeSettingsUpdate = {
  enabled: boolean | null;
  method: AutoMergeMethod | null;
  requiredChecks: string[] | null;
};

export type AutoMergeItem = {
  id: string;
  taskId: string;
  pullNumber: number;
  headSha: string;
  method: AutoMergeMethod;
  status: AutoMergeStatus;
  reason: string;
  message: string | null;
  mergeCommitSha: string | null;
  attempts: number;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type AutoMergeHistory = {
  items: AutoMergeItem[];
  /** 必须由服务端根据当前账号的仓库权限返回。缺失时不能显示保存操作。 */
  canManage: boolean;
};

export async function fetchAutoMergeHistory(
  repositoryId: string,
): Promise<AutoMergeHistory> {
  return (await getJson(
    `/repositories/${encodeURIComponent(repositoryId)}/auto-merge?limit=20`,
  )) as AutoMergeHistory;
}

export async function saveAutoMergeSettings(
  repositoryId: string,
  settings: AutoMergeSettingsUpdate,
): Promise<void> {
  const response = await fetch(
    `/repositories/${encodeURIComponent(repositoryId)}/auto-merge/settings`,
    {
      method: "PUT",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify(settings),
    },
  );
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as {
      reason?: string;
      message?: string;
    } | null;
    throw new Error(
      data?.message ?? data?.reason ?? `request failed with ${response.status}`,
    );
  }
  bumpCache();
}
