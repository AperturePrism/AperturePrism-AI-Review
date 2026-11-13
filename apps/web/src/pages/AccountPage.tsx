import { UserCircleIcon as PageIcon } from "../components/icons";
import type { ConsolePage } from "../lib/navigation";

/** 本页的位置与入口同处维护；导航由页面目录自动读取。 */
export const consolePages: ConsolePage[] = [{ path: "/account", label: "个人设置", group: "system", order: 54, hidden: true, icon: PageIcon, render: () => <AccountPage /> }];

import { useCallback, useEffect, useState } from "react";
import { bumpCache, fetchMe, saveMe, type AccountInfo } from "../lib/api";
import { GearIcon, RefreshIcon } from "../components/icons";
import { ErrorPanel, LoadingRows } from "../components/ui";
import { useToast } from "../components/Toast";

export function AccountPage() {
  const toast = useToast();
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchMe()
      .then((value) => {
        setAccount(value);
        setDraft(value.displayName ?? "");
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "failed to load account");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  const save = async () => {
    setBusy(true);
    try {
      const updated = await saveMe(draft);
      setAccount(updated);
      setDraft(updated.displayName ?? "");
      toast.success("显示名已保存。");
    } catch (err) {
      toast.error(`保存失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">个人设置</h1>
          <p className="page-desc">当前登录账号与个性化设置</p>
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
      ) : loading || !account ? (
        <div className="panel"><LoadingRows /></div>
      ) : (
        <div className="stack">
          <section className="panel">
            <div className="panel-title"><h2><GearIcon size={14} /> 账号</h2></div>
            <dl className="kv">
              <dt>登录方式</dt>
              <dd>
                {account.authMethod === "oauth" ? (
                  <span className="pill pill-ok">GitHub OAuth</span>
                ) : (
                  <span className="pill pill-dim">Bearer 令牌（未绑定账号）</span>
                )}
              </dd>
              <dt>GitHub 登录名</dt>
              <dd className="mono">{account.login ?? "—"}</dd>
            </dl>
            {account.authMethod === "bearer" ? (
              <p className="faint" style={{ marginTop: 12, fontSize: 12 }}>
                当前使用 WebUI 访问令牌登录，未关联 GitHub 账号。用 GitHub OAuth 登录后可保存显示名等个人设置。
              </p>
            ) : null}
          </section>

          {account.authMethod === "oauth" ? (
            <section className="panel">
              <div className="panel-title"><h2>显示名</h2></div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <input
                  className="input"
                  style={{ flex: "1 1 260px" }}
                  value={draft}
                  maxLength={120}
                  placeholder="自定义显示名（留空则用登录名）"
                  onChange={(event) => setDraft(event.target.value)}
                />
                <button className="btn btn-primary" onClick={save} disabled={busy}>
                  {busy ? "保存中…" : "保存"}
                </button>
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
