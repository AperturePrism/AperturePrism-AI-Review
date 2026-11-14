import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyUpdate,
  fetchUpdateProgress,
  fetchUpdateStatus,
  type UpdateHistoryEntry,
  type UpdateProgress,
  type UpdateStatus,
} from "../lib/api";
import { ArrowPathIcon, RefreshIcon } from "./icons";
import { fmtTime } from "./ui";
import { useToast } from "./Toast";

type LogLine = { level: string; message: string };
type UpdatePhase = "idle" | "applying" | "verifying" | "success" | "failed" | "timeout";
interface UpdateAttempt {
  id?: string;
  key?: string;
  target: string | null;
  startedAt: number;
  baseline: Set<string>;
}

const POLL_INTERVAL_MS = 3_000;
const VERIFY_TIMEOUT_MS = 3 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
// 允许 -beta/-rc 预发布后缀，否则灰度版本会被当成未知版本。
const VERSION_TAG = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const version = (value: string | null | undefined) =>
  value && VERSION_TAG.test(value) ? value.replace(/^v/, "") : null;
const entryKey = (entry: UpdateHistoryEntry) =>
  entry.id ?? `${entry.at}|${entry.from}|${entry.to}`;
const isActive = (entry: UpdateHistoryEntry) =>
  entry.status === "running" || entry.status === "pending";

/** 更新阶段的顺序与展示名（与 update.sh 的 stage 标记对应）。 */
const STAGES = ["backup", "pull", "migrate", "up", "health", "api", "done"] as const;
const STAGE_LABELS: Record<string, string> = {
  backup: "备份配置",
  pull: "拉取镜像",
  migrate: "数据库迁移",
  up: "重建容器",
  health: "健康检查",
  api: "重启 API 容器",
  done: "脚本执行完成，等待版本确认",
};
const STAGE_INDEX: Record<string, number> = Object.fromEntries(
  STAGES.map((s, i) => [s, i]),
);

