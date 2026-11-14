import { ShieldIcon as PageIcon } from "../components/icons";
import type { ConsolePage } from "../lib/navigation";

/** 本页的位置与入口同处维护；导航由页面目录自动读取。 */
export const consolePages: ConsolePage[] = [{ path: "/security", label: "安全管理", group: "system", order: 51, icon: PageIcon, render: () => <SecurityPage /> }];

import { useCallback, useEffect, useState } from "react";
import {
  bumpCache,
  fetchAuditLog,
  fetchConfig,
  fetchSettings,
  fetchUsers,
  type AuditEntry,
  type RuntimeConfig,
  type SettingItem,
  type UserRow,
} from "../lib/api";
import { GearIcon, RefreshIcon, ShieldIcon } from "../components/icons";
import { ErrorPanel, LoadingRows } from "../components/ui";

const ACTION_TEXT: Record<string, string> = {
  "user.set_admin": "修改管理员角色",
  "backup.import": "导入配置备份",
  "setup.init": "一键初始化",
  "settings.update": "更新运行时设置",
  "label_rule.upsert": "保存标签规则",
  "label_rule.delete": "删除标签规则",
  "index.run": "触发索引",
  "index.rebuild": "重建索引",
};

function fmtTime(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

export function SecurityPage() {
  const [cfg, setCfg] = useState<RuntimeConfig | null>(null);
  const [settings, setSettings] = useState<SettingItem[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchConfig(), fetchSettings(), fetchUsers(), fetchAuditLog()])
      .then(([c, s, u, a]) => {
        setCfg(c);
        setSettings(s.items);
        setUsers(u);
        setAudit(a);
      })
      .catch((err: unknown) => {
        const messageText = err instanceof Error ? err.message : "failed to load security";
        setError(
          messageText.includes("403")
            ? "需要管理员权限（403）。当前账号未授予管理员角色。"
            : messageText,
        );
        setAudit([]);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  const webhookSetting = settings.find((s) => s.key === "github_webhook_enabled");
  const webhookOn = webhookSetting
    ? webhookSetting.value.trim() === "true"
    : Boolean(cfg?.githubWebhookConfigured);

  const admins = users.filter((u) => u.isAdmin);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">安全管理</h1>
          <p className="page-desc">访问控制、速率限制与操作审计</p>
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
          <div className="grid2">
            <section className="panel">
              <div className="panel-title"><h2><ShieldIcon size={14} /> 访问控制</h2></div>
              {cfg && (
                <dl className="kv">
                  <dt>WebUI 认证</dt>
                  <dd><span className={`pill ${cfg.webuiAuthEnabled ? "pill-ok" : "pill-dim"}`}>
                    {cfg.webuiAuthEnabled ? "Bearer 令牌已启用" : "开放模式（未设令牌）"}
                  </span></dd>
                  <dt>GitHub Webhook 入口</dt>
                  <dd><span className={`pill ${webhookOn ? "pill-ok" : "pill-dim"}`}>
                    {webhookOn ? "启用" : "停用"}
                  </span></dd>
                  <dt>GitHub OAuth 登录</dt>
                  <dd><span className={`pill ${cfg.oauthConfigured ? "pill-ok" : "pill-dim"}`}>
                    {cfg.oauthConfigured ? "已配置" : "未配置"}
                  </span></dd>
                  <dt>管理员</dt>
                  <dd>
                    {admins.length === 0 ? (
                      <span className="faint">无</span>
                    ) : (
                      <span className="tag-row">
                        {admins.map((u) => <span key={u.login} className="tag">{u.login}</span>)}
                      </span>
                    )}
                  </dd>
                </dl>
              )}
            </section>

            <section className="panel">
              <div className="panel-title"><h2><GearIcon size={14} /> 速率限制</h2><span className="count">每 IP / 每分钟</span></div>
              {cfg && (
                <dl className="kv">
                  <dt>WebUI API</dt>
                  <dd className="mono">{cfg.apiRateLimit} 次/分</dd>
                  <dt>GitHub Webhook</dt>
                  <dd className="mono">{cfg.webhookRateLimit} 次/分</dd>
                </dl>
              )}
              <p className="faint" style={{ marginTop: 12, fontSize: 12 }}>
                基于滑动令牌桶的内存限流；超限返回 429。修改需改环境变量并重启。
              </p>
            </section>
          </div>

          <section className="panel">
            <div className="panel-title"><h2><ShieldIcon size={14} /> 操作审计日志</h2><span className="count">{audit.length}</span></div>
            {audit.length === 0 ? (
              <p className="faint" style={{ margin: 0, fontSize: 12 }}>
                暂无审计记录。敏感操作（改管理员、导入备份、初始化、改设置、索引重建等）会自动记录。
              </p>
            ) : (
              <div className="tablewrap" style={{ marginTop: 6 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>操作者</th>
                      <th>操作</th>
                      <th>对象</th>
                      <th>来源 IP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.map((entry) => (
                      <tr key={entry.id}>
                        <td className="mono" style={{ fontSize: 12 }}>{fmtTime(entry.createdAt)}</td>
                        <td><span className="mono" style={{ fontSize: 12 }}>{entry.actor}</span></td>
                        <td><span className="chip">{ACTION_TEXT[entry.action] ?? entry.action}</span></td>
                        <td className="mono" style={{ fontSize: 12 }}>{entry.target ?? "—"}</td>
                        <td className="mono" style={{ fontSize: 12 }}>{entry.ip ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
