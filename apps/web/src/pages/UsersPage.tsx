import { UserIcon as PageIcon } from "../components/icons";
import type { ConsolePage } from "../lib/navigation";

/** 本页的位置与入口同处维护；导航由页面目录自动读取。 */
export const consolePages: ConsolePage[] = [{ path: "/users", label: "用户管理", group: "system", order: 52, icon: PageIcon, render: () => <UsersPage /> }];

import { useCallback, useEffect, useState } from "react";
import { bumpCache, fetchMe, fetchUsers, setUserRoles, type UserRow } from "../lib/api";
import { RefreshIcon, ShieldIcon } from "../components/icons";
import { ErrorPanel, LoadingRows } from "../components/ui";
import { useToast } from "../components/Toast";

/**
 * 角色三态：管理员（全权）/ 只读操作员（可看不可改）/ 普通用户（基础查看）。
 * 管理员与只读互斥：设为管理员即清除只读，设为只读即清除管理员。
 */
function roleLabel(user: UserRow): string {
  if (user.isAdmin) return "管理员";
  if (user.isReadOnly) return "只读操作员";
  return "普通用户";
}

export function UsersPage() {
  const toast = useToast();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchMe(), fetchUsers()])
      .then(([me, rows]) => {
        setIsAdmin(me.isAdmin || me.authMethod === "bearer");
        setUsers(rows);
      })
      .catch((err: unknown) => {
        const messageText = err instanceof Error ? err.message : "failed to load users";
        setError(
          messageText.includes("403")
            ? "需要管理员权限（403）。当前账号未授予管理员角色。"
            : messageText,
        );
        setUsers([]);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  /** 更新角色位；管理员与只读互斥由调用方保证。 */
  const setRole = async (
    login: string,
    roles: { isAdmin?: boolean; isReadOnly?: boolean },
  ) => {
    setBusy(login);
    try {
      await setUserRoles(login, roles);
      toast.success(`已更新 ${login} 的角色。`);
      load();
    } catch (err) {
      toast.error(`操作失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(null);
    }
  };

  const toggleAdmin = (user: UserRow) => {
    if (user.isAdmin) {
      if (!window.confirm(`确定要移除 ${user.login} 的管理员权限吗？`)) return;
      void setRole(user.login, { isAdmin: false });
    } else {
      void setRole(user.login, { isAdmin: true, isReadOnly: false });
    }
  };

  const toggleReadOnly = (user: UserRow) => {
    if (user.isReadOnly) {
      if (!window.confirm(`确定要让 ${user.login} 恢复可写权限吗？`)) return;
      void setRole(user.login, { isReadOnly: false });
    } else {
      if (!window.confirm(`确定要把 ${user.login} 设为只读操作员吗？将无法执行任何写操作。`)) return;
      void setRole(user.login, { isAdmin: false, isReadOnly: true });
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">用户管理</h1>
          <p className="page-desc">GitHub OAuth 登录用户与角色（管理员 / 只读操作员）</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => { bumpCache(); load(); }} disabled={loading}>
            <RefreshIcon size={16} />
            刷新
          </button>
        </div>
      </div>

      {error ? (
        <ErrorPanel error={error} onRetry={load} />
      ) : loading ? (
        <div className="panel"><LoadingRows /></div>
      ) : (
        <div className="stack">
          <section className="panel">
            <div className="panel-title"><h2><ShieldIcon size={14} /> 用户列表</h2><span className="count">{users.length}</span></div>
            {users.length === 0 ? (
              <p className="faint" style={{ margin: 0, fontSize: 12 }}>
                暂无用户。首次通过 GitHub OAuth 登录的用户会自动成为管理员。
              </p>
            ) : (
              <div className="stack">
                {users.map((user) => {
                  const busyUser = busy === user.login;
                  return (
                    <div
                      key={user.login}
                      className="result-card"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        flexWrap: "wrap",
                      }}
                    >
                      <div style={{ minWidth: 0, flex: "1 1 180px" }}>
                        <div className="result-title" style={{ fontSize: 14 }}>
                          {user.login}
                        </div>
                        {user.displayName ? (
                          <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
                            {user.displayName}
                          </div>
                        ) : null}
                      </div>
                      <span
                        className={`pill ${user.isAdmin ? "pill-ok" : user.isReadOnly ? "pill-warn" : "pill-dim"}`}
                      >
                        {roleLabel(user)}
                      </span>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button className="btn" disabled={busyUser} onClick={() => toggleAdmin(user)}>
                          {busyUser ? "保存中…" : user.isAdmin ? "移除管理员" : "设为管理员"}
                        </button>
                        <button className="btn" disabled={busyUser} onClick={() => toggleReadOnly(user)}>
                          {user.isReadOnly ? "恢复可写" : "设为只读"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="faint" style={{ marginTop: 12, fontSize: 12 }}>
              {isAdmin
                ? "管理员可管理用户、配置与维护；只读操作员仅可登录查看（后端对所有写请求统一 403）；普通用户可登录查看并修改自身显示名。"
                : "当前账号无管理员权限，只能查看。首个 OAuth 登录用户自动成为管理员。"}
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
