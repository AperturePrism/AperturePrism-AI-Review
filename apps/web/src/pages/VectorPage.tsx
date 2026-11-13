import { DatabaseIcon as PageIcon } from "../components/icons";
import type { ConsolePage } from "../lib/navigation";

/** 本页的位置与入口同处维护；导航由页面目录自动读取。 */
export const consolePages: ConsolePage[] = [{ path: "/vector", label: "向量存储", group: "data", order: 44, icon: PageIcon, render: () => <VectorPage /> }];

import { useCallback, useEffect, useState } from "react";
import {
  bumpCache,
  fetchIndexStatus,
  fetchVectorStats,
  rebuildIndex,
  triggerIndexRun,
  type IndexPassSummary,
  type VectorStats,
} from "../lib/api";
import { RefreshIcon } from "../components/icons";
import { ErrorPanel, LoadingRows, fmtTime } from "../components/ui";
import { explainUnknown } from "../lib/errors";
import { useToast } from "../components/Toast";

export function VectorPage() {
  const [stats, setStats] = useState<VectorStats | null>(null);
  const [index, setIndex] = useState<IndexPassSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const toast = useToast();

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchVectorStats(), fetchIndexStatus().catch(() => null)])
      .then(([statsData, indexData]) => {
        setStats(statsData);
        setIndex(indexData?.lastPass ?? null);
      })
      .catch((err: unknown) => {
        setError(explainUnknown(err));
        setStats(null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  const runIndex = async () => {
    setTriggering(true);
    try {
      await triggerIndexRun();
      toast.success("已触发索引，index-worker 将尽快开始一轮扫描。");
      // GET 有 5 秒缓存，不失效的话延迟刷新会读到旧状态，用户以为没生效。
      bumpCache();
      setTimeout(load, 4000);
    } catch (err) {
      toast.error(`触发失败：${explainUnknown(err)}`);
    } finally {
      setTriggering(false);
    }
  };

  const runRebuild = async () => {
    if (!window.confirm("确定要清空并重建全部向量索引吗？此操作将重新扫描所有仓库。")) return;
    setRebuilding(true);
    try {
      await rebuildIndex();
      toast.success("已清空索引并触发重建，index-worker 将重新扫描全部仓库。");
      bumpCache();
      setTimeout(load, 4000);
    } catch (err) {
      toast.error(`重建失败：${explainUnknown(err)}`);
    } finally {
      setRebuilding(false);
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">向量存储 &amp; 数据库</h1>
          <p className="page-desc">重复 Issue 检测的向量索引（issue_documents）与 Embedding 状态</p>
        </div>
        <div className="actions">
          <button className="btn btn-primary" onClick={runIndex} disabled={triggering || rebuilding}>
            {triggering ? "触发中…" : "开始索引"}
          </button>
          <button className="btn" onClick={runRebuild} disabled={rebuilding || triggering}>
            {rebuilding ? "重建中…" : "重建索引"}
          </button>
          <button className="btn" onClick={() => { bumpCache(); load(); }} disabled={loading}>
            <RefreshIcon size={16} />
            刷新
          </button>
        </div>
      </div>

      {error ? (
        <ErrorPanel error={error} onRetry={load} />
      ) : loading || !stats ? (
        <div className="panel"><LoadingRows /></div>
      ) : (
        <div className="stack">
          <div className="kpi-grid">
            <Kpi value={stats.documents} label="已索引文档" tone="acc" />
            <Kpi value={stats.withEmbedding} label="含向量" tone="info" />
            <Kpi value={stats.withSignals} label="含信号特征" tone="vio" />
            <Kpi value={stats.repositoryCoverage} label="覆盖仓库" tone="ok" />
            <Kpi value={stats.embeddingConfigured ? "on" : "off"} label="Embedding 引擎" tone={stats.embeddingConfigured ? "ok" : "err"} />
          </div>

          <section className="panel">
            <div className="panel-title"><h2>Embedding 配置</h2></div>
            <dl className="kv">
              <dt>模型</dt><dd className="mono">{stats.embeddingModel}</dd>
              <dt>维度</dt><dd className="mono">2048</dd>
              <dt>最近索引</dt><dd className="mono">{stats.lastIndexedAt ? fmtTime(stats.lastIndexedAt) : "尚未索引"}</dd>
              <dt>状态</dt>
              <dd>
                {stats.embeddingConfigured ? (
                  <span className="pill pill-ok">已启用</span>
                ) : (
                  <span className="pill pill-err">未配置（需 EMBEDDING_BASE_URL / API_KEY）</span>
                )}
              </dd>
            </dl>
            <p className="faint" style={{ marginTop: 12, fontSize: 12 }}>
              pgvector 2048 维先于 ANN 索引上限（2000），当前以精确顺序扫描召回，规模较小时可接受。
            </p>
          </section>

          <section className="panel">
            <div className="panel-title"><h2>最近索引轮次</h2></div>
            {index ? (
              <dl className="kv">
                <dt>轮次</dt><dd className="mono">#{index.pass}{index.rebuild ? "（重建）" : ""}</dd>
                <dt>完成时间</dt><dd className="mono">{fmtTime(index.finishedAt)}</dd>
                <dt>耗时</dt><dd className="mono">{(index.durationMs / 1000).toFixed(1)}s</dd>
                <dt>扫描仓库</dt><dd className="mono">{index.repos}（索引 {index.indexed} 条 · 未变化跳过 {index.skippedUnchanged} · 新向量 {index.embedded}）</dd>
                <dt>错误</dt>
                <dd>
                  {index.errors.length === 0 ? (
                    <span className="pill pill-ok">无</span>
                  ) : (
                    <ul style={{ margin: 0, paddingLeft: 16 }}>
                      {index.errors.map((item, i) => <li key={i} className="mono" style={{ fontSize: 12 }}>{item}</li>)}
                    </ul>
                  )}
                </dd>
              </dl>
            ) : (
              <p className="faint" style={{ margin: 0 }}>尚未完成任何索引轮次（index-worker 启动或触发后刷新）。</p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function Kpi(props: { value: number | string; label: string; tone: string }) {
  return (
    <div className={`kpi ${props.tone}`}>
      <div className="kpi-value">{props.value}</div>
      <div className="kpi-label">{props.label}</div>
    </div>
  );
}