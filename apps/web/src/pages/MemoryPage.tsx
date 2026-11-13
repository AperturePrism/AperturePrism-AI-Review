import { SparkleIcon as PageIcon } from "../components/icons";
import type { ConsolePage } from "../lib/navigation";

/** 本页的位置与入口同处维护；导航由页面目录自动读取。 */
export const consolePages: ConsolePage[] = [{ path: "/memory", label: "记忆管理", group: "data", order: 46, icon: PageIcon, render: () => <MemoryPage /> }];

import { useCallback, useEffect, useState } from "react";
import {
  bumpCache,
  createRepoMemory,
  deleteRepoMemory,
  fetchMe,
  fetchRepoMemory,
  fetchRepositories,
  triggerMemoryConsolidation,
  type RepoMemoryItem,
  type RepoMemoryKind,
  type Repository,
} from "../lib/api";
import { RefreshIcon, SparkleIcon } from "../components/icons";
import { ErrorPanel, LoadingRows, fmtTime } from "../components/ui";
import { explainUnknown } from "../lib/errors";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll";
import { useToast } from "../components/Toast";

const KIND_LABEL: Record<string, string> = {
  reflection: "反思",
  rule: "规则",
  knowledge: "知识",
};

const KIND_TONE: Record<string, string> = {
  reflection: "pill-info",
  rule: "pill-ok",
  knowledge: "pill-vio",
};

const SOURCE_LABEL: Record<string, string> = {
  issue_analysis: "Issue 分析",
  pr_review: "PR 审查",
  consolidation: "合并沉淀",
};

