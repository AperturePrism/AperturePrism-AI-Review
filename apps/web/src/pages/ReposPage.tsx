import { FolderIcon as PageIcon } from "../components/icons";
import type { ConsolePage } from "../lib/navigation";

/** 本页的位置与入口同处维护；导航由页面目录自动读取。 */
export const consolePages: ConsolePage[] = [{ path: "/repos", label: "已安装仓库", group: "data", order: 40, icon: PageIcon, render: () => <ReposPage /> }];

import { useCallback, useEffect, useState } from "react";
import {
  bumpCache,
  fetchRepositories,
  fetchRepositorySettings,
  fetchRepoSubjects,
  saveRepositorySetting,
  syncRepositories,
  triggerManualTask,
  type Repository,
  type RepositorySettingItem,
  type RepoSubjectItem,
} from "../lib/api";
import { ArrowPathIcon, FolderIcon, GearIcon, RefreshIcon } from "../components/icons";
import { Empty, ErrorPanel, LoadingRows } from "../components/ui";
import { explainError, explainUnknown } from "../lib/errors";
import { enumOptionLabel } from "../lib/labels";
import { useToast } from "../components/Toast";
import { navigate } from "../hooks/useHash";

/**
 * 未覆盖时的实际生效值：仓库覆盖 → 全局 → 应用默认。
 *
 * 三层都要看：只看前两层的话，全局也没配时会把「默认开启」的项显示成关闭。
 */
function effectiveBool(item: RepositorySettingItem): boolean {
  const source = item.overridden
    ? item.value
    : item.globalValue || item.defaultValue;
  return source === "true";
}

/**
 * 单个仓库的设置面板。默认折叠：大多数仓库跟随全局，展开才拉取覆盖值，避免为
 * 每个卡片都发一次请求。
 */
