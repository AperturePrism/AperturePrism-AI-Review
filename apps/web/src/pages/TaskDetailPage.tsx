import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import {
  cancelTasks,
  fetchTaskCheckRun,
  fetchTaskDetail,
  rerunTasks,
  type CheckRunStatus,
  type TaskDetail,
} from "../lib/api";
import { navigate } from "../hooks/useHash";
import { CANCELABLE_STATUS } from "./TasksPage";
import {
  AlertIcon,
  CheckCircleIcon,
  ClockIcon,
  CpuIcon,
  PlayIcon,
  XCircleIcon,
} from "../components/icons";
import { ErrorPanel, LoadingRows, StatusPill, TypeChip, fmtTime, timeAgo } from "../components/ui";
import { explainError } from "../lib/errors";
import { useToast } from "../components/Toast";

const EVENT_META: Record<
  string,
  { icon: (p: { size?: number }) => ReactElement; tone: string; label: string }
> = {
  "task.created": { icon: ClockIcon, tone: "info", label: "创建" },
  "task.leased": { icon: PlayIcon, tone: "info", label: "领取租约" },
  "task.started": { icon: PlayIcon, tone: "info", label: "开始处理" },
  "task.analysis_usage": { icon: CpuIcon, tone: "acc", label: "模型分析" },
  "task.publishing": { icon: CpuIcon, tone: "vio", label: "发布评论" },
  "task.completed": { icon: CheckCircleIcon, tone: "ok", label: "已完成" },
  "task.failed": { icon: XCircleIcon, tone: "err", label: "失败" },
  "task.retry_scheduled": { icon: AlertIcon, tone: "warn", label: "安排重试" },
};

type Usage = {
  model?: string; provider?: string; durationMs?: number;
  inputTokens?: number; outputTokens?: number;
};