/** 在线更新：脚本完成不等于新版本已运行，必须另行读取运行版本确认。 */
export function UpdatePanel() {
  const toast = useToast();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [metadataFresh, setMetadataFresh] = useState(false);
  const [history, setHistory] = useState<UpdateHistoryEntry[]>([]);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [serverBusy, setServerBusy] = useState<boolean | undefined>();
  const [progressReady, setProgressReady] = useState(false);
  const [checking, setChecking] = useState(false);
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [message, setMessage] = useState("");
  const [verification, setVerification] = useState<UpdateAttempt | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [stage, setStage] = useState<number>(-1);
  const [stageLabel, setStageLabel] = useState("");
  const [logsOpen, setLogsOpen] = useState(false);
  const mounted = useRef(false);
  const attemptRef = useRef<UpdateAttempt | null>(null);
  const statusRequest = useRef<AbortController | null>(null);
  const checkRequest = useRef<AbortController | null>(null);
  const applyRequest = useRef<AbortController | null>(null);
  const streamReader = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);

  const observeProgress = useCallback((progress: UpdateProgress) => {
    setHistory(progress.items);
    setCurrentVersion(progress.currentVersion ?? null);
    setServerBusy(progress.inProgress);
    setProgressReady(true);
  }, []);

  const refreshStatus = useCallback(async () => {
    statusRequest.current?.abort();
    const controller = new AbortController();
    statusRequest.current = controller;
    try {
      const next = await fetchUpdateStatus(controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setStatus(next);
      setMetadataFresh(true);
    } catch (err) {
      if (!mounted.current || controller.signal.aborted) return;
      setMetadataFresh(false);
      toast.error(err instanceof Error ? err.message : "检查更新失败");
    }
  }, [toast]);

  const startVerification = useCallback((attempt: UpdateAttempt) => {
    attemptRef.current = attempt;
    setPhase("verifying");
    setMessage("正在确认运行版本，请勿重复更新；连接中断或脚本结束不代表更新成功。");
    setVerification({ ...attempt });
  }, []);

  const check = useCallback(async () => {
    checkRequest.current?.abort();
    const controller = new AbortController();
    checkRequest.current = controller;
    setChecking(true);
    // 仓库查询可能很慢；进度恢复不等待仓库，也不在确认轮询中查仓库。
    await Promise.all([
      refreshStatus(),
      (async () => {
        try {
          const progress = await fetchUpdateProgress(controller.signal);
          if (!mounted.current || controller.signal.aborted) return;
          observeProgress(progress);
          const active = progress.items.find(isActive);
          const retained = attemptRef.current;
          if (retained) {
            startVerification(retained);
          } else if (active || progress.inProgress === true) {
            startVerification({
              ...(active ? { id: active.id, key: entryKey(active) } : {}),
              target: active?.to ?? null,
              startedAt: Date.now(),
              baseline: new Set(progress.items.map(entryKey)),
            });
          }
        } catch (err) {
          if (!mounted.current || controller.signal.aborted) return;
          setProgressReady(false);
          toast.error(err instanceof Error ? err.message : "读取更新进度失败，请手动检查");
        }
      })(),
    ]);
    if (mounted.current && !controller.signal.aborted) setChecking(false);
  }, [observeProgress, refreshStatus, startVerification, toast]);

  useEffect(() => {
    mounted.current = true;
    void check();
    return () => {
      mounted.current = false;
      statusRequest.current?.abort();
      checkRequest.current?.abort();
      applyRequest.current?.abort();
      void streamReader.current?.cancel().catch(() => undefined);
    };
  }, [check]);

  useEffect(() => {
    if (!verification) return;
    const attempt = { ...verification };
    attemptRef.current = attempt;
    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    let stopped = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let requestTimer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;

    const timeout = () => {
      if (stopped || !mounted.current) return;
      stopped = true;
      request?.abort();
      setPhase("timeout");
      setMessage("等待运行版本确认超时，尚未确认更新成功。请手动确认更新并检查服务与日志；不要重复触发更新。");
      setVerification(null);
    };
    const deadlineTimer = setTimeout(timeout, VERIFY_TIMEOUT_MS);

    const poll = async () => {
      request = new AbortController();
      requestTimer = setTimeout(() => request?.abort(), REQUEST_TIMEOUT_MS);
      try {
        const progress = await fetchUpdateProgress(request.signal);
        if (stopped || !mounted.current) return;
        if (Date.now() >= deadline) { timeout(); return; }
        observeProgress(progress);
        // 有 started.id 时只认该次更新；否则不拿旧的同版本历史冒充本次结果。
        let entry = progress.items.find((item) =>
          attempt.id ? item.id === attempt.id : attempt.key ? entryKey(item) === attempt.key : false,
        );
        if (!attempt.id && !attempt.key) {
          entry = progress.items.find((item) =>
            (isActive(item) && attempt.target === null) ||
            (!attempt.baseline.has(entryKey(item)) &&
              Date.parse(item.at) >= attempt.startedAt &&
              version(item.to) !== null && version(item.to) === version(attempt.target)),
          );
          if (entry) {
            attempt.id = entry.id;
            attempt.key = entryKey(entry);
            attempt.target ??= entry.to;
          }
        }
        if (entry?.status === "failed") {
          stopped = true;
          attemptRef.current = null;
          const reason = `更新失败：${entry.reason ?? "unknown"}`;
          setPhase("failed");
          setMessage(`${reason}。请检查日志并手动检查服务状态。`);
          setVerification(null);
          toast.error(reason);
          return;
        }
        const runtimeMatches = version(attempt.target) !== null &&
          version(progress.currentVersion) === version(attempt.target);
        const matchingAttempt = (!attempt.id && !attempt.key) ||
          Boolean(entry && version(entry.to) === version(attempt.target));
        // 两个进度字段都必须存在。旧 API 的 ok 或 SSE done.ok 不是运行版本证明。
        if (runtimeMatches && typeof progress.inProgress === "boolean" && matchingAttempt &&
          (entry?.status === "success" ||
            (progress.inProgress === false && !progress.items.some(isActive)))) {
          stopped = true;
          attemptRef.current = null;
          setPhase("success");
          setMetadataFresh(false);
          setMessage(`已确认运行版本：${progress.currentVersion}。更新成功。`);
          setVerification(null);
          toast.success(`已确认运行版本：${progress.currentVersion}`);
          // 不自动刷新：保留日志，并且只在运行版本确认后再刷新仓库状态。
          void refreshStatus();
          return;
        }
        setMessage(typeof progress.currentVersion !== "string" || typeof progress.inProgress !== "boolean"
          ? "服务尚未提供完整的运行版本确认信息，不能判定更新成功；请稍后手动检查。"
          : `正在确认运行版本：目标 ${attempt.target ?? "未知"}，当前 ${progress.currentVersion}。请勿重复更新。`);
      } catch (err) {
        if (stopped || !mounted.current) return;
        setMessage(`服务暂时不可达，正在重试确认运行版本（${err instanceof Error ? err.message : "连接中断"}）；尚未确认更新成功。`);
      } finally {
        clearTimeout(requestTimer);
        if (!stopped && mounted.current) pollTimer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(pollTimer);
      clearTimeout(requestTimer);
      clearTimeout(deadlineTimer);
      request?.abort();
    };
  }, [verification, observeProgress, refreshStatus, toast]);

  const runtimeVersion = currentVersion ?? status?.current.version;
  const authoritative = metadataFresh && status?.latest.source === "ghcr.io" &&
    status.latest.stale === false && !status.degraded &&
    version(status.latest.version) !== null && version(runtimeVersion) !== null &&
    Boolean(status.latest.digest) && status.latest.tags.includes(status.latest.version ?? "") &&
    typeof status.updateAvailable === "boolean";
  const updating = phase === "applying" || phase === "verifying";
  const inProgress = serverBusy ?? status?.inProgress ?? false;

  const update = async () => {
    const target = status?.latest.version;
    if (!authoritative || !target || !status.updateAvailable || attemptRef.current || updating || inProgress) return;
    const attempt: UpdateAttempt = {
      target,
      startedAt: Date.now(),
      baseline: new Set(history.map(entryKey)),
    };
    attemptRef.current = attempt;
    statusRequest.current?.abort();
    const controller = new AbortController();
    applyRequest.current = controller;
    setLogs([]);
    setStage(-1);
    setStageLabel("");
    setLogsOpen(false);
    setMessage("");
    setPhase("applying");
    let streamStarted = false;
    let failure: string | null = null;
    try {
      // 使用检查时的精确 semver tag，绝不把可变 latest 交给更新脚本。
      const body = await applyUpdate(target, true, controller.signal);
      if (!mounted.current || controller.signal.aborted) {
        void body?.cancel().catch(() => undefined);
        return;
      }
      if (body) {
        streamStarted = true;
        const reader = body.getReader();
        streamReader.current = reader;
        const decoder = new TextDecoder();
        let buffer = "";
        const handleEvent = (raw: string) => {
          const lines = raw.split(/\r?\n/);
          const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
          const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          let parsed: Record<string, unknown>;
          try {
            const value: unknown = JSON.parse(data);
            if (!value || typeof value !== "object" || Array.isArray(value)) return false;
            parsed = value as Record<string, unknown>;
          } catch { return false; }
          if (event === "started" && typeof parsed.id === "string" && version(String(parsed.target)) === version(target)) {
            attempt.id = parsed.id;
          } else if (event === "log") {
            setLogs((prev) => [...prev, { level: String(parsed.level ?? "info"), message: String(parsed.message ?? "") }]);
          } else if (event === "stage") {
            const s = String(parsed.stage ?? "");
            const idx = STAGE_INDEX[s] ?? -1;
            if (idx >= 0) {
              setStage(idx);
              setStageLabel(s === "done" ? STAGE_LABELS.done ?? "" : String(parsed.message ?? STAGE_LABELS[s] ?? s));
            }
          } else if (event === "done") {
            if (parsed.ok === false) failure = String(parsed.reason ?? "unknown");
            return true;
          }
          return false;
        };
        try {
          let terminal = false;
          while (!terminal) {
            const { value, done } = await reader.read();
            if (!mounted.current || controller.signal.aborted) return;
            buffer += decoder.decode(value, { stream: !done });
            let boundary: RegExpExecArray | null;
            while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
              const raw = buffer.slice(0, boundary.index);
              buffer = buffer.slice(boundary.index + boundary[0].length);
              if (handleEvent(raw)) { terminal = true; break; }
            }
            if (done) {
              if (buffer.trim() && !terminal) handleEvent(buffer);
              break;
            }
          }
        } finally {
          void reader.cancel().catch(() => undefined);
          reader.releaseLock();
          if (streamReader.current === reader) streamReader.current = null;
        }
      }
      if (failure !== null) {
        attemptRef.current = null;
        setPhase("failed");
        setMessage(`更新失败：${failure}。请检查日志并手动检查服务状态。`);
        toast.error(`更新失败：${failure}`);
      } else {
        startVerification(attempt);
      }
    } catch (err) {
      if (!mounted.current || controller.signal.aborted) return;
      if (streamStarted) {
        toast.info("更新连接已中断，正在确认运行版本；尚未确认更新成功。");
        startVerification(attempt);
      } else {
        attemptRef.current = null;
        const reason = err instanceof Error ? err.message : "更新失败";
        setPhase("failed");
        setMessage(reason);
        toast.error(reason);
      }
    }
  };

  const currentStageIdx = Math.max(stage, 0);
  const progressPct = Math.round(((currentStageIdx + 1) / STAGES.length) * 100);

  return (
    <section className="panel">
      <div className="panel-title">
        <h2><ArrowPathIcon size={14} /> 版本与更新</h2>
        <span className="count mono">{runtimeVersion ?? "…"}</span>
      </div>
      <p className="state" style={{ margin: 0 }}>
        当前版本 <b className="mono">{runtimeVersion ?? "未知"}</b>
        {authoritative ? <> · 最新 <b className="mono">{status?.latest.version}</b></> : null}
      </p>
      <p className="faint" style={{ margin: "6px 0 0", fontSize: 12 }}>
        <span className={`pill ${authoritative ? status?.updateAvailable ? "pill-warn" : "pill-ok" : "pill-warn"}`}>
          {authoritative ? status?.updateAvailable ? "发现新版本，可更新" : "已是最新版本" : "最新版本未知，镜像仓库不可用或元数据可能滞后，请稍后检查"}
        </span>
      </p>
      {inProgress ? (
        <p className="faint" style={{ margin: "6px 0 0", fontSize: 12 }}>
          <span className="pill pill-warn">更新正在进行中，请勿重复操作</span>
        </p>
      ) : null}
      <div className="filters" style={{ marginTop: 10 }}>
        <button className="btn" onClick={() => void check()} disabled={checking || updating}>
          <RefreshIcon size={14} />
          {checking ? "检查中…" : phase === "timeout" ? "手动确认更新" : "检查更新"}
        </button>
        <button
          className="btn btn-primary"
          onClick={() => void update()}
          disabled={updating || phase === "timeout" || checking || !progressReady || !authoritative || !status?.updateAvailable || inProgress}
          title={updating || inProgress || phase === "timeout" ? "已有更新等待运行版本确认，请勿重复操作" : !authoritative ? "最新版本尚未确认" : status && !status.updateAvailable ? "已是最新版本，无需更新" : undefined}
        >
          {phase === "verifying" ? "确认运行版本中…" : phase === "applying" ? "更新中…" : "更新到最新"}
        </button>
      </div>
      {message ? (
        <p className="faint" role="status" style={{ margin: "8px 0 0", fontSize: 12 }}>{message}</p>
      ) : null}
      {updating || logs.length > 0 ? (
        <div className="section" style={{ marginTop: 12 }}>
          {phase === "applying" ? <>
            <div className="update-progress">
              <div className="update-progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
            <p className="faint" style={{ margin: "8px 0 0", fontSize: 12 }}>
              {stage >= 0 ? `第 ${currentStageIdx + 1}/${STAGES.length} 步：${stageLabel || (STAGE_LABELS[STAGES[currentStageIdx] ?? ""] ?? "")}` : "准备更新…"}
            </p>
          </> : null}
          {logs.length > 0 ? (
            <details className="update-logs" open={logsOpen} onToggle={(e) => setLogsOpen(e.currentTarget.open)}>
              <summary className="faint" style={{ fontSize: 12, cursor: "pointer" }}>
                {logsOpen ? "收起详细日志" : `查看详细日志（${logs.length} 行）`}
              </summary>
              <pre className="jsonbox" style={{ maxHeight: 220, marginTop: 8 }}>
                {logs.map((line) => `[${line.level}] ${line.message}`).join("\n")}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}
      {history.length > 0 ? (
        <div className="section">
          <h4>更新历史</h4>
          <ul className="events">
            {history.slice(0, 10).map((entry) => {
              const active = isActive(entry);
              // 旧记录的 ok 只证明脚本退出成功，不宣称已观察到运行版本。
              const label = active ? entry.status === "running" ? "执行中" : "等待确认" : entry.status === "success" ? "成功" : entry.status === "failed" || !entry.ok ? "失败" : "脚本完成（未验证）";
              return (
                <li key={entryKey(entry)}>
                  <span className={`pill ${active || (!entry.status && entry.ok) ? "pill-warn" : entry.status === "success" ? "pill-ok" : "pill-err"}`}>{label}</span>
                  <span className="mono">{entry.from} → {entry.to}</span>
                  <span className="faint mono">{fmtTime(entry.at)}</span>
                  {entry.reason ? <span className="faint">（{entry.reason}）</span> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
