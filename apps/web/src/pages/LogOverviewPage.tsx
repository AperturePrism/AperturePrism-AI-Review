import { ActivityIcon as PageIcon } from "../components/icons";
import type { ConsolePage } from "../lib/navigation";

/** 本页的位置与入口同处维护；导航由页面目录自动读取。 */
export const consolePages: ConsolePage[] = [{ path: "/logs", label: "日志总览", group: "home", order: 1, icon: PageIcon, render: () => <LogOverviewPage /> }];

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  bumpCache,
  fetchConfig,
  fetchLogHistory,
  fetchLogs,
  fetchLogsSince,
  fetchSummary,
  type DeliveryEntry,
  type LogEvent,
  type RuntimeConfig,
  type Summary,
} from "../lib/api";
import { useSse } from "../hooks/useSse";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll";
import { eventsUrl } from "../lib/auth";
import { navigate } from "../hooks/useHash";
import { ActivityIcon, ArrowPathIcon, DatabaseIcon, RefreshIcon } from "../components/icons";
import { Empty, ErrorPanel, LoadingRows, fmtTime } from "../components/ui";
import { explainUnknown } from "../lib/errors";

const BOOKMARK_KEY = "ap.logview.bookmark";
const PROBLEM_EVENTS = new Set(["task.failed", "task.retry_scheduled", "task.lease_recovered"]);

const EVENT_TONE: Record<string, string> = {
  "task.completed": "pill-ok",
  "task.failed": "pill-err",
  "task.retry_scheduled": "pill-warn",
  "task.publishing": "pill-vio",
  "task.analysis_usage": "pill-info",
  "task.started": "pill-info",
  "task.leased": "pill-info",
  "task.created": "pill-dim",
  "task.heartbeat": "pill-dim",
};

const FILTERS = [
  { key: "task", label: "任务事件" },
  { key: "all", label: "含心跳" },
  { key: "problem", label: "失败与重试" },
] as const;

function eventKey(e: LogEvent): string {
  return `${e.createdAt}|${e.taskId}|${e.eventType}`;
}

