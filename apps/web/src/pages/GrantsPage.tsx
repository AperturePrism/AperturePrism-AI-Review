import { UserIcon as PageIcon } from "../components/icons";
import type { ConsolePage } from "../lib/navigation";

/** 本页的位置与入口同处维护；导航由页面目录自动读取。 */
export const consolePages: ConsolePage[] = [{ path: "/grants", label: "仓库授权", group: "data", order: 41, icon: PageIcon, render: () => <GrantsPage /> }];

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  bumpCache,
  deleteGrant,
  fetchGrants,
  fetchMe,
  fetchRepositories,
  fetchUsers,
  setGrant,
  type GrantAccess,
  type Repository,
  type RepoGrant,
  type UserRow,
} from "../lib/api";
import { RefreshIcon, ShieldIcon } from "../components/icons";
import { ErrorPanel, LoadingRows } from "../components/ui";
import { useToast } from "../components/Toast";

const ACCESS_OPTIONS: { value: "" | GrantAccess; label: string }[] = [
  { value: "", label: "无授权" },
  { value: "view", label: "仅查看" },
  { value: "manage", label: "可管理" },
];

/**
 * 方向七：仓库可见性授权（admin）。
 * 用户 × 仓库矩阵：为每个非管理员用户配置其对每个仓库的访问等级。
 * admin 用户始终全可见/可管，不出现在矩阵里（下方列出供提示）。
 */
export function GrantsPage() {
  const toast = useToast();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [grants, setGrants] = useState<RepoGrant[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // repositoryId -> login -> access
  const grantMap = useMemo(() => {
    const map = new Map<string, Map<string, GrantAccess>>();
    for (const g of grants) {
      let byUser = map.get(g.repositoryId);
      if (!byUser) {
        byUser = new Map();
        map.set(g.repositoryId, byUser);
      }
      byUser.set(g.userLogin, g.access);
    }
    return map;
  }, [grants]);

  const editableUsers = useMemo(
    () => users.filter((u) => !u.isAdmin),
    [users],
  );
  const adminUsers = useMemo(
    () => users.filter((u) => u.isAdmin),
    [users],
  );

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchMe(), fetchUsers(), fetchRepositories(), fetchGrants()])
      .then(([me, rows, repoList, grantRows]) => {
        setIsAdmin(me.isAdmin || me.authMethod === "bearer");
        setUsers(rows);
        setRepos(repoList.items);
        setGrants(grantRows);
      })
      .catch((err: unknown) => {
        const messageText = err instanceof Error ? err.message : "加载失败";
        setError(
          messageText.includes("403")
            ? "需要管理员权限（403）。当前账号未授予管理员角色。"
            : messageText,
        );
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  const apply = async (
    login: string,
    repositoryId: string,
    access: "" | GrantAccess,
  ) => {
    setBusy(`${login}::${repositoryId}`);
    try {
      if (access === "") {
        await deleteGrant(login, repositoryId);
      } else {
        await setGrant(login, repositoryId, access);
      }
      toast.success(
        access === ""
          ? `已移除 ${login} 的授权。`
          : `已设置 ${login} 为「${access === "manage" ? "可管理" : "仅查看"}」。`,
      );
      load();
    } catch (err) {
      toast.error(`操作失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <div className="stack">
        <div className="page-head">
          <div>
            <h1 className="page-title">仓库授权</h1>
            <p className="page-desc">按仓库分配用户可见/可管理权限</p>
          </div>
        </div>
        <ErrorPanel error={error} onRetry={load} />
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">仓库授权</h1>
          <p className="page-desc">
            管理每个用户对各仓库的访问：仅查看（只读）或可管理（修改设置 / 触发分析）
          </p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => { bumpCache(); load(); }} disabled={loading}>
            <RefreshIcon size={16} />
            刷新
          </button>
        </div>
      </div>

      {loading ? (
        <div className="panel"><LoadingRows /></div>
      ) : (
        <div className="stack">
          <section className="panel">
            <div className="panel-title">
              <h2><ShieldIcon size={14} /> 仓储授权矩阵</h2>
              <span className="count">{repos.length} 仓库</span>
            </div>

            {!isAdmin ? (
              <p className="faint" style={{ margin: 0, fontSize: 13 }}>
                需要管理员权限（403）。当前账号未授予管理员角色，只能查看。
              </p>
            ) : repos.length === 0 ? (
              <p className="faint" style={{ margin: 0, fontSize: 12 }}>
                暂无可授权仓库。请先在「GitHub 接入」安装并同步仓库。
              </p>
            ) : editableUsers.length === 0 ? (
              <p className="faint" style={{ margin: 0, fontSize: 12 }}>
                暂无非管理员用户。仓库授权对管理员始终全可见/可管，无需额外配置。
              </p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table
                  style={{
                    borderCollapse: "collapse",
                    fontSize: 13,
                    minWidth: 620,
                  }}
                >
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", padding: "6px 10px", borderBottom: "1px solid var(--border, #e3e6ea)" }}>
                        仓库
                      </th>
                      {editableUsers.map((u) => (
                        <th
                          key={u.login}
                          style={{
                            textAlign: "center",
                            padding: "6px 8px",
                            minWidth: 92,
                            borderBottom: "1px solid var(--border, #e3e6ea)",
                          }}
                        >
                          {u.login}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {repos.map((repo) => (
                      <tr key={repo.id}>
                        <td style={{ padding: "6px 10px", borderBottom: "1px solid var(--border, #e3e6ea)" }}>
                          <span style={{ fontWeight: 600, fontSize: 13 }}>{repo.fullName}</span>
                        </td>
                        {editableUsers.map((u) => {
                          const current = grantMap.get(repo.id)?.get(u.login) ?? "";
                          const busyKey = `${u.login}::${repo.id}`;
                          return (
                            <td
                              key={u.login}
                              style={{
                                textAlign: "center",
                                padding: "6px 8px",
                                borderBottom: "1px solid var(--border, #e3e6ea)",
                              }}
                            >
                              <select
                                value={current}
                                disabled={busy === busyKey}
                                onChange={(e) =>
                                  void apply(
                                    u.login,
                                    repo.id,
                                    e.target.value as "" | GrantAccess,
                                  )
                                }
                              >
                                {ACCESS_OPTIONS.map((opt) => (
                                  <option key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </option>
                                ))}
                              </select>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {adminUsers.length > 0 ? (
              <p className="faint" style={{ marginTop: 12, fontSize: 12 }}>
                管理员（始终全可见/可管，矩阵外）：{adminUsers.map((u) => u.login).join("、")}
              </p>
            ) : null}
            <p className="faint" style={{ marginTop: 6, fontSize: 12 }}>
              「仅查看」用户只能看到审核结果、任务与该仓库设置（只读）；「可管理」用户额外可修改该仓库分析设置、触发重分析。全局只读操作员在任意授权上不拥有写权限。
            </p>
          </section>
        </div>
      )}
    </div>
  );
}