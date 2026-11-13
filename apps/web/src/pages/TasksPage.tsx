import { ListIcon as PageIcon } from "../components/icons";
import type { ConsolePage } from "../lib/navigation";
import { TaskDetailPage } from "./TaskDetailPage";

/** 本页的位置与入口同处维护；导航由页面目录自动读取。 */
export const consolePages: ConsolePage[] = [{ path: "/tasks", label: "审查队列", group: "analysis", order: 22, icon: PageIcon, render: ({ route }) => route.startsWith("/tasks/") && route.length > 7 ? <TaskDetailPage id={route.slice(7)} /> : <TasksPage /> }];

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  bumpCache,
  cancelTasks,
  fetchTasks,
  rerunTasks,
  type TaskList,
  type TaskSummary,
} from "../lib/api";
import { navigate } from "../hooks/useHash";
import { ChevronRightIcon, RefreshIcon, SearchIcon } from "../components/icons";
import { Empty, ErrorPanel, LoadingRows, StatusPill, TypeChip, timeAgo } from "../components/ui";
import { explainUnknown } from "../lib/errors";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll";
import { useToast } from "../components/Toast";

const TYPE_FILTERS = ["all", "issue_analysis", "pr_review", "repository_index"] as const;
const STATUS_FILTERS = ["all", "queued", "running", "publishing", "completed", "failed", "retry_wait", "canceled"] as const;
/** 非终态任务：可手动取消（与后端 cancelTask 的活跃状态集合一致，含 leased）。 */
export const CANCELABLE_STATUS = new Set(["queued", "leased", "running", "publishing", "retry_wait"]);
export type SortKey = "subjectNumber" | "status" | "attempt" | "updatedAt" | "policy";

/** 任务表格列（列自定义用；key 持久化到 localStorage）。 */
const TASK_COLUMNS = [
  { key: "type", label: "类型" },
  { key: "subject", label: "对象" },
  { key: "status", label: "状态" },
  { key: "policy", label: "策略" },
  { key: "attempt", label: "尝试" },
  { key: "error", label: "上次错误" },
  { key: "updatedAt", label: "更新时间" },
] as const;
export type TaskColumnKey = (typeof TASK_COLUMNS)[number]["key"];
const COLUMNS_STORAGE_KEY = "apertureprism.tasks.columns";

function loadHiddenColumns(): Set<TaskColumnKey> {
  try {
    const raw = localStorage.getItem(COLUMNS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((k): k is TaskColumnKey => typeof k === "string"));
  } catch {
    return new Set();
  }
}
export type SortState = { key: SortKey; dir: "asc" | "desc" };

/** 按指定列对任务排序（纯函数，供组件与单元测试复用）。 */
export function sortTasks<T extends { subjectNumber?: number | null; status: string; attemptCount: number; policyVersion: string; updatedAt: string }>(
  items: T[],
  sort: SortState,
): T[] {
  const dir = sort.dir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    switch (sort.key) {
      case "subjectNumber": {
        const aN = a.subjectNumber ?? null;
        const bN = b.subjectNumber ?? null;
        if (aN === null && bN === null) return 0;
        if (aN === null) return 1; // 无编号的任务始终排最后
        if (bN === null) return -1;
        return (aN - bN) * dir;
      }
      case "status":
        return a.status.localeCompare(b.status) * dir;
      case "attempt":
        return (a.attemptCount - b.attemptCount) * dir;
      case "policy":
        return a.policyVersion.localeCompare(b.policyVersion) * dir;
      case "updatedAt":
      default:
        return a.updatedAt.localeCompare(b.updatedAt) * dir;
    }
  });
}