export function LogOverviewPage() {
  const sse = useSse(eventsUrl());
  const [history, setHistory] = useState<LogEvent[]>([]);
  const [nextOffset, setNextOffset] = useState<number | undefined>(undefined);
  const [deliveries, setDeliveries] = useState<DeliveryEntry[]>([]);
  const [cfg, setCfg] = useState<RuntimeConfig | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [filter, setFilter] = useState<string>("task");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [resumed, setResumed] = useState(false);
  const [copied, setCopied] = useState(false);
  const bookmarkRef = useRef<string | null>(
    typeof localStorage === "undefined" ? null : localStorage.getItem(BOOKMARK_KEY),
  );

  const loadInitial = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetchLogHistory(0),
      fetchLogs(),
      fetchConfig(),
      fetchSummary(),
    ])
      .then(([page, bundle, c, s]) => {
        setHistory(page.events);
        setNextOffset(page.nextOffset);
        setDeliveries(bundle.deliveries);
        setCfg(c);
        setSummary(s);
      })
      // 这是诊断页：静默失败会显示「暂无日志」，反而掩盖了真正的故障。
      .catch((err: unknown) => setError(explainUnknown(err)))
      .finally(() => setLoading(false));
  }, []);

  // Resume from the saved bookmark: fetch events created after it.
  useEffect(() => {
    loadInitial();
    const bookmark = bookmarkRef.current;
    if (bookmark) {
      fetchLogsSince(bookmark)
        .then((inc) => {
          if (inc.events.length > 0) {
            setHistory((prev) => dedupeMerge(prev, inc.events));
            setResumed(true);
          }
        })
        .catch(() => undefined);
    }
  }, [loadInitial]);

  // Convert live SSE task frames into LogEvent rows.
  const liveEvents = useMemo<LogEvent[]>(() => {
    return sse.events
      .filter((e) => e.type === "task")
      .map((e) => {
        const d = (e.data ?? {}) as { taskId?: unknown; eventType?: unknown; data?: unknown; createdAt?: unknown };
        return {
          taskId: typeof d.taskId === "string" ? d.taskId : "",
          eventType: typeof d.eventType === "string" ? d.eventType : "task.event",
          data: d.data,
          createdAt: typeof d.createdAt === "string" ? d.createdAt : new Date().toISOString(),
        } as LogEvent;
      });
  }, [sse.events]);

  // Merge history + live, newest first, deduped.
  const rows = useMemo(() => {
    return dedupeMerge(history, liveEvents).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }, [history, liveEvents]);

  const visible = useMemo(() => {
    if (filter === "all") return rows;
    if (filter === "problem") return rows.filter((r) => PROBLEM_EVENTS.has(r.eventType));
    return rows.filter((r) => r.eventType !== "task.heartbeat");
  }, [rows, filter]);

  const problems = useMemo(
    () => rows.filter((r) => PROBLEM_EVENTS.has(r.eventType)).slice(0, 30),
    [rows],
  );

  // Persist the newest seen event as the bookmark (breakpoint save).
  useEffect(() => {
    const newest = rows[0];
    if (newest && typeof localStorage !== "undefined") {
      localStorage.setItem(BOOKMARK_KEY, newest.createdAt);
    }
  }, [rows]);

  const loadEarlier = useCallback(() => {
    if (nextOffset === undefined || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    fetchLogHistory(nextOffset)
      .then((page) => {
        setHistory((prev) => dedupeMerge(prev, page.events));
        setNextOffset(page.nextOffset);
      })
      // 翻页失败不该无声无息：否则用户滚到底看不到新内容，也不知道原因。
      .catch((err: unknown) => setMoreError(explainUnknown(err)))
      .finally(() => setLoadingMore(false));
  }, [nextOffset, loadingMore]);

  const hasMore = nextOffset !== undefined;
  const sentinelRef = useInfiniteScroll({
    hasMore,
    loading: loadingMore,
    onLoadMore: loadEarlier,
  });

  const copyDiagnostics = async () => {
    const bundle = buildBundle(rows, deliveries, cfg, summary);
    try {
      await navigator.clipboard.writeText(bundle);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = bundle;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">日志总览</h1>
          <p className="page-desc">任务事件历史 + 实时推送，支持断点续传与翻阅以往日志</p>
        </div>
        <div className="actions">
          <button className="btn btn-primary" onClick={copyDiagnostics} disabled={loading}>
            {copied ? "已复制到剪贴板 ✓" : "复制诊断包"}
          </button>
          <button className="btn" onClick={() => { bumpCache(); loadInitial(); }} disabled={loading}>
            <RefreshIcon size={16} />
            刷新
          </button>
        </div>
      </div>

      {resumed ? (
        <div className="gap-banner">
          <ArrowPathIcon size={14} />
          已从上次断点继续，补齐了你离开期间的事件
        </div>
      ) : null}

      {problems.length > 0 ? (
        <section className="panel" style={{ borderColor: "rgba(239,68,68,.35)" }}>
          <div className="panel-title">
            <h2 style={{ color: "var(--err)" }}>失败与重试</h2>
            <span className="count">{problems.length}</span>
          </div>
          <div className="tablewrap">
            <table className="table">
              <thead><tr><th>事件</th><th>任务</th><th>时间</th></tr></thead>
              <tbody>
                {problems.map((e, i) => (
                  <tr key={i} className="clickable" onClick={() => e.taskId && navigate(`/tasks/${e.taskId}`)}>
                    <td><span className={`pill ${EVENT_TONE[e.eventType] ?? "pill-warn"}`}>{e.eventType}</span></td>
                    <td className="mono faint">{short(e.taskId)}</td>
                    <td className="mono muted">{fmtTime(e.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-title">
          <h2><ActivityIcon size={14} /> 事件日志</h2>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span className="count">{visible.length} 条</span>
            <div className="seg">
              {FILTERS.map((f) => (
                <button key={f.key} className={filter === f.key ? "on" : ""} onClick={() => setFilter(f.key)}>
                  {f.label}
                </button>
              ))}
            </div>
            <span className={`status-badge status-${sse.status}`}>
              <span className="dot-pulse" /> {sse.status === "online" ? "实时" : sse.status}
            </span>
          </div>
        </div>

        {loading ? (
          <LoadingRows />
        ) : error ? (
          <ErrorPanel error={error} onRetry={loadInitial} />
        ) : visible.length === 0 ? (
          <Empty icon={<ActivityIcon size={34} />} title="暂无日志" hint="发送 Webhook 或运行 Worker 后，任务事件将出现在这里" />
        ) : (
          <div className="tablewrap" style={{ maxHeight: "62vh", overflow: "auto" }}>
            <table className="table">
              <thead>
                <tr><th>事件</th><th>任务</th><th>时间</th></tr>
              </thead>
              <tbody>
                {visible.map((e, i) => (
                  <tr key={`${eventKey(e)}-${i}`} className={e.taskId ? "clickable" : ""} onClick={() => e.taskId && navigate(`/tasks/${e.taskId}`)}>
                    <td>
                      <span className={`pill ${EVENT_TONE[e.eventType] ?? "pill-dim"}`}>{e.eventType}</span>
                      {sseHasDetail(e) ? <span className="faint" style={{ marginLeft: 8, fontSize: 11 }}>{usageSummary(e)}</span> : null}
                    </td>
                    <td className="mono faint">{e.taskId ? short(e.taskId) : "—"}</td>
                    <td className="mono muted">{fmtTime(e.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {hasMore || loadingMore ? (
          <div ref={sentinelRef} className="load-more-hint">
            {loadingMore
              ? "加载中…"
              : moreError
                ? `加载更早日志失败：${moreError}`
                : "向下滚动加载更早日志"}
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-title"><h2>Webhook 投递</h2><span className="count">{deliveries.length}</span></div>
        {deliveries.length === 0 ? (
          <Empty icon={<DatabaseIcon size={30} />} title="暂无 Webhook 投递" hint="GitHub 事件到达时会记录在这里" />
        ) : (
          <div className="tablewrap">
            <table className="table">
              <thead><tr><th>事件</th><th>状态</th><th>说明</th><th>时间</th></tr></thead>
              <tbody>
                {deliveries.map((d, i) => (
                  <tr key={i}>
                    <td><span className="chip">{d.eventName}</span></td>
                    <td><DeliveryPill status={d.status} /></td>
                    <td className="muted">{d.outcomeReason ?? "—"}</td>
                    <td className="mono muted">{fmtTime(d.receivedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/** Merges two lists of events, deduping by createdAt|taskId|eventType. */
function dedupeMerge(a: LogEvent[], b: LogEvent[]): LogEvent[] {
  const seen = new Set<string>();
  const out: LogEvent[] = [];
  for (const e of [...a, ...b]) {
    const key = eventKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function sseHasDetail(e: LogEvent): boolean {
  return e.eventType === "task.analysis_usage";
}

function usageSummary(e: LogEvent): string {
  const d = (e.data ?? {}) as Record<string, unknown>;
  if (typeof d.model !== "string") return "";
  const ms = typeof d.durationMs === "number" ? Math.round(d.durationMs / 100) / 10 : null;
  return `${d.model} · ${ms ?? "?"}s · ${String(d.inputTokens ?? "-")}in/${String(d.outputTokens ?? "-")}out`;
}

function DeliveryPill({ status }: { status: string }) {
  const tone = status === "completed" || status === "processed" ? "ok" : status === "failed" ? "err" : "warn";
  return <span className={`pill pill-${tone}`}>{status}</span>;
}

function buildBundle(
  rows: LogEvent[],
  deliveries: DeliveryEntry[],
  cfg: RuntimeConfig | null,
  summary: Summary | null,
): string {
  const lines: string[] = [];
  lines.push("AperturePrism 诊断包");
  lines.push("时间: " + new Date().toISOString());
  lines.push("");
  if (cfg) {
    lines.push("-- 运行配置 --");
    lines.push(`监听: ${cfg.host}:${cfg.port}  日志级别: ${cfg.logLevel}`);
    lines.push(`GitHub Webhook: ${cfg.githubWebhookConfigured ? "已配置" : "未配置"}`);
    lines.push(`GitHub App: ${cfg.githubAppConfigured ? "已配置" : "未配置"}`);
    lines.push(`WebUI 认证: ${cfg.webuiAuthEnabled ? "已启用" : "关闭"}`);
    lines.push(`模型 Provider: ${cfg.modelProviders.join(", ") || "无"}`);
    lines.push(`Embedding: ${cfg.embeddingConfigured ? `已配置 (${cfg.embeddingModel})` : "未配置"}`);
  }
  if (summary) {
    lines.push("");
    lines.push("-- 任务统计 --");
    lines.push(`任务总数: ${summary.tasks.total}  状态: ${JSON.stringify(summary.tasks.byStatus)}`);
  }
  const problems = rows.filter((r) => PROBLEM_EVENTS.has(r.eventType));
  lines.push("");
  lines.push(`-- 失败/重试事件 (${problems.length}) --`);
  problems.slice(0, 30).forEach((e) => lines.push(`${e.createdAt}  ${e.eventType}  ${e.taskId}`));
  lines.push("");
  lines.push(`-- 最近事件 (${rows.length}) --`);
  rows.slice(0, 60).forEach((e) => lines.push(`${e.createdAt}  ${e.eventType}  ${e.taskId}`));
  lines.push("");
  lines.push(`-- Webhook 投递 (${deliveries.length}) --`);
  deliveries.forEach((d) =>
    lines.push(`${d.receivedAt}  ${d.eventName}  ${d.status}  ${d.outcomeReason ?? ""}`.trimEnd()),
  );
  return lines.join("\n");
}

function short(id: string) {
  return id.length > 8 ? id.slice(0, 8) : id;
}