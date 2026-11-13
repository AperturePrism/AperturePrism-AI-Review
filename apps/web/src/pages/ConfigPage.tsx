import { GearIcon as PageIcon } from "../components/icons";
import type { ConsolePage } from "../lib/navigation";

/** 本页的位置与入口同处维护；导航由页面目录自动读取。 */
export const consolePages: ConsolePage[] = [{ path: "/config", label: "系统配置", group: "system", order: 50, icon: PageIcon, render: () => <ConfigPage /> }];

import { useCallback, useEffect, useRef, useState } from "react";
import {
  bumpCache,
  fetchBackup,
  fetchConfig,
  fetchSettingsBootstrap,
  importBackup,
  type BootstrapStatus,
  type RuntimeConfig,
} from "../lib/api";
import { DownloadIcon, RefreshIcon, UploadIcon } from "../components/icons";
import { ErrorPanel, LoadingRows } from "../components/ui";
import { explainUnknown } from "../lib/errors";
import { UpdatePanel } from "../components/UpdatePanel";
import { SettingsSection } from "../components/SettingsSection";
import { useToast } from "../components/Toast";

function BoolBadge({ ok, yes = "已启用", no = "未配置" }: { ok: boolean; yes?: string; no?: string }) {
  return <span className={ok ? "pill pill-ok" : "pill pill-dim"}>{ok ? yes : no}</span>;
}

/**
 * 引导层健康度：只能来自环境变量的那几项。主密钥缺失时 Provider 凭据与
 * GitHub App 私钥都保存不了，而这件事此前只在保存失败时才暴露出来。
 */
function BootstrapPanel({ status }: { status: BootstrapStatus | null }) {
  if (!status) return null;
  return (
    <section className="panel">
      <div className="panel-title">
        <h2>引导配置</h2>
        <span className="count">只能由环境变量提供，无法保存到数据库</span>
      </div>
      <div className="stack" style={{ gap: 0 }}>
        {status.items.map((item) => (
          <div key={item.key} style={{ padding: "10px 0", borderTop: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="mono" style={{ fontSize: 12 }}>{item.key}</span>
              <BoolBadge ok={item.configured} yes="已配置" no="未配置" />
              <span style={{ fontSize: 12, fontWeight: 600 }}>{item.label}</span>
            </div>
            <p className="faint" style={{ margin: "4px 0 0", fontSize: 11 }}>{item.hint}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * 系统配置（瘦身后）：只保留没有专属功能页的全局运维项。
 * GitHub 接入 / 机器人 / 模型路由（含 Embedding）/ 分析设置 已各自拥有页面。
 */
export function ConfigPage() {
  const toast = useToast();
  const [cfg, setCfg] = useState<RuntimeConfig | null>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchConfig(), fetchSettingsBootstrap()])
      .then(([c, b]) => {
        setCfg(c);
        setBootstrap(b);
      })
      .catch((err: unknown) => {
        setError(explainUnknown(err));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  const [backupBusy, setBackupBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const doExport = async () => {
    setBackupBusy(true);
    try {
      const snapshot = await fetchBackup();
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `apertureprism-backup-${snapshot.exportedAt.slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast.success(
        `已导出：设置 ${snapshot.settings.length} 项（密钥值已脱敏）、策略 ${snapshot.policies.length} 条、Provider ${snapshot.providers.length} 个。`,
      );
    } catch (err) {
      toast.error(`导出失败：${explainUnknown(err)}`);
    } finally {
      setBackupBusy(false);
    }
  };

  const onFilePicked = async (file: File | undefined) => {
    if (!file) return;
    setBackupBusy(true);
    try {
      const text = await file.text();
      const snapshot = JSON.parse(text);
      const result = await importBackup(snapshot);
      toast.success(
        `导入完成：设置 ${result.settings} 项、策略 ${result.policies} 条；跳过密钥 ${result.skippedSecrets.join("/") || "无"}，Provider 账户需手工确认 ${result.skippedProviders.join("/") || "无"}。`,
      );
      bumpCache();
      load();
    } catch (err) {
      toast.error(`导入失败：${explainUnknown(err)}`);
    } finally {
      setBackupBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">系统配置</h1>
          <p className="page-desc">
            全局运维项；GitHub 接入 / 机器人 / 模型路由 / 分析设置在各自页面维护
          </p>
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
          <UpdatePanel />

          {bootstrap && !bootstrap.healthy ? (
            <section className="panel err-panel">
              <div className="panel-title"><h2>引导配置不完整</h2></div>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.7 }}>
                凭据主密钥（<span className="mono">CREDENTIAL_MASTER_KEY</span>）未配置：
                模型 Provider 凭据与 GitHub App 私钥都无法保存。请在部署的环境变量里提供
                一个 32 字节的 base64 密钥并重启。
              </p>
            </section>
          ) : null}

          <SettingsSection
            keys={[
              "webui_api_token",
              "log_level",
              "scan_enabled",
              "agent_team_enabled",
              "alert_webhook_url",
              "alert_queue_backlog_threshold",
              "alert_failed_tasks_threshold",
              "alert_stale_tasks_threshold",
            ]}
            title="全局运维"
            desc="访问令牌、日志级别、总开关与告警通知；其余配置请在各自功能页维护"
          />

          <BootstrapPanel status={bootstrap} />

          <section className="panel">
            <div className="panel-title"><h2>服务</h2></div>
            {cfg && (
              <dl className="kv">
                <dt>监听地址</dt><dd className="mono">{cfg.host}:{cfg.port}</dd>
                <dt>日志级别</dt><dd><span className="chip">{cfg.logLevel}</span></dd>
                <dt>WebUI 认证</dt><dd><BoolBadge ok={cfg.webuiAuthEnabled} /></dd>
                <dt>模型 Provider</dt>
                <dd>
                  {cfg.modelProviders.length > 0 ? (
                    <span className="tag-row">{cfg.modelProviders.map((p) => <span key={p} className="tag">{p}</span>)}</span>
                  ) : <span className="faint">未配置（前往「模型路由」）</span>}
                </dd>
                <dt>GitHub App</dt>
                <dd>
                  <BoolBadge ok={Boolean(cfg.githubAppConfigured)} yes="已配置" no="未配置" />
                  <span className="faint" style={{ fontSize: 11 }}>前往「GitHub 接入」</span>
                </dd>
                <dt>Embedding</dt>
                <dd>
                  <BoolBadge ok={cfg.embeddingConfigured} yes="已配置" no="未配置" />
                  <span className="faint" style={{ fontSize: 11 }}>前往「模型路由」</span>
                </dd>
              </dl>
            )}
          </section>

          <section className="panel">
            <div className="panel-title"><h2><DownloadIcon size={14} /> 配置备份</h2><span className="count">导出 / 导入设置与策略</span></div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button className="btn btn-primary" onClick={doExport} disabled={backupBusy}>
                <DownloadIcon size={14} />
                {backupBusy ? "处理中…" : "导出配置"}
              </button>
              <button className="btn" onClick={() => fileRef.current?.click()} disabled={backupBusy}>
                <UploadIcon size={14} />
                导入配置
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                style={{ display: "none" }}
                onChange={(event) => onFilePicked(event.target.files?.[0])}
              />
            </div>
            <p className="faint" style={{ marginTop: 12, fontSize: 12 }}>
              导出包含热更新设置、模型角色策略与 Provider 名称；密钥与未登记的键只导出「是否已配置」，不含值。导入仅恢复非密钥设置与策略。
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