export function TasksPage() {
  const [list, setList] = useState<TaskList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [type, setType] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "updatedAt",
    dir: "desc",
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rerunning, setRerunning] = useState(false);
  const [canceling, setCanceling] = useState<Set<string>>(new Set());
  const [hiddenColumns, setHiddenColumns] = useState<Set<TaskColumnKey>>(loadHiddenColumns);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const toast = useToast();

  const toggleColumn = (key: TaskColumnKey) => {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const toggleSort = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "updatedAt" ? "desc" : "asc" },
    );
  };

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchTasks({ limit: 50 })
      .then(setList)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "failed to load tasks");
        setList(null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => refresh(), [refresh]);

  const loadMore = useCallback(() => {
    if (!list || list.nextOffset === undefined || loadingMore) return;
    setLoadingMore(true);
    fetchTasks({ limit: 50, offset: list.nextOffset })
      .then((more) => {
        const seen = new Set(list.items.map((t) => t.id));
        const fresh = more.items.filter((t) => !seen.has(t.id));
        setList({ items: [...list.items, ...fresh], nextOffset: more.nextOffset });
      })
      // 翻页失败要让用户知道，否则滚到底没反应会以为没有更多数据。
      .catch((err: unknown) =>
        toast.error(`加载更多任务失败：${explainUnknown(err)}`),
      )
      .finally(() => setLoadingMore(false));
  }, [list, loadingMore, toast]);

  const hasMore = list?.nextOffset !== undefined;
  const sentinelRef = useInfiniteScroll({
    hasMore,
    loading: loadingMore,
    onLoadMore: loadMore,
  });

  const items = useMemo(() => {
    if (!list) return [];
    const q = search.toLowerCase();
    return sortTasks(
      list.items.filter(
        (t) =>
          (type === "all" || t.taskType === type) &&
          (status === "all" || t.status === status) &&
          (!q || t.id.includes(q) || String(t.subjectNumber ?? "").includes(q) || t.policyVersion.toLowerCase().includes(q) || t.status.includes(q)),
      ),
      sort,
    );
  }, [list, type, status, search, sort]);

  const rerunnable = useMemo(
    () => new Set(items.filter((t) => t.status === "failed" || t.status === "canceled").map((t) => t.id)),
    [items],
  );

  const cancelable = useMemo(
    () => new Set(items.filter((t) => CANCELABLE_STATUS.has(t.status)).map((t) => t.id)),
    [items],
  );

  const selectedRerunnable = useMemo(
    () => new Set([...selected].filter((id) => rerunnable.has(id))),
    [selected, rerunnable],
  );
  const selectedCancelable = useMemo(
    () => new Set([...selected].filter((id) => cancelable.has(id))),
    [selected, cancelable],
  );

  const toggleSelected = (id: string) => {
    if (!rerunnable.has(id) && !cancelable.has(id)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllActionable = () => {
    const actionable = new Set([...rerunnable, ...cancelable]);
    if (actionable.size === 0) return;
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = [...actionable].every((id) => next.has(id));
      for (const id of actionable) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const clearSelected = () => setSelected(new Set());

  const doRerun = async () => {
    const ids = [...selectedRerunnable];
    if (ids.length === 0) return;
    if (!window.confirm(`确定要重新执行选中的 ${ids.length} 个任务吗？失败/已取消任务将回到队列重新运行。`)) return;
    setRerunning(true);
    try {
      const result = await rerunTasks(ids);
      toast.success(
        `已重新入队 ${result.rerun} 个任务${result.skipped > 0 ? `，跳过 ${result.skipped} 个（非失败/取消状态）` : ""}`,
      );
      setSelected(new Set());
      bumpCache();
      refresh();
    } catch (err) {
      toast.error(`重跑失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setRerunning(false);
    }
  };

  const doCancel = async (ids: string[]) => {
    if (ids.length === 0) return;
    if (!window.confirm(`确定要取消选中的 ${ids.length} 个任务吗？运行中的任务将被中断，排队/等待重试的任务将移出队列。`)) return;
    setCanceling(new Set(ids));
    try {
      const result = await cancelTasks(ids);
      toast.success(
        `已取消 ${result.canceled} 个任务${result.skipped > 0 ? `，跳过 ${result.skipped} 个（非活跃状态）` : ""}`,
      );
      setSelected(new Set());
      bumpCache();
      refresh();
    } catch (err) {
      toast.error(`取消失败：${explainUnknown(err)}`);
    } finally {
      setCanceling(new Set());
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">任务队列</h1>
          <p className="page-desc">Issue 分析与 PR 审查任务的执行状态</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => { bumpCache(); refresh(); }} disabled={loading}>
            <RefreshIcon size={16} />
            刷新
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">
          <h2>筛选</h2>
        </div>
        <div className="filters">
          <div className="seg">
            {TYPE_FILTERS.map((t) => (
              <button key={t} className={type === t ? "on" : ""} onClick={() => setType(t)}>
                {t === "all" ? "全部类型" : TypeChipLabel(t)}
              </button>
            ))}
          </div>
          <div className="seg">
            {STATUS_FILTERS.map((s) => (
              <button key={s} className={status === s ? "on" : ""} onClick={() => setStatus(s)}>
                {s === "all" ? "全部状态" : s}
              </button>
            ))}
          </div>
          <label className="searchbox">
            <SearchIcon size={15} />
            <input
              className="input"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索任务 ID / 对象 / 策略…"
              aria-label="搜索任务"
            />
          </label>
        </div>
      </div>

      <section className="panel">
        <div className="panel-title">
          <h2>任务</h2>
          <span className="count">{items.length} 条</span>
          {selected.size > 0 ? (
            <span className="count" style={{ marginLeft: 8 }}>
              已选 {selected.size} 项
            </span>
          ) : null}
        </div>

        <div className="filters" style={{ marginBottom: 14, gap: 10 }}>
          <div style={{ position: "relative" }}>
            <button className="btn" onClick={() => setColumnsOpen((v) => !v)}>
              列设置
            </button>
            {columnsOpen ? (
              <div
                className="column-menu"
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  left: 0,
                  zIndex: 20,
                  background: "var(--panel-2)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: "8px 10px",
                  display: "grid",
                  gap: 6,
                  minWidth: 150,
                }}
              >
                {TASK_COLUMNS.map((col) => (
                  <label key={col.key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={!hiddenColumns.has(col.key)}
                      onChange={() => toggleColumn(col.key)}
                    />
                    {col.label}
                  </label>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        {rerunnable.size > 0 || cancelable.size > 0 ? (
          <div className="filters" style={{ marginBottom: 14, gap: 10 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={[...rerunnable, ...cancelable].every((id) => selected.has(id)) && selected.size > 0}
                onChange={toggleAllActionable}
              />
              全选可操作（{rerunnable.size + cancelable.size}）
            </label>
            {selected.size > 0 ? (
              <>
                {selectedRerunnable.size > 0 ? (
                  <button className="btn btn-primary" onClick={() => void doRerun()} disabled={rerunning || canceling.size > 0}>
                    {rerunning ? "重跑中…" : `重新执行（${selectedRerunnable.size}）`}
                  </button>
                ) : null}
                {selectedCancelable.size > 0 ? (
                  <button
                    className="btn btn-danger"
                    onClick={() => void doCancel([...selectedCancelable])}
                    disabled={canceling.size > 0 || rerunning}
                  >
                    {canceling.size > 0 ? "取消中…" : `取消（${selectedCancelable.size}）`}
                  </button>
                ) : null}
                <button className="btn" onClick={clearSelected} disabled={rerunning || canceling.size > 0}>
                  取消选择
                </button>
              </>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <ErrorPanel error={error} onRetry={refresh} />
        ) : loading ? (
          <LoadingRows />
        ) : items.length === 0 ? (
          <Empty title="暂无任务" hint="通过 GitHub Webhook 或任务 API 创建任务后，将在这里显示" />
        ) : (
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 32 }}></th>
                  {!hiddenColumns.has("type") ? <th>类型</th> : null}
                  {!hiddenColumns.has("subject") ? (
                    <SortableTh label="对象" active={sort.key === "subjectNumber"} dir={sort.dir} onClick={() => toggleSort("subjectNumber")} />
                  ) : null}
                  {!hiddenColumns.has("status") ? (
                    <SortableTh label="状态" active={sort.key === "status"} dir={sort.dir} onClick={() => toggleSort("status")} />
                  ) : null}
                  {!hiddenColumns.has("policy") ? (
                    <SortableTh label="策略" active={sort.key === "policy"} dir={sort.dir} onClick={() => toggleSort("policy")} />
                  ) : null}
                  {!hiddenColumns.has("attempt") ? (
                    <SortableTh label="尝试" active={sort.key === "attempt"} dir={sort.dir} onClick={() => toggleSort("attempt")} />
                  ) : null}
                  {!hiddenColumns.has("error") ? <th>上次错误</th> : null}
                  {!hiddenColumns.has("updatedAt") ? (
                    <SortableTh label="更新时间" active={sort.key === "updatedAt"} dir={sort.dir} onClick={() => toggleSort("updatedAt")} />
                  ) : null}
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    rerunnable={rerunnable.has(task.id)}
                    cancelable={cancelable.has(task.id)}
                    canceling={canceling.has(task.id)}
                    selected={selected.has(task.id)}
                    onToggle={() => toggleSelected(task.id)}
                    onCancel={() => void doCancel([task.id])}
                    hiddenColumns={hiddenColumns}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {hasMore || loadingMore ? (
          <div ref={sentinelRef} className="load-more-hint">
            {loadingMore ? "加载中…" : "向下滚动加载更多"}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function TaskRow({
  task,
  rerunnable,
  cancelable,
  canceling,
  selected,
  onToggle,
  onCancel,
  hiddenColumns,
}: {
  task: TaskSummary;
  rerunnable: boolean;
  cancelable: boolean;
  canceling: boolean;
  selected: boolean;
  onToggle: () => void;
  onCancel: () => void;
  hiddenColumns: Set<TaskColumnKey>;
}) {
  return (
    <tr className={`clickable${selected ? " row-selected" : ""}`} onClick={() => navigate(`/tasks/${task.id}`)}>
      <td onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={selected}
          disabled={!rerunnable && !cancelable}
          onChange={onToggle}
          aria-label={`选择任务 ${task.id.slice(0, 8)}`}
          title={
            rerunnable
              ? "选择以重新执行"
              : cancelable
                ? "选择以取消"
                : "仅失败/取消任务可重新执行，运行中/排队任务可取消"
          }
        />
      </td>
      {!hiddenColumns.has("type") ? <td><TypeChip type={task.taskType} /></td> : null}
      {!hiddenColumns.has("subject") ? <td className="num">#{task.subjectNumber ?? "—"}</td> : null}
      {!hiddenColumns.has("status") ? <td><StatusPill status={task.status} /></td> : null}
      {!hiddenColumns.has("policy") ? <td><span className="chip mono">{task.policyVersion}</span></td> : null}
      {!hiddenColumns.has("attempt") ? (
        <td className="num muted">
          {task.attemptCount}/{task.maxAttempts}
        </td>
      ) : null}
      {!hiddenColumns.has("error") ? (
        <td>{task.lastErrorCategory ? <span className="pill pill-err">{task.lastErrorCategory}</span> : <span className="faint">—</span>}</td>
      ) : null}
      {!hiddenColumns.has("updatedAt") ? <td className="muted">{timeAgo(task.updatedAt)}</td> : null}
      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
        {cancelable ? (
          <button
            className="btn btn-danger"
            style={{ marginRight: 8 }}
            disabled={canceling}
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
          >
            {canceling ? "取消中…" : "取消"}
          </button>
        ) : null}
        <ChevronRightIcon size={15} />
      </td>
    </tr>
  );
}

function TypeChipLabel(type: string): string {
  return { issue_analysis: "Issue", pr_review: "PR", repository_index: "索引" }[type] ?? type;
}

function SortableTh(props: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
}) {
  return (
    <th aria-sort={props.active ? (props.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        className={`th-sort ${props.active ? "th-sort-active" : ""}`}
        onClick={props.onClick}
      >
        {props.label}
        <span className="th-sort-arrow" aria-hidden="true">
          {props.active ? (props.dir === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}