export function MemoryPage() {
  const toast = useToast();
  const [items, setItems] = useState<RepoMemoryItem[]>([]);
  const [counts, setCounts] = useState({ reflection: 0, rule: 0, knowledge: 0 });
  const [nextOffset, setNextOffset] = useState<number | undefined>(undefined);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [repoFilter, setRepoFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // 新增规则/知识表单（issue #32：手动写入审核规则，bot 分析/审查时参考）。
  const [draft, setDraft] = useState({
    kind: "rule" as "rule" | "knowledge",
    title: "",
    content: "",
    repositoryId: "",
  });

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetchMe().catch(() => null),
      fetchRepoMemory({
        repositoryId: repoFilter || undefined,
        kind: (kindFilter || undefined) as RepoMemoryKind | undefined,
      }),
      fetchRepositories().catch(() => null),
    ])
      .then(([me, list, repoData]) => {
        setIsAdmin(me ? me.isAdmin || me.authMethod === "bearer" : false);
        setItems(list.items);
        setCounts(list.counts);
        setNextOffset(list.nextOffset);
        setRepos(repoData?.items ?? []);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "failed to load memory");
        setItems([]);
      })
      .finally(() => setLoading(false));
  }, [repoFilter, kindFilter]);

  useEffect(() => load(), [load]);

  const loadMore = async () => {
    // 没有在飞标志时，IntersectionObserver 会用同一个 offset 重复发起请求，
    // 结果被重复追加。
    if (nextOffset === undefined || loadingMore) return;
    setLoadingMore(true);
    try {
      const list = await fetchRepoMemory({
        repositoryId: repoFilter || undefined,
        kind: (kindFilter || undefined) as RepoMemoryKind | undefined,
        offset: nextOffset,
      });
      // 按 id 去重，避免服务端分页边界或重复触发导致同一条出现两次。
      setItems((prev) => {
        const seen = new Set(prev.map((item) => item.id));
        return [...prev, ...list.items.filter((item) => !seen.has(item.id))];
      });
      setNextOffset(list.nextOffset);
    } catch (err) {
      toast.error(`加载失败：${explainUnknown(err)}`);
    } finally {
      setLoadingMore(false);
    }
  };

  const hasMore = nextOffset !== undefined;
  const sentinelRef = useInfiniteScroll({
    hasMore,
    loading: loadingMore,
    onLoadMore: () => {
      void loadMore();
    },
  });

  const consolidate = async () => {
    setBusy("consolidate");
    try {
      const result = await triggerMemoryConsolidation();
      toast.success(`合并完成：处理 ${result.repositories} 个仓库，沉淀 ${result.rules} 条规则/知识。`);
      load();
    } catch (err) {
      toast.error(`合并失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (item: RepoMemoryItem) => {
    if (!window.confirm(`确定要删除记忆「${item.title.slice(0, 40)}」吗？`)) return;
    setBusy(item.id);
    try {
      await deleteRepoMemory(item.id);
      toast.success(`已删除「${item.title.slice(0, 40)}」。`);
      load();
    } catch (err) {
      toast.error(`删除失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    const title = draft.title.trim();
    const content = draft.content.trim();
    if (!title || !content) {
      toast.error("请填写标题与内容");
      return;
    }
    setBusy("create");
    try {
      await createRepoMemory({
        kind: draft.kind,
        title,
        content,
        ...(draft.repositoryId ? { repositoryId: draft.repositoryId } : {}),
      });
      toast.success(
        `已写入${draft.kind === "rule" ? "规则" : "知识"}「${title.slice(0, 40)}」，bot 后续分析/审查会参考它。`,
      );
      setDraft({ kind: "rule", title: "", content: "", repositoryId: "" });
      load();
    } catch (err) {
      toast.error(`写入失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(null);
    }
  };

  const repoName = (id: string | null) => {
    if (!id) return "全局";
    const repo = repos.find((r) => r.id === id);
    return repo ? repo.fullName : "未知仓库";
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">记忆管理</h1>
          <p className="page-desc">仓库记忆：从 Issue 分析与 PR 审查中沉淀的反思、规则与知识</p>
        </div>
        <div className="actions">
          {isAdmin ? (
            <button className="btn btn-primary" onClick={consolidate} disabled={busy === "consolidate" || loading}>
              <SparkleIcon size={16} />
              {busy === "consolidate" ? "合并中…" : "触发合并"}
            </button>
          ) : null}
          <button className="btn" onClick={() => { bumpCache(); load(); }} disabled={loading}>
            <RefreshIcon size={16} />
            刷新
          </button>
        </div>
      </div>

      {isAdmin ? (
        <section className="panel">
          <div className="panel-title">
            <h2><SparkleIcon size={14} /> 新增规则 / 知识</h2>
            <span className="faint" style={{ fontSize: 12 }}>
              手动写入审核规则或仓库知识，bot 后续的 Issue 分析 / PR 审查会参考（issue #32）
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select
              className="input"
              style={{ flex: "0 0 110px" }}
              value={draft.kind}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, kind: event.target.value as "rule" | "knowledge" }))
              }
              title="记忆类型"
            >
              <option value="rule">规则</option>
              <option value="knowledge">知识</option>
            </select>
            <select
              className="input"
              style={{ flex: "0 0 170px" }}
              value={draft.repositoryId}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, repositoryId: event.target.value }))
              }
              title="适用仓库（留空 = 全局）"
            >
              <option value="">全局（所有仓库）</option>
              {repos.map((repo) => (
                <option key={repo.id} value={repo.id}>{repo.fullName}</option>
              ))}
            </select>
            <input
              className="input"
              style={{ flex: "1 1 220px" }}
              placeholder="标题，如：本项目禁止直接改数据库 schema"
              value={draft.title}
              onChange={(event) => setDraft((prev) => ({ ...prev, title: event.target.value }))}
            />
          </div>
          <textarea
            className="input"
            rows={3}
            style={{ width: "100%", marginTop: 8, resize: "vertical" }}
            placeholder="内容，如：schema 变更必须先生成正式 Drizzle migration，再提交。"
            value={draft.content}
            onChange={(event) => setDraft((prev) => ({ ...prev, content: event.target.value }))}
          />
          <div style={{ marginTop: 8, display: "flex", justifyContent: "flex-end" }}>
            <button className="btn btn-primary" onClick={create} disabled={busy === "create"}>
              {busy === "create" ? "写入中…" : "写入记忆"}
            </button>
          </div>
        </section>
      ) : null}

      {error ? (
        <ErrorPanel error={error} onRetry={load} />
      ) : loading ? (
        <div className="panel"><LoadingRows /></div>
      ) : (
        <div className="stack">
          <div className="kpi-grid">
            <Kpi value={counts.reflection} label="反思" tone="info" />
            <Kpi value={counts.rule} label="规则" tone="ok" />
            <Kpi value={counts.knowledge} label="知识" tone="vio" />
          </div>

          <section className="panel">
            <div className="panel-title">
              <h2><SparkleIcon size={14} /> 记忆条目</h2>
              <span className="count">{items.length}</span>
            </div>

            <div className="filters" style={{ marginBottom: 10 }}>
              <select
                className="input"
                value={repoFilter}
                onChange={(event) => setRepoFilter(event.target.value)}
                aria-label="按仓库筛选"
              >
                <option value="">全部仓库</option>
                {repos.map((repo) => (
                  <option key={repo.id} value={repo.id}>{repo.fullName}</option>
                ))}
              </select>
              <div className="seg">
                {(["", "reflection", "rule", "knowledge"] as const).map((k) => (
                  <button key={k} className={kindFilter === k ? "on" : ""} onClick={() => setKindFilter(k)}>
                    {k === "" ? "全部类型" : KIND_LABEL[k]}
                  </button>
                ))}
              </div>
            </div>

            {items.length === 0 ? (
              <p className="faint" style={{ margin: 0, fontSize: 12 }}>
                暂无记忆。完成 Issue 分析或 PR 审查后会自动沉淀反思；管理员可点击「触发合并」将其合并为规则/知识。
              </p>
            ) : (
              <div className="tablewrap" style={{ marginTop: 10 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>类型</th>
                      <th>标题</th>
                      <th>内容预览</th>
                      <th>仓库</th>
                      <th>来源</th>
                      {isAdmin ? <th>操作</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id}>
                        <td className="mono" style={{ fontSize: 12 }}>{fmtTime(item.createdAt)}</td>
                        <td>
                          <span className={`pill ${KIND_TONE[item.kind] ?? "pill-dim"}`}>
                            {KIND_LABEL[item.kind] ?? item.kind}
                          </span>
                        </td>
                        <td style={{ fontWeight: 600 }}>
                          {item.title}
                          {item.kind === "reflection" && item.consolidated ? (
                            <span className="chip" style={{ marginLeft: 6 }}>已合并</span>
                          ) : null}
                        </td>
                        <td className="faint" style={{ fontSize: 12, maxWidth: 320 }}>
                          {item.content.length > 120 ? `${item.content.slice(0, 120)}…` : item.content}
                        </td>
                        <td className="mono" style={{ fontSize: 12 }}>{repoName(item.repositoryId)}</td>
                        <td>
                          <span className="chip">{SOURCE_LABEL[item.sourceType ?? ""] ?? item.sourceType ?? "—"}</span>
                        </td>
                        {isAdmin ? (
                          <td>
                            <button
                              className="btn"
                              style={{ padding: "4px 10px", fontSize: 12 }}
                              disabled={busy === item.id}
                              onClick={() => remove(item)}
                            >
                              {busy === item.id ? "删除中…" : "删除"}
                            </button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {hasMore ? (
              <div ref={sentinelRef} className="load-more-hint">
                向下滚动加载更多
              </div>
            ) : null}

            <p className="faint" style={{ marginTop: 12, fontSize: 12 }}>
              {isAdmin
                ? "反思（reflection）来自每次完成的 Issue 分析 / PR 审查；合并 Agent 定期（每 10 分钟）把未合并反思提炼为规则/知识，并回灌进后续分析上下文。手动写入的规则/知识（consolidated=true）立即生效，无需等待合并。"
                : "当前账号无管理员权限，只能查看；写入规则/知识、合并与删除需要管理员。"}
            </p>
          </section>
        </div>
      )}
    </div>
  );
}

function Kpi(props: { value: number; label: string; tone: string }) {
  return (
    <div className={`kpi ${props.tone}`}>
      <div className="kpi-value">{props.value}</div>
      <div className="kpi-label">{props.label}</div>
    </div>
  );
}