export function TaskDetailPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkRun, setCheckRun] = useState<CheckRunStatus | null>(null);
  const [checkRunDegraded, setCheckRunDegraded] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const loadVersion = useRef(0);
  const toast = useToast();

  /** 失败/已取消任务重新入队。 */
  const rerun = async () => {
    setRerunning(true);
    try {
      const result = await rerunTasks([id]);
      toast.success(
        result.skipped > 0
          ? `重新入队 ${result.rerun} 个，跳过非终态 ${result.skipped} 个`
          : `已重新入队 ${result.rerun} 个任务`,
      );
      await load();
    } catch (err) {
      toast.error(`重新入队失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setRerunning(false);
    }
  };

  /** 手动取消运行中/排队/重试等待的任务。 */
  const cancel = async () => {
    if (!window.confirm("确定要取消该任务吗？运行中的任务将被中断，排队/等待重试的任务将移出队列。")) return;
    setCanceling(true);
    try {
      const result = await cancelTasks([id]);
      toast.success(
        result.skipped > 0
          ? `已取消 ${result.canceled} 个，跳过非活跃 ${result.skipped} 个`
          : "已取消任务",
      );
      await load();
    } catch (err) {
      toast.error(`取消失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setCanceling(false);
    }
  };

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    setError(null);
    // Invalidate the previous poll while a refresh/rerun fetch is in flight.
    setDetail(null);
    try {
      const result = await fetchTaskDetail(id);
      if (version === loadVersion.current) setDetail(result);
    } catch (err) {
      if (version === loadVersion.current) {
        setError(err instanceof Error ? err.message : "failed to load task");
      }
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
    return () => { loadVersion.current += 1; };
  }, [load]);

  // Scheduler cleanup is asynchronous: a terminal task can still have a pending
  // Check Run. Poll serially until both are terminal, including degraded reads.
  useEffect(() => {
    setCheckRun(null);
    setCheckRunDegraded(false);
    if (!detail || detail.id !== id) return;
    const hasCheckRun = (detail.publications ?? []).some(
      (pub) => pub.channel === "check_run",
    );
    if (!hasCheckRun) return;
    const isTerminal = detail.status === "completed" || detail.status === "failed" || detail.status === "canceled";
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let completed = false;
      try {
        const result = await fetchTaskCheckRun(id);
        if (disposed) return;
        const run = result.present ? result.checkRun ?? null : null;
        setCheckRun(run);
        setCheckRunDegraded(Boolean(result.degraded));
        completed = run?.status === "completed" && !result.degraded;
      } catch {
        if (disposed) return;
        setCheckRunDegraded(true);
      }
      if (!disposed && !(isTerminal && completed)) {
        timer = setTimeout(() => { void poll(); }, 5000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [detail, id]);

  if (error) {
    return (
      <div className="stack">
        <button className="btn btn-ghost" onClick={() => navigate("/tasks")}>← 返回任务列表</button>
        <div className="panel">
          <ErrorPanel error={error} onRetry={load} />
        </div>
      </div>
    );
  }

  if (loading || !detail) {
    return (
      <div className="stack">
        <button className="btn btn-ghost" onClick={() => navigate("/tasks")}>← 返回任务列表</button>
        <LoadingRows />
      </div>
    );
  }

  const payload = (detail.payload && typeof detail.payload === "object"
    ? detail.payload
    : {}) as Record<string, unknown>;
  const repo = typeof payload.repositoryFullName === "string" ? payload.repositoryFullName : "—";
  const usage = usageOf(detail);
  const attempts = [...detail.attempts].reverse();

  return (
    <div className="stack">
      <button className="btn btn-ghost" style={{ alignSelf: "flex-start" }} onClick={() => navigate("/tasks")}>
        ← 返回任务列表
      </button>

      <div className="detail-hero">
        <TypeChip type={detail.taskType} />
        <span className="big">{repo}</span>
        <span className="sep">·</span>
        <span className="big mono">#{detail.subjectNumber ?? "—"}</span>
        <StatusPill status={detail.status} />
        <span className="sep">·</span>
        <span className="chip mono">{detail.policyVersion}</span>
        <span className="sep">·</span>
        <span className="muted">{timeAgo(detail.updatedAt)}</span>
      </div>

      {detail.status === "failed" || detail.status === "canceled" || CANCELABLE_STATUS.has(detail.status) ? (
        <div className="actions" style={{ marginTop: 10 }}>
          {detail.status === "failed" || detail.status === "canceled" ? (
            <button className="btn btn-primary" onClick={rerun} disabled={rerunning || canceling}>
              {rerunning ? "入队中…" : "重新入队"}
            </button>
          ) : null}
          {CANCELABLE_STATUS.has(detail.status) ? (
            <button className="btn btn-danger" onClick={cancel} disabled={canceling || rerunning}>
              {canceling ? "取消中…" : "取消任务"}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="grid2">
        <section className="panel">
          <div className="panel-title"><h2>任务信息</h2></div>
          <dl className="kv">
            <dt>任务类型</dt><dd>{detail.taskType}</dd>
            <dt>仓库</dt><dd className="mono">{repo}</dd>
            <dt>对象</dt><dd className="mono">#{detail.subjectNumber ?? "—"}</dd>
            <dt>策略版本</dt><dd className="mono">{detail.policyVersion}</dd>
            <dt>尝试</dt><dd className="mono">{detail.attemptCount}/{detail.maxAttempts}</dd>
            {detail.lastErrorCategory ? (
              <>
                <dt>最后错误</dt>
                <dd>
                  <span className="pill pill-err">{detail.lastErrorCategory}</span>
                  <div className="faint" style={{ fontSize: 12, marginTop: 4, lineHeight: 1.6, maxWidth: 420 }}>
                    {explainError(detail.lastErrorCategory)}
                  </div>
                </dd>
              </>
            ) : null}
            <dt>创建时间</dt><dd className="mono muted">{fmtTime(detail.createdAt)}</dd>
            <dt>更新时间</dt><dd className="mono muted">{fmtTime(detail.updatedAt)}</dd>
          </dl>
        </section>

        <section className="panel">
          <div className="panel-title"><h2>模型用量</h2></div>
          {usage ? (
            <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(120px,1fr))" }}>
              <MiniStat value={`${usage.model ?? "—"}`} label="模型" accent />
              <MiniStat value={fmtMs(usage.durationMs)} label="耗时" accent />
              <MiniStat value={String(usage.inputTokens ?? "—")} label="输入 tokens" />
              <MiniStat value={String(usage.outputTokens ?? "—")} label="输出 tokens" />
              <MiniStat value={usage.provider ?? "—"} label="Provider" />
            </div>
          ) : (
            <p className="state state-empty">暂无模型调用记录</p>
          )}
        </section>
      </div>

      <section className="panel">
        <div className="panel-title">
          <h2>生命周期</h2>
          <span className="count">{detail.timeline.length} 事件</span>
        </div>
        {detail.timeline.length === 0 ? (
          <p className="state state-empty">暂无事件</p>
        ) : (
          <ul className="tl">
            {detail.timeline.map((event, index) => {
              const meta = EVENT_META[event.eventType] ?? { icon: ClockIcon, tone: "info", label: event.eventType };
              const Icon = meta.icon;
              const data = event.data as Record<string, unknown>;
              const isUsage = event.eventType === "task.analysis_usage";
              return (
                <li key={index} className={`tl-item ${meta.tone === "acc" ? "ok" : meta.tone}`}>
                  <span className="tl-icon"><Icon size={13} /></span>
                  <div className="tl-body">
                    <div className="tl-head">
                      <span className="tl-title"><code>{event.eventType}</code>{meta.label}</span>
                      <span className="tl-time">{fmtTime(event.createdAt)}</span>
                    </div>
                    {isUsage ? (
                      <div className="tl-detail">
                        {`model=${data.model}  provider=${data.provider}  ·  ${String(data.inputTokens ?? "-")} in / ${String(data.outputTokens ?? "-")} out  ·  ${fmtMs(typeof data.durationMs === "number" ? data.durationMs : undefined)}`}
                      </div>
                    ) : (
                      <div className="tl-detail">{JSON.stringify(data)}</div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="panel">
        <div className="panel-title">
          <h2>发布与外部对象</h2>
          <span className="count">{detail.publications?.length ?? 0} 条</span>
        </div>
        {(detail.publications ?? []).some((pub) => pub.channel === "check_run") ? (
          <div style={{ marginBottom: 12 }}>
            <span className="faint" style={{ fontSize: 12, marginRight: 8 }}>
              Check Run 实时状态：
            </span>
            {checkRun ? (
              <>
                <span className={`pill ${checkRunPillCls(checkRun)}`}>
                  {checkRunStatusText(checkRun)}
                </span>
                {checkRun.htmlUrl ? (
                  <a
                    href={checkRun.htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{ marginLeft: 10, fontSize: 12 }}
                  >
                    在 GitHub 查看 ↗
                  </a>
                ) : null}
              </>
            ) : checkRunDegraded ? (
              <span className="pill pill-dim">状态获取失败（GitHub 不可达或未配置）</span>
            ) : (
              <span className="pill pill-dim">查询中…</span>
            )}
          </div>
        ) : null}
        {detail.publications && detail.publications.length > 0 ? (
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr><th>渠道</th><th>外部 ID</th><th>时间</th></tr>
              </thead>
              <tbody>
                {detail.publications.map((pub, index) => {
                  const channelLabel = publicationChannelLabel(pub.channel);
                  const link = publicationLink(pub, payload);
                  return (
                    <tr key={index}>
                      <td>
                        <span className={`pill ${pub.channel === "check_run" ? "pill-ok" : "pill-dim"}`}>
                          {channelLabel}
                        </span>
                      </td>
                      <td className="mono">
                        {link ? (
                          <a href={link} target="_blank" rel="noreferrer">
                            {pub.externalObjectId ?? "—"} ↗
                          </a>
                        ) : (
                          pub.externalObjectId ?? "—"
                        )}
                      </td>
                      <td className="mono muted">{fmtTime(pub.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="state state-empty">暂无发布记录（任务尚未发布评论/Review/Check Run）</p>
        )}
        <p className="faint" style={{ marginTop: 10, fontSize: 12 }}>
          Check Run 会出现在 GitHub PR 页面的 Checks 区域，展示 AI 审查从「进行中」到「完成」的状态。
        </p>
      </section>

      <section className="panel">
        <div className="panel-title"><h2>Attempts</h2></div>
        {detail.attempts.length === 0 ? (
          <p className="state state-empty">暂无 attempt</p>
        ) : (
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr><th>#</th><th>Worker</th><th>开始</th><th>结束</th><th>耗时</th><th>错误</th></tr>
              </thead>
              <tbody>
                {attempts.map((attempt) => (
                  <tr key={attempt.attemptNumber}>
                    <td className="num">{attempt.attemptNumber}</td>
                    <td className="mono">{attempt.workerId}</td>
                    <td className="mono muted">{fmtTime(attempt.startedAt)}</td>
                    <td className="mono muted">{attempt.finishedAt ? fmtTime(attempt.finishedAt) : "—"}</td>
                    <td className="mono muted">
                      {compact(attempt.startedAt, attempt.finishedAt)}
                    </td>
                    <td>{attempt.errorCategory ? (
                      <div>
                        <span className="pill pill-err">{attempt.errorCategory}</span>
                        {explainError(attempt.errorCategory) !== attempt.errorCategory.trim() ? (
                          <div className="faint" style={{ fontSize: 12, marginTop: 4, lineHeight: 1.6, maxWidth: 400 }}>
                            {explainError(attempt.errorCategory)}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <span className="faint">—</span>
                    )}</td>
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

function publicationChannelLabel(channel: string): string {
  switch (channel) {
    case "check_run":
      return "Check Run";
    case "github_issue_comment":
      return "评论";
    case "github_pull_request_review":
      return "PR Review";
    default:
      return channel;
  }
}

function checkRunPillCls(run: CheckRunStatus): string {
  if (run.status === "completed") {
    if (run.conclusion === "success") return "pill-ok";
    if (run.conclusion === "failure") return "pill-err";
    return "pill-dim";
  }
  return "pill-warn";
}

function checkRunStatusText(run: CheckRunStatus): string {
  if (run.status === "completed") {
    const conclusion =
      run.conclusion === "success"
        ? "成功"
        : run.conclusion === "failure"
          ? "失败"
          : (run.conclusion ?? "完成");
    return `已完成 · ${conclusion}`;
  }
  if (run.status === "in_progress") return "进行中…";
  return "排队中…";
}

function publicationLink(
  pub: { channel: string; externalObjectId: string | null },
  payload: Record<string, unknown>,
): string | null {
  const repo =
    typeof payload.repositoryFullName === "string"
      ? payload.repositoryFullName
      : null;
  if (!repo) return null;
  if (pub.channel === "check_run") {
    // Check Run 由 GitHub 生成，指向 PR 的 Checks 区域。
    const number = typeof payload.subjectNumber === "number" ? payload.subjectNumber : null;
    return number
      ? `https://github.com/${repo}/pull/${number}/checks`
      : `https://github.com/${repo}`;
  }
  if (pub.channel === "github_issue_comment" && pub.externalObjectId) {
    return `https://github.com/${repo}/issues/${String(payload.subjectNumber ?? 0)}#issuecomment-${pub.externalObjectId}`;
  }
  if (pub.channel === "github_pull_request_review" && pub.externalObjectId) {
    return `https://github.com/${repo}/pull/${String(payload.subjectNumber ?? 0)}#pullrequestreview-${pub.externalObjectId}`;
  }
  return null;
}

function MiniStat(props: { value: string; label: string; accent?: boolean }) {
  return (
    <div className="kpi acc" style={{ padding: "12px 14px" }}>
      <div className="kpi-value" style={{ fontSize: 18 }}>{props.value}</div>
      <div className="kpi-label">{props.label}</div>
    </div>
  );
}

function usageOf(detail: TaskDetail): Usage | null {
  const evt = detail.timeline.find((e) => e.eventType === "task.analysis_usage");
  if (!evt) return null;
  const d = evt.data as Record<string, unknown>;
  return {
    model: typeof d.model === "string" ? d.model : undefined,
    provider: typeof d.provider === "string" ? d.provider : undefined,
    durationMs: typeof d.durationMs === "number" ? d.durationMs : undefined,
    inputTokens: typeof d.inputTokens === "number" ? d.inputTokens : undefined,
    outputTokens: typeof d.outputTokens === "number" ? d.outputTokens : undefined,
  };
}

function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function compact(start: string, end: string | null): string {
  if (!end) return "—";
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (Number.isNaN(s) || Number.isNaN(e)) return "—";
  const diff = e - s;
  if (diff < 0) return "—";
  if (diff < 1000) return `${diff}ms`;
  return `${(diff / 1000).toFixed(1)}s`;
}