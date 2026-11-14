import { GridIcon as PageIcon } from "../components/icons";
import type { ConsolePage } from "../lib/navigation";

/** 本页的位置与入口同处维护；导航由页面目录自动读取。 */
export const consolePages: ConsolePage[] = [{ path: "/", label: "仪表盘", group: "home", order: 0, icon: PageIcon, render: ({ sse }) => <Overview sse={sse} /> }];

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { bumpCache, fetchHealth, fetchSummary, STATUS_ORDER, type ReadyHealth, type Summary } from "../lib/api";
import type { SseState } from "../hooks/useSse";
import { navigate } from "../hooks/useHash";
import { CheckCircleIcon, RefreshIcon, XCircleIcon } from "../components/icons";
import { Empty, ErrorPanel, JsonBlock } from "../components/ui";

const STATUS_TONE: Record<string, { c: string; label: string }> = {
  running: { c: "var(--accent-2)", label: "运行中" },
  queued: { c: "var(--warn)", label: "排队中" },
  publishing: { c: "var(--violet)", label: "发布中" },
  completed: { c: "var(--ok)", label: "已完成" },
  failed: { c: "var(--err)", label: "失败" },
  retry_wait: { c: "#c4b5fd", label: "重试等待" },
  canceled: { c: "var(--faint)", label: "已取消" },
};

export function Overview({ sse }: { sse: SseState }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [health, setHealth] = useState<ReadyHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setError(null);
    fetchSummary()
      .then(setSummary)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "failed"));
    setHealthError(null);
    fetchHealth()
      .then((result) => result.kind === "ready" && setHealth(result.data))
      .catch((err: unknown) => {
        setHealth(null);
        setHealthError(err instanceof Error ? err.message : "health failed");
      });
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const tasks = summary?.tasks;
  const byStatus = tasks?.byStatus ?? {};
  const running =
    (byStatus.running ?? 0) + (byStatus.leased ?? 0) + (byStatus.publishing ?? 0);
  const results = summary?.results ?? { issue: 0, pr: 0 };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">概览</h1>
          <p className="page-desc">任务、分析结果与模型路由的实时总览</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => { bumpCache(); refresh(); }}>
            <RefreshIcon size={16} />
            刷新
          </button>
        </div>
      </div>

      {error ? (
        <div className="panel">
          <ErrorPanel error={error} onRetry={refresh} />
        </div>
      ) : (
        <div className="kpi-grid">
          <Kpi value={tasks?.total ?? "–"} label="任务总数" tone="acc" icon={<ListIcon />} />
          <Kpi value={running} label="进行中" tone="info" icon={<SpinIcon />} />
          <Kpi value={byStatus.completed ?? 0} label="已完成" tone="ok" icon={<CheckCircleIcon />} />
          <Kpi value={byStatus.failed ?? 0} label="失败" tone="err" icon={<XCircleIcon />} />
          <Kpi value={results.issue} label="Issue 结果" tone="vio" icon={<BugIcon />} />
          <Kpi value={results.pr} label="PR 结果" tone="info" icon={<PullIcon />} />
        </div>
      )}

      <div className="grid2">
        <section className="panel">
          <div className="panel-title">
            <h2>任务状态分布</h2>
            <span className="count">{tasks?.total ?? "–"} total</span>
          </div>
          {!tasks ? (
            <p className="state state-empty">等待数据…</p>
          ) : (
            <div className="dist">
              {STATUS_ORDER.filter((s) => (byStatus[s] ?? 0) > 0).map((s) => {
                const total = Math.max(tasks.total, 1);
                const count = byStatus[s] ?? 0;
                const meta = STATUS_TONE[s] ?? { c: "var(--faint)", label: s };
                return (
                  <div className="dist-row" key={s}>
                    <span className="dist-label">{meta.label}</span>
                    <span className="dist-track">
                      <span className="dist-fill" style={{ width: `${Math.round((count / total) * 100)}%`, background: meta.c }} />
                    </span>
                    <span className="dist-val">{count}</span>
                  </div>
                );
              })}
            </div>
          )}
          <button className="detail-btn" onClick={() => navigate("/tasks")}>
            查看任务队列 →
          </button>
        </section>

        <HealthPanel health={health} error={healthError} />
      </div>

      <section className="panel">
        <div className="panel-title">
          <h2>实时事件流</h2>
          <span className="count">seq {sse.lastSeq || "–"}</span>
        </div>
        {sse.hasGap ? <div className="gap-banner">检测到序列缺口，可触发一次性回放</div> : null}
        {sse.status === "offline" ? (
          <p className="state state-error">事件流已断开，正在自动重连…</p>
        ) : sse.events.length === 0 ? (
          sse.status === "online" ? (
            <Empty title="等待事件" hint="发送 Webhook 或运行 Worker 后，任务状态将实时出现在这里" />
          ) : (
            <p className="state state-loading">正在建立事件流…</p>
          )
        ) : (
          <ul className="events">
            {sse.events.slice().reverse().map((event, index) => (
              <li key={`${event.seq}-${index}`}>
                <code className="ev-id">#{event.seq}</code>
                <span className="state-ok">{event.type}</span>
                <JsonBlock data={event.data} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Kpi(props: { value: ReactNode; label: string; tone: string; icon?: ReactNode }) {
  return (
    <div className={`kpi ${props.tone}`}>
      <div className="kpi-value">{props.value}</div>
      <div className="kpi-label">
        {props.icon}
        {props.label}
      </div>
    </div>
  );
}

function HealthPanel(props: { health: ReadyHealth | null; error: string | null }) {
  const deps = props.health
    ? [
        { name: "PostgreSQL", status: props.health.dependencies.database.status },
        { name: "Redis", status: props.health.dependencies.redis.status },
      ]
    : [];
  return (
    <section className="panel">
      <div className="panel-title">
        <h2>依赖健康</h2>
        <span className="count">{props.health ? (props.health.status === "ok" ? "ready" : "degraded") : "—"}</span>
      </div>
      {props.error ? (
        <p className="state state-error">无法连接 API：{props.error}</p>
      ) : !props.health ? (
        <p className="state state-loading">正在读取依赖状态…</p>
      ) : (
        <div className="dist">
          {deps.map((d) => (
            <div className="dist-row" key={d.name}>
              <span className="dist-label">
                {d.name === "PostgreSQL" ? <DatabaseIcon /> : <RedisIcon />}
                {d.name}
              </span>
              <span className="dist-track">
                <span
                  className="dist-fill"
                  style={{ width: "100%", background: d.status === "ok" ? "var(--ok)" : "var(--err)" }}
                />
              </span>
              <span className="dist-val">{d.status === "ok" ? "ok" : "down"}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ListIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  );
}
function SpinIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.5l5 3.5-5 3.5V8.5z" />
    </svg>
  );
}
function BugIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 9h8M9 14h6M12 4v4" />
      <rect x="8" y="8" width="8" height="10" rx="3" />
    </svg>
  );
}
function PullIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <path d="M6 8.5v7M18 21a3 3 0 100-6 3 3 0 000 6zM18 15V8.5c0-1-1-1.5-2-1.5h-2.5" />
      <path d="M15.5 9.5L18 7l2.5 2.5" />
    </svg>
  );
}
function DatabaseIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
    </svg>
  );
}
function RedisIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}