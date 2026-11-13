import { RadarIcon as PageIcon } from "../components/icons";
import type { ConsolePage } from "../lib/navigation";

/** 本页的位置与入口同处维护；导航由页面目录自动读取。 */
export const consolePages: ConsolePage[] = [{ path: "/scan", label: "仓库扫描", group: "data", order: 45, icon: PageIcon, render: () => <ScanPage /> }];

import { useCallback, useEffect, useState } from "react";
import {
  bumpCache,
  fetchScanRuns,
  fetchScansConfig,
  saveScansConfig,
  triggerScan,
  type ScanConfigItem,
  type ScanRun,
} from "../lib/api";
import { RadarIcon, RefreshIcon } from "../components/icons";
import { Empty, ErrorPanel, LoadingRows, fmtTime } from "../components/ui";
import { useToast } from "../components/Toast";

export function ScanPage() {
  const [config, setConfig] = useState<{ enabled: boolean; items: ScanConfigItem[] } | null>(null);
  const [runs, setRuns] = useState<ScanRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [globalBusy, setGlobalBusy] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  // Per-repo draft edits, keyed by repositoryId.
  const [drafts, setDrafts] = useState<Record<string, Partial<ScanConfigItem>>>({});
  const toast = useToast();

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchScansConfig(), fetchScanRuns(0, 30).catch(() => null)])
      .then(([cfg, runsData]) => {
        setConfig(cfg);
        setRuns(runsData?.items ?? []);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "failed to load scan config");
        setConfig(null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  const runScan = async () => {
    setTriggering(true);
    try {
      await triggerScan();
      toast.success("已触发仓库扫描，scan-worker 将在下一轮执行（1 分钟内）。");
      setTimeout(load, 4000);
    } catch (err) {
      toast.error(`触发失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setTriggering(false);
    }
  };

  const toggleGlobal = async () => {
    if (!config) return;
    setGlobalBusy(true);
    try {
      await saveScansConfig({ enabled: !config.enabled });
      toast.success(config.enabled ? "已暂停全局定时扫描（手动触发仍可用）" : "已启用全局定时扫描");
      bumpCache();
      load();
    } catch (err) {
      toast.error(`保存失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setGlobalBusy(false);
    }
  };

  const patch = (repositoryId: string, value: Partial<ScanConfigItem>) => {
    setDrafts((prev) => ({ ...prev, [repositoryId]: { ...prev[repositoryId], ...value } }));
  };

  const draftOf = (item: ScanConfigItem): ScanConfigItem => ({
    ...item,
    ...(drafts[item.repositoryId] ?? {}),
  });

  const saveRepo = async (item: ScanConfigItem) => {
    const draft = draftOf(item);
    setSaving(item.repositoryId);
    try {
      await saveScansConfig({
        repositoryId: item.repositoryId,
        enabled: draft.enabled,
        intervalMinutes: draft.intervalMinutes,
        maxIssues: draft.maxIssues,
        maxPrs: draft.maxPrs,
        autoAnalyzeIssues: draft.autoAnalyzeIssues,
        autoAnalyzePrs: draft.autoAnalyzePrs,
        createTrackingIssues: draft.createTrackingIssues,
      });
      toast.success(`${draft.fullName} 扫描配置已保存`);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[item.repositoryId];
        return next;
      });
      bumpCache();
      load();
    } catch (err) {
      toast.error(`保存失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setSaving(null);
    }
  };

  const num = (value: string, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">仓库扫描</h1>
          <p className="page-desc">定时扫描已安装仓库的 Issue / PR，自动创建分析任务与跟踪 Issue</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={runScan} disabled={triggering}>
            <RadarIcon size={16} />
            {triggering ? "触发中…" : "立即扫描"}
          </button>
          <button className="btn" onClick={() => { bumpCache(); load(); }} disabled={loading}>
            <RefreshIcon size={16} />
            刷新
          </button>
        </div>
      </div>

      {error ? (
        <ErrorPanel error={error} onRetry={load} />
      ) : loading || !config ? (
        <div className="panel"><LoadingRows /></div>
      ) : (
        <div className="stack">
          <section className="panel">
            <div className="panel-title">
              <h2>全局开关</h2>
              <span className="count">控制所有仓库的定时扫描（手动「立即扫描」始终可用）</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span className={config.enabled ? "pill pill-ok" : "pill pill-dim"}>
                {config.enabled ? "定时扫描已启用" : "定时扫描已暂停"}
              </span>
              <button className="btn" onClick={toggleGlobal} disabled={globalBusy}>
                {globalBusy ? "保存中…" : config.enabled ? "暂停定时扫描" : "启用定时扫描"}
              </button>
            </div>
          </section>

          <section className="panel">
            <div className="panel-title">
              <h2>仓库扫描配置</h2>
              <span className="count">{config.items.length} 个仓库</span>
            </div>
            {config.items.length === 0 ? (
              <Empty
                icon={<RadarIcon size={32} />}
                title="暂无已安装仓库"
                hint="同步 GitHub App 安装仓库后，可在此逐仓库配置扫描"
              />
            ) : (
              <div className="tablewrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>仓库</th>
                      <th>启用</th>
                      <th>间隔（分钟）</th>
                      <th>上限 Issue / PR</th>
                      <th>自动分析</th>
                      <th>跟踪 Issue</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {config.items.map((item) => {
                      const draft = draftOf(item);
                      const dirty = Boolean(drafts[item.repositoryId]);
                      return (
                        <tr key={item.repositoryId}>
                          <td>
                            <span className="mono">{draft.fullName}</span>
                            {!item.installed && <span className="pill pill-dim">未安装</span>}
                          </td>
                          <td>
                            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <input
                                type="checkbox"
                                checked={draft.enabled}
                                onChange={(event) => patch(item.repositoryId, { enabled: event.target.checked })}
                              />
                            </label>
                          </td>
                          <td>
                            <input
                              className="input"
                              style={{ width: 88 }}
                              type="number"
                              min={1}
                              value={draft.intervalMinutes}
                              onChange={(event) =>
                                patch(item.repositoryId, { intervalMinutes: num(event.target.value, draft.intervalMinutes) })
                              }
                              data-lpignore="true"
                            />
                          </td>
                          <td>
                            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                              <input
                                className="input"
                                style={{ width: 64 }}
                                type="number"
                                min={1}
                                value={draft.maxIssues}
                                onChange={(event) =>
                                  patch(item.repositoryId, { maxIssues: num(event.target.value, draft.maxIssues) })
                                }
                                data-lpignore="true"
                              />
                              <span className="faint">/</span>
                              <input
                                className="input"
                                style={{ width: 64 }}
                                type="number"
                                min={1}
                                value={draft.maxPrs}
                                onChange={(event) =>
                                  patch(item.repositoryId, { maxPrs: num(event.target.value, draft.maxPrs) })
                                }
                                data-lpignore="true"
                              />
                            </div>
                          </td>
                          <td>
                            <div style={{ display: "flex", gap: 12, whiteSpace: "nowrap" }}>
                              <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12 }}>
                                <input
                                  type="checkbox"
                                  checked={draft.autoAnalyzeIssues}
                                  onChange={(event) => patch(item.repositoryId, { autoAnalyzeIssues: event.target.checked })}
                                />
                                Issue
                              </label>
                              <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12 }}>
                                <input
                                  type="checkbox"
                                  checked={draft.autoAnalyzePrs}
                                  onChange={(event) => patch(item.repositoryId, { autoAnalyzePrs: event.target.checked })}
                                />
                                PR
                              </label>
                            </div>
                          </td>
                          <td>
                            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <input
                                type="checkbox"
                                checked={draft.createTrackingIssues}
                                onChange={(event) =>
                                  patch(item.repositoryId, { createTrackingIssues: event.target.checked })
                                }
                              />
                            </label>
                          </td>
                          <td>
                            <button
                              className="btn"
                              onClick={() => saveRepo(item)}
                              disabled={!dirty || saving === item.repositoryId}
                            >
                              {saving === item.repositoryId ? "保存中…" : "保存"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-title"><h2>扫描历史</h2><span className="count">{runs.length} 条</span></div>
            {runs.length === 0 ? (
              <p className="faint" style={{ margin: 0 }}>
                尚无扫描记录。scan-worker 运行后（或点击「立即扫描」）会在这里出现每次扫描结果。
              </p>
            ) : (
              <div className="tablewrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>仓库</th>
                      <th>触发</th>
                      <th>状态</th>
                      <th>Issue / PR</th>
                      <th>新任务</th>
                      <th>跟踪 Issue</th>
                      <th>跳过</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((run) => (
                      <tr key={run.id}>
                        <td className="mono">{fmtTime(run.startedAt)}</td>
                        <td className="mono">{run.repositoryFullName ?? "–"}</td>
                        <td>{run.trigger === "manual" ? "手动" : "定时"}</td>
                        <td>
                          {run.status === "running" ? (
                            <span className="pill pill-info">运行中</span>
                          ) : run.status === "failed" ? (
                            <span className="pill pill-err" title={run.error ?? ""}>失败</span>
                          ) : (
                            <span className="pill pill-ok">完成</span>
                          )}
                        </td>
                        <td className="mono">{run.scannedIssues} / {run.scannedPrs}</td>
                        <td className="mono">
                          {run.createdIssueTasks} Issue · {run.createdPrTasks} PR
                        </td>
                        <td className="mono">{run.createdTrackingIssues}</td>
                        <td className="mono">{run.skipped}</td>
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
