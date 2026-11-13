import { GaugeIcon as PageIcon } from "../components/icons";
import type { ConsolePage } from "../lib/navigation";

/** 本页的位置与入口同处维护；导航由页面目录自动读取。 */
export const consolePages: ConsolePage[] = [{ path: "/ops", label: "运维", group: "data", order: 49, icon: PageIcon, render: () => <OpsPage /> }];

import { useCallback, useEffect, useState } from "react";
import {
  fetchAlerts,
  fetchMetrics,
  type AlertRecord,
  type MetricsDurationBucket,
  type MetricsSnapshot,
} from "../lib/api";
import { AlertIcon, GaugeIcon, RefreshIcon } from "../components/icons";
import { ErrorPanel, LoadingRows, fmtTime } from "../components/ui";

function GaugeCard({
  label,
  value,
  unit,
}: {
  label: string;
  value: number | undefined;
  unit?: string;
}) {
  return (
    <div className="result-card" style={{ flex: "1 1 180px", textAlign: "center" }}>
      <div style={{ fontSize: 26, fontWeight: 700 }}>
        {value === undefined ? "—" : value}
        {unit ? <span style={{ fontSize: 13, opacity: 0.6 }}> {unit}</span> : null}
      </div>
      <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>
        {label}
      </div>
    </div>
  );
}

function avgMs(bucket?: MetricsDurationBucket): string {
  if (!bucket || bucket.count === 0) return "—";
  return `${(bucket.totalMs / bucket.count).toFixed(0)} ms`;
}

/**
 * 运维总览：进程内指标 + 库内实时量规。数据来自 GET /metrics（管理员）。
 * 第一版只读展示；后续可在此页接告警规则。
 */
export function OpsPage() {
  const [data, setData] = useState<MetricsSnapshot | null>(null);
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchMetrics(), fetchAlerts()])
      .then(([snapshot, alertItems]) => {
        setData(snapshot);
        setAlerts(alertItems);
      })
      .catch((err: unknown) => {
        const messageText = err instanceof Error ? err.message : "failed to load metrics";
        setError(
          messageText.includes("403")
            ? "需要管理员权限（403）。"
            : messageText,
        );
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  // 每 15s 自动刷新实时量规与告警（与 Overview/BotPage 一致），无需手动点刷新。
  useEffect(() => {
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const counters = data?.counters ?? {};
  const durations = data?.durations ?? {};
  const gauges = data?.gauges ?? {};

  const webhookOutcomes = Object.entries(counters).filter(([key]) =>
    key.startsWith("webhook.outcome."),
  );

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">运维</h1>
          <p className="page-desc">
            运行时指标（进程内计数 + 库内实时量规）；数据从本次启动开始累计
          </p>
        </div>
        <div className="actions">
          <button className="btn" onClick={load} disabled={loading}>
            <RefreshIcon size={16} />
            刷新
          </button>
        </div>
      </div>

      {error ? (
        <ErrorPanel error={error} onRetry={load} />
      ) : loading && !data ? (
        <div className="panel"><LoadingRows /></div>
      ) : (
        <div className="stack">
          <section className="panel">
            <div className="panel-title"><h2><GaugeIcon size={14} /> 实时量规</h2></div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <GaugeCard label="待处理任务（队列）" value={gauges["queue.depth"]} />
              <GaugeCard label="在途任务" value={gauges["tasks.inflight"]} />
              <GaugeCard label="已追踪仓库" value={gauges["repositories.count"]} />
              <GaugeCard label="失败任务（死信）" value={gauges["tasks.failed"]} />
              <GaugeCard
                label="滞留任务（心跳超时）"
                value={gauges["tasks.stale"]}
              />
            </div>
            {(gauges["tasks.failed"] ?? 0) > 0 ||
            (gauges["tasks.stale"] ?? 0) > 0 ? (
              <p className="faint" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--warn)" }}>
                有失败/滞留任务：可到「审查队列」勾选失败任务重新入队；滞留任务会由租约
                恢复机制自动回收（lease 过期后重新可领取）。
              </p>
            ) : null}
          </section>

          {alerts.length > 0 ? (
            <section className="panel">
              <div className="panel-title">
                <h2>
                  <AlertIcon size={14} /> 系统告警
                </h2>
              </div>
              <div className="stack">
                {alerts.map((alert) => (
                  <div
                    key={alert.id}
                    className={`result-card ${
                      alert.status === "active"
                        ? alert.severity === "critical"
                          ? "status-error"
                          : "status-warn"
                        : "status-dim"
                    }`}
                  >
                    <div style={{ flex: "1 1 auto" }}>
                      <div className="result-title">{alert.message}</div>
                      <div className="faint" style={{ fontSize: 12 }}>
                        {alert.status === "active" ? "持续中" : "已恢复"} ·{" "}
                        {alert.status === "active" ? "首次出现" : "最后出现"}{" "}
                        {fmtTime(alert.status === "active" ? alert.firstAt : alert.lastAt)}
                      </div>
                    </div>
                    <span
                      className={`pill ${
                        alert.severity === "critical"
                          ? "pill-error"
                          : alert.severity === "warning"
                          ? "pill-warn"
                          : "pill-info"
                      }`}
                    >
                      {alert.severity}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="panel">
            <div className="panel-title"><h2>请求与 Webhook</h2></div>
            <dl className="kv">
              <dt>API 请求总数</dt><dd>{counters["http.requests"] ?? 0}</dd>
              <dt>5xx 错误</dt><dd>{counters["http.errors_5xx"] ?? 0}</dd>
              <dt>平均请求耗时</dt><dd>{avgMs(durations["http.request_ms"])}</dd>
              <dt>Webhook 投递</dt><dd>{counters["webhook.deliveries"] ?? 0}</dd>
            </dl>
            {webhookOutcomes.length > 0 ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                {webhookOutcomes.map(([key, value]) => (
                  <span key={key} className="pill pill-dim">
                    {key.replace("webhook.outcome.", "")} · {value}
                  </span>
                ))}
              </div>
            ) : null}
          </section>

          <section className="panel">
            <div className="panel-title"><h2>仓库同步</h2></div>
            <dl className="kv">
              <dt>同步次数</dt><dd>{counters["repositories.sync_runs"] ?? 0}</dd>
              <dt>平均同步耗时</dt><dd>{avgMs(durations["repositories.sync_ms"])}</dd>
              <dt>累计清理仓库（取消授权/移除安装）</dt>
              <dd>{counters["repositories.sync_removed"] ?? 0}</dd>
            </dl>
          </section>

          <p className="faint" style={{ margin: 0, fontSize: 12 }}>
            {data
              ? `指标自 ${new Date(data.since).toLocaleString()} 起累计。当前为进程内快照，容器重启会清零。`
              : null}
          </p>
        </div>
      )}
    </div>
  );
}