function RepoSettings({ repo }: { repo: Repository }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<RepositorySettingItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchRepositorySettings(repo.id)
      .then((data) => {
        setItems(data.items);
        setDrafts({});
      })
      .catch((err: unknown) => {
        setError(explainUnknown(err));
        setItems(null);
      })
      .finally(() => setLoading(false));
  }, [repo.id]);

  useEffect(() => {
    if (open && items === null && !loading && !error) load();
  }, [open, items, loading, error, load]);

  const labelOf = (key: string) =>
    items?.find((item) => item.key === key)?.label ?? key;

  const save = async (key: string, value: string | null) => {
    setBusyKey(key);
    try {
      await saveRepositorySetting(repo.id, key, value);
      toast.success(
        value === null
          ? `已改为跟随全局：${labelOf(key)}`
          : `已保存仓库覆盖：${labelOf(key)}`,
      );
      const fresh = await fetchRepositorySettings(repo.id);
      setItems(fresh.items);
      setDrafts((prev) => ({ ...prev, [key]: "" }));
    } catch (err) {
      toast.error(`保存失败：${explainUnknown(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  if (!open) {
    return (
      <button
        className="btn"
        style={{ marginTop: 10, fontSize: 12 }}
        onClick={() => setOpen(true)}
      >
        <GearIcon size={14} />
        分析设置
      </button>
    );
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 12 }}>分析设置</span>
        <button className="btn" style={{ fontSize: 12 }} onClick={() => setOpen(false)}>
          收起
        </button>
      </div>
      {error ? (
        <ErrorPanel error={error} onRetry={load} />
      ) : loading || items === null ? (
        <LoadingRows />
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          {items.map((item) => {
            const busy = busyKey === item.key;
            const on = effectiveBool(item);
            return (
              <div
                key={item.key}
                style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{item.label}</span>
                  {item.overridden ? (
                    <span className="pill pill-info">本仓库覆盖</span>
                  ) : (
                    <span className="pill pill-dim">跟随全局</span>
                  )}
                </div>
                {item.kind === "boolean" ? (
                  <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={on}
                      aria-label={item.label}
                      className="switch"
                      data-on={on ? "true" : "false"}
                      disabled={busy}
                      onClick={() => void save(item.key, on ? "false" : "true")}
                    >
                      <span className="switch-knob" />
                    </button>
                    <span className="faint" style={{ fontSize: 12 }}>
                      {busy ? "保存中…" : on ? "已开启" : "已关闭"}
                    </span>
                    {item.overridden ? (
                      <button
                        className="btn"
                        style={{ fontSize: 12 }}
                        disabled={busy}
                        onClick={() => void save(item.key, null)}
                      >
                        跟随全局
                      </button>
                    ) : null}
                  </div>
                ) : item.kind === "enum" ? (
                  <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <select
                      className="input"
                      style={{ flex: "0 1 160px", fontSize: 12 }}
                      value={item.overridden ? item.value : (item.globalValue || item.defaultValue || "")}
                      disabled={busy}
                      onChange={(event) => void save(item.key, event.target.value)}
                    >
                      {(item.options ?? []).map((option) => (
                        <option key={option} value={option}>
                          {enumOptionLabel(item.key, option)}
                        </option>
                      ))}
                    </select>
                    {item.overridden ? (
                      <button
                        className="btn"
                        style={{ fontSize: 12 }}
                        disabled={busy}
                        onClick={() => void save(item.key, null)}
                      >
                        跟随全局
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <input
                      className="input"
                      style={{ flex: "1 1 160px", fontSize: 12 }}
                      placeholder={
                        item.overridden
                          ? item.value
                          : item.globalValue
                            ? `跟随全局：${item.globalValue}`
                            : "跟随全局（未设置）"
                      }
                      value={drafts[item.key] ?? ""}
                      onChange={(event) =>
                        setDrafts((prev) => ({ ...prev, [item.key]: event.target.value }))
                      }
                      data-lpignore="true"
                    />
                    <button
                      className="btn btn-primary"
                      style={{ fontSize: 12 }}
                      disabled={busy}
                      onClick={() => void save(item.key, (drafts[item.key] ?? "").trim())}
                    >
                      {busy ? "保存中…" : "保存"}
                    </button>
                    {item.overridden ? (
                      <button
                        className="btn"
                        style={{ fontSize: 12 }}
                        disabled={busy}
                        onClick={() => void save(item.key, null)}
                      >
                        跟随全局
                      </button>
                    ) : null}
                  </div>
                )}
                <p className="faint" style={{ margin: "6px 0 0", fontSize: 11 }}>
                  {item.hint}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ReposPage() {
  const [repos, setRepos] = useState<Repository[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // 是否真的能用 GitHub App（含 DB 覆盖）；为 false 时把空态引导到接入页。
  const [githubConfigured, setGithubConfigured] = useState(true);

  const [triggerType, setTriggerType] = useState<"issue" | "pr">("issue");
  const [triggerRepo, setTriggerRepo] = useState<string>("");
  const [triggerNumber, setTriggerNumber] = useState<string>("");
  const [triggerBusy, setTriggerBusy] = useState(false);
  const [subjects, setSubjects] = useState<RepoSubjectItem[]>([]);
  const [subjectsBusy, setSubjectsBusy] = useState(false);
  const [subjectsError, setSubjectsError] = useState<string | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const toast = useToast();

  const sync = async () => {
    setSyncBusy(true);
    try {
      const result = await syncRepositories();
      if (result.errors > 0) {
        // 失败时把原因讲清楚：原先直接显示 github_not_configured 这类机器码，
        // 用户无法据此知道该去哪里配置什么。
        const reasons = [
          ...new Set((result.details ?? []).map((d) => d.reason)),
        ];
        const explained = reasons.map(explainError).join("；");
        toast.error(
          explained ||
            `同步失败：${result.errors} 个安装未能同步，且未返回具体原因。`,
        );
      } else {
        toast.success(
          `已同步 ${result.synced} 个仓库（${result.installations} 个安装）${
            result.scanned ? "，已触发扫描/索引" : ""
          }`,
        );
      }
      bumpCache();
      load();
    } catch (err) {
      toast.error(explainUnknown(err));
    } finally {
      setSyncBusy(false);
    }
  };

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchRepositories()
      .then((data) => {
        setRepos(data.items);
        setGithubConfigured(data.githubConfigured ?? true);
      })
      .catch((err: unknown) => {
        setError(explainUnknown(err));
        setRepos(null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  // 选择仓库/类型后，拉取最近的 open Issue / PR 供下拉选择（也可手动输入编号）。
  useEffect(() => {
    if (!triggerRepo) {
      setSubjects([]);
      setSubjectsError(null);
      return;
    }
    let cancelled = false;
    setSubjectsBusy(true);
    setSubjectsError(null);
    fetchRepoSubjects(triggerRepo, triggerType)
      .then((items) => {
        if (!cancelled) {
          setSubjects(items);
          // 自动填入最近一条，省去手输编号。
          setTriggerNumber(items[0] ? String(items[0].number) : "");
        }
      })
      .catch((err: unknown) => {
        // 不能把加载失败伪装成「暂无条目」：用户会以为仓库真的没有 open 项，
        // 从而排查错方向。手动输入编号仍然可用。
        if (!cancelled) {
          setSubjects([]);
          setSubjectsError(explainUnknown(err));
        }
      })
      .finally(() => {
        if (!cancelled) setSubjectsBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [triggerRepo, triggerType]);

  const trigger = async () => {
    const number = Number(triggerNumber);
    if (!triggerRepo || !Number.isInteger(number) || number <= 0) {
      toast.error("请先选择仓库，再选择或填写一个正整数 Issue / PR 编号");
      return;
    }
    setTriggerBusy(true);
    try {
      const result = await triggerManualTask({
        type: triggerType,
        repositoryFullName: triggerRepo,
        subjectNumber: number,
      });
      toast.success(
        result.outcome === "requeued"
          ? `已重新入队，taskId：${result.taskId}`
          : result.outcome === "duplicate"
            ? result.taskStatus === "completed"
              ? `该版本已审核完成，无需重复触发，taskId：${result.taskId}`
              : `任务已在队列或执行中，无需重复触发，taskId：${result.taskId}`
            : `已创建任务，taskId：${result.taskId}`,
      );
    } catch (err) {
      toast.error(`触发失败：${explainUnknown(err)}`);
    } finally {
      setTriggerBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">已安装仓库</h1>
          <p className="page-desc">GitHub App 授权仓库及其分析任务 / 结果统计</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => { void sync(); }} disabled={syncBusy}>
            <ArrowPathIcon size={16} />
            {syncBusy ? "同步中…" : "同步仓库"}
          </button>
          <button className="btn" onClick={() => { bumpCache(); load(); }} disabled={loading}>
            <RefreshIcon size={16} />
            刷新
          </button>
        </div>
      </div>

      <section className="panel" style={{ padding: "10px 16px" }}>
        <p className="faint" style={{ margin: 0, fontSize: 12, lineHeight: 1.6 }}>
          新仓库需要先授权给 GitHub App：前往「
          <a
            href="#/github-access"
            onClick={(e) => { e.preventDefault(); navigate("/github-access"); }}
            style={{ color: "var(--accent-1, #3b82f6)", textDecoration: "underline" }}
          >
            GitHub 接入
          </a>
          」页在「安装并授权仓库」里把目标仓库挂到本应用下；授权后回到本页点「同步仓库」即可在这里出现并纳入扫描 / 分析。
        </p>
      </section>

      <section className="panel">
        <div className="panel-title">
          <h2>手动触发分析</h2>
          <span className="count">对已安装仓库的某个 Issue / PR 立即创建一个分析 / 审查任务</span>
        </div>
        <p className="faint" style={{ margin: "0 0 12px", fontSize: 12 }}>
          选择一个仓库后，下拉会列出它最近的 open Issue / PR（也可手动输入编号）；点击「触发分析」会绕过 Webhook，
          直接把该条目加入审查队列，分析完成后再发布评论 / Review。
        </p>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <select
            className="input"
            style={{ flex: "1 1 220px" }}
            value={triggerRepo}
            onChange={(event) => setTriggerRepo(event.target.value)}
            disabled={!repos || repos.length === 0}
          >
            <option value="">{repos && repos.length > 0 ? "选择仓库…" : "暂无可选仓库"}</option>
            {repos?.map((repo) => (
              <option key={repo.id} value={repo.fullName}>
                {repo.fullName}
              </option>
            ))}
          </select>
          <select
            className="input"
            style={{ flex: "0 1 120px" }}
            value={triggerType}
            onChange={(event) => setTriggerType(event.target.value === "pr" ? "pr" : "issue")}
          >
            <option value="issue">Issue</option>
            <option value="pr">PR</option>
          </select>
          <select
            className="input"
            style={{ flex: "1 1 260px", maxWidth: 360 }}
            value={subjects.some((s) => String(s.number) === triggerNumber) ? triggerNumber : ""}
            onChange={(event) => setTriggerNumber(event.target.value)}
            disabled={!triggerRepo || subjects.length === 0}
          >
            <option value="">
              {!triggerRepo
                ? "先选择仓库…"
                : subjectsBusy
                  ? "加载中…"
                  : subjectsError
                    ? "列表加载失败（可手动输入编号）"
                    : subjects.length === 0
                      ? "该仓库暂无 open 条目（可手动输入编号）"
                      : "选择最近的 Issue / PR…"}
            </option>
            {subjects.map((subject) => (
              <option key={subject.number} value={String(subject.number)}>
                #{subject.number} · {subject.title.slice(0, 40)}
              </option>
            ))}
          </select>
          <input
            className="input"
            style={{ flex: "0 1 110px" }}
            type="number"
            min={1}
            step={1}
            placeholder="编号，如 12"
            value={triggerNumber}
            onChange={(event) => setTriggerNumber(event.target.value)}
            data-lpignore="true"
          />
          <button className="btn btn-primary" onClick={trigger} disabled={triggerBusy || !triggerRepo}>
            {triggerBusy ? "触发中…" : "触发分析"}
          </button>
        </div>
        {subjectsError ? (
          <p className="faint" style={{ margin: "8px 0 0", fontSize: 12 }}>
            无法加载 Issue / PR 列表：{subjectsError} 仍可手动输入编号后触发。
          </p>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-title"><h2>仓库</h2><span className="count">{repos?.length ?? "–"}</span></div>

        {error ? (
          <ErrorPanel error={error} onRetry={load} />
        ) : loading ? (
          <LoadingRows />
        ) : !repos || repos.length === 0 ? (
          githubConfigured ? (
            <Empty icon={<FolderIcon size={32} />} title="暂无可追踪仓库" hint="请前往「GitHub 接入」页把仓库授权给 App，再点「同步仓库」即可出现在这里" />
          ) : (
            <div style={{ textAlign: "center" }}>
              <Empty
                icon={<GearIcon size={32} />}
                title="GitHub App 尚未配置"
                hint="无法访问 GitHub，因此看不到任何仓库。请先配置 App 凭据，再回到本页同步。"
              />
              <a className="btn btn-primary" href="#/github-access">
                <GearIcon size={15} />
                前往 GitHub 接入
              </a>
            </div>
          )
        ) : (
          <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px,1fr))" }}>
            {repos.map((repo) => (
              <div key={repo.id} className="result-card">
                <div className="result-title" style={{ marginBottom: 10 }}>
                  <FolderIcon size={16} /> {repo.name}
                  <span className="result-repo">· {repo.owner}</span>
                </div>
                <div className="result-meta" style={{ marginTop: 6 }}>
                  <span className="pill pill-info">{repo.taskCount} 任务</span>
                  <span className="pill pill-ok">{repo.resultCount} 结果</span>
                </div>
                <RepoSettings repo={repo} />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
