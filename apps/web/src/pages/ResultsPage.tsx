import { BugIcon as IssuePageIcon, PullRequestIcon as PrPageIcon } from "../components/icons";
import type { ConsolePage } from "../lib/navigation";

/** Issue 与 PR 共用结果查看器，路由参数在声明处固定，避免散落两个入口。 */
export const consolePages: ConsolePage[] = [
  { path: "/issues", label: "Issue 分析", group: "analysis", order: 20, icon: IssuePageIcon, render: () => <ResultsPage type="issue" label="Issue 分析" /> },
  { path: "/pr", label: "PR 审查", group: "analysis", order: 21, icon: PrPageIcon, render: () => <ResultsPage type="pr" label="PR 审查" /> },
];

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  bumpCache,
  deleteResults,
  fetchResults,
  revokeSubject,
  type ResultList,
  type SubjectResult,
} from "../lib/api";
import { ChevronDownIcon, ChevronRightIcon, RefreshIcon, SearchIcon, XCircleIcon } from "../components/icons";
import { Empty, ErrorPanel, JsonBlock, LoadingRows, fmtTime, shortText } from "../components/ui";
import { explainUnknown } from "../lib/errors";
import {
  issueCategoryLabel,
  suggestedLabelLabel,
} from "../lib/labels";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll";
import { useToast } from "../components/Toast";

type NormResult = {
  root: Record<string, unknown>;
  isIssue: boolean;
  summary: string;
  related: { issueNumber: number; repositoryFullName: string | null; score: number; reasons: string[] }[];
};

function normalizeResult(result: unknown): NormResult {
  const raw = (typeof result === "object" && result !== null ? result : {}) as Record<string, unknown>;
  const root = (raw.result && typeof raw.result === "object"
    ? (raw.result as Record<string, unknown>)
    : raw) as Record<string, unknown>;
  const isIssue =
    typeof root.severity === "string" || typeof root.priority === "string";
  const summary =
    (typeof root.summary === "string" && root.summary) ||
    (typeof root.verdict === "string" && root.verdict) ||
    "";
  const related = Array.isArray(raw.related)
    ? (raw.related as Record<string, unknown>[])
        .map((r) => ({
          issueNumber:
            typeof r.issueNumber === "number" ? r.issueNumber : Number(r.issue_number ?? 0),
          repositoryFullName:
            typeof r.repositoryFullName === "string" ? r.repositoryFullName : null,
          score: typeof r.score === "number" ? r.score : 0,
          reasons: Array.isArray(r.reasons)
            ? r.reasons.filter((x): x is string => typeof x === "string")
            : [],
        }))
        .filter((r) => r.issueNumber > 0)
    : [];
  return { root, isIssue, summary, related };
}

type Conf = { severity?: number; rootCause?: number; suggestion?: number };

function resultKey(item: SubjectResult): string {
  return `${item.subjectType}:${item.subjectNumber}:${item.revision}`;
}

export function ResultsPage(props: { type: "issue" | "pr"; label: string }) {
  const [list, setList] = useState<ResultList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRevoking, setBulkRevoking] = useState(false);
  const toast = useToast();

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchResults(props.type)
      .then(setList)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "failed to load results");
        setList(null);
      })
      .finally(() => setLoading(false));
  }, [props.type]);

  useEffect(() => refresh(), [refresh]);

  const loadMore = useCallback(() => {
    if (!list || list.nextOffset === undefined || loadingMore) return;
    setLoadingMore(true);
    fetchResults(props.type, list.nextOffset)
      .then((more) => {
        const seen = new Set(list.items.map((r) => `${r.subjectType}:${r.subjectNumber}:${r.revision}`));
        const fresh = more.items.filter((r) => !seen.has(`${r.subjectType}:${r.subjectNumber}:${r.revision}`));
        // Append, never replace: an empty page must not wipe the loaded list.
        setList({ items: [...list.items, ...fresh], nextOffset: more.nextOffset });
      })
      // 翻页失败要让用户知道，否则滚到底没反应会以为没有更多数据。
      .catch((err: unknown) =>
        toast.error(`加载更多结果失败：${explainUnknown(err)}`),
      )
      .finally(() => setLoadingMore(false));
  }, [list, loadingMore, props.type, toast]);

  const filtered = useMemo(() => {
    if (!list) return [];
    const q = search.trim().toLowerCase();
    if (!q) return list.items;
    return list.items.filter((item) => {
      const n = normalizeResult(item.result);
      return (
        String(item.subjectNumber).includes(q) ||
        item.repositoryFullName.toLowerCase().includes(q) ||
        n.summary.toLowerCase().includes(q)
      );
    });
  }, [list, search]);

  const hasMore = list?.nextOffset !== undefined;
  const sentinelRef = useInfiniteScroll({
    hasMore,
    loading: loadingMore,
    onLoadMore: loadMore,
  });

  const toggleSelected = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAllVisible = () => {
    if (filtered.length === 0) return;
    const keys = filtered.map(resultKey);
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = keys.every((k) => next.has(k));
      for (const k of keys) {
        if (allSelected) next.delete(k);
        else next.add(k);
      }
      return next;
    });
  };

  const clearSelected = () => setSelected(new Set());

  const bulkRevoke = async () => {
    const targets = filtered.filter((item) => selected.has(resultKey(item)));
    if (targets.length === 0) return;
    if (
      !window.confirm(
        `确定要批量撤回选中的 ${targets.length} 个结果吗？将删除对应评论、撤销 Review 并移除建议标签，且不可恢复。`,
      )
    )
      return;
    setBulkRevoking(true);
    let ok = 0;
    const failures: string[] = [];
    for (const item of targets) {
      try {
        await revokeSubject({
          repositoryFullName: item.repositoryFullName,
          number: item.subjectNumber,
          type: item.subjectType,
        });
        ok += 1;
      } catch (err) {
        // 保留失败原因：原先整个 catch 丢弃异常，用户只看到一个计数。
        failures.push(`#${item.subjectNumber} ${explainUnknown(err)}`);
      }
    }
    if (failures.length === 0) {
      toast.success(`批量撤回完成：成功 ${ok} 个`);
    } else {
      // 全部失败时用成功样式会让用户以为已经撤回。
      const detail = failures.slice(0, 3).join("；");
      const more = failures.length > 3 ? ` 等 ${failures.length} 项` : "";
      toast.error(
        `批量撤回：成功 ${ok} 个，失败 ${failures.length} 个 — ${detail}${more}`,
      );
    }
    setSelected(new Set());
    bumpCache();
    refresh();
    setBulkRevoking(false);
  };

  const exportResults = () => {
    if (filtered.length === 0) return;
    const blob = new Blob([JSON.stringify(filtered, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    anchor.href = url;
    anchor.download = `apertureprism-${props.type}-${stamp}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toast.success(`已导出 ${filtered.length} 条${props.type === "pr" ? " PR 审查" : " Issue 分析"}结果`);
  };

  const bulkDelete = async () => {
    const targets = filtered.filter((item) => selected.has(resultKey(item)));
    if (targets.length === 0) return;
    if (
      !window.confirm(
        `确定要删除选中的 ${targets.length} 个结果记录吗？将同时移除对应任务的评论/Review/Check Run 发布书签；GitHub 上已发布的评论/Review 不会自动删除，可先用「撤回」。此操作不可恢复。`,
      )
    )
      return;
    setBulkRevoking(true);
    try {
      const result = await deleteResults(
        targets.map((item) => ({
          subjectType: item.subjectType,
          subjectNumber: item.subjectNumber,
          repositoryFullName: item.repositoryFullName,
          revision: item.revision,
        })),
      );
      toast.success(
        `已删除 ${result.deleted} 条结果记录${result.notFound > 0 ? `，未匹配 ${result.notFound} 条` : ""}`,
      );
      setSelected(new Set());
      bumpCache();
      refresh();
    } catch (err) {
      toast.error(`删除失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setBulkRevoking(false);
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">{props.label}</h1>
          <p className="page-desc">已持久化的结构化分析结果</p>
        </div>
        <div className="actions">
          <button
            className="btn"
            onClick={exportResults}
            disabled={loading || filtered.length === 0}
          >
            导出
          </button>
          <button className="btn" onClick={() => { bumpCache(); refresh(); }} disabled={loading}>
            <RefreshIcon size={16} />
            刷新
          </button>
        </div>
      </div>

      <section className="panel">
        <div className="panel-title">
          <h2>结果</h2>
          <span className="count">{list?.items.length ?? "–"} 条</span>
          {selected.size > 0 ? (
            <span className="count" style={{ marginLeft: 8 }}>
              已选 {selected.size} 项
            </span>
          ) : null}
        </div>
        <div className="filters" style={{ marginBottom: 14, gap: 10 }}>
          <label className="searchbox">
            <SearchIcon size={15} />
            <input
              className="input"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索 #编号 / 仓库/摘要…"
              aria-label="搜索结果"
            />
          </label>
          {filtered.length > 0 ? (
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <input type="checkbox" checked={filtered.every((i) => selected.has(resultKey(i))) && selected.size > 0} onChange={toggleAllVisible} />
              全选本页（{filtered.length}）
            </label>
          ) : null}
          {selected.size > 0 ? (
            <>
              <button className="btn btn-primary" onClick={() => void bulkRevoke()} disabled={bulkRevoking}>
                {bulkRevoking ? "撤回中…" : `批量撤回（${selected.size}）`}
              </button>
              <button className="btn" onClick={() => void bulkDelete()} disabled={bulkRevoking}>
                批量删除
              </button>
              <button className="btn" onClick={clearSelected} disabled={bulkRevoking}>
                取消选择
              </button>
            </>
          ) : null}
        </div>

        {error ? (
          <ErrorPanel error={error} onRetry={refresh} />
        ) : loading || !list ? (
          loading ? <LoadingRows /> : <Empty title="暂无数据" />
        ) : filtered.length === 0 ? (
          <Empty title={search ? "无匹配结果" : "暂无结果"} hint={search ? "换个关键词试试" : "Worker 完成一次分析并发布后，结构化结果将显示在这里"} />
        ) : (
          <div className="stack">
            {filtered.map((item) => (
              <ResultCard
                key={item.createdAt + item.subjectNumber}
                item={item}
                selected={selected.has(resultKey(item))}
                onToggleSelect={() => toggleSelected(resultKey(item))}
              />
            ))}
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

function ResultCard({
  item,
  selected,
  onToggleSelect,
}: {
  item: SubjectResult;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const norm = normalizeResult(item.result);
  const [open, setOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const toast = useToast();

  const revoke = async () => {
    const what = item.subjectType === "pr" ? "该 PR 的 AI 审查" : "该 Issue 的分析结果";
    if (!window.confirm(`确定要撤回${what}吗？将删除评论、撤销 Review 并移除建议标签，且不可恢复。`)) return;
    setRevoking(true);
    try {
      const result = await revokeSubject({
        repositoryFullName: item.repositoryFullName,
        number: item.subjectNumber,
        type: item.subjectType,
      });
      const parts: string[] = [];
      if (result.revoked.comments > 0) parts.push(`评论 ${result.revoked.comments} 条`);
      if (result.revoked.reviews > 0) parts.push(`Review ${result.revoked.reviews} 个`);
      if (result.revoked.labels > 0) parts.push(`标签 ${result.revoked.labels} 个`);
      toast.success(parts.length > 0 ? `已撤回：${parts.join("、")}` : "未找到需要撤回的内容（可能已被清理）");
      bumpCache();
    } catch (err) {
      toast.error(`撤回失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setRevoking(false);
    }
  };

  return (
    <article className={`result-card${selected ? " result-card-selected" : ""}`}>
      <div className="result-top">
        <label style={{ display: "flex", alignItems: "center" }} title="选择以批量撤回">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            aria-label={`选择 #${item.subjectNumber}`}
          />
        </label>
        <span className="result-title">
          #{item.subjectNumber} <span className="result-repo">{item.repositoryFullName}</span>
        </span>
        <span className="chip mono">{shortText(item.revision, 10)}</span>
        <span className="faint">{fmtTime(item.createdAt)}</span>
        <span className="pill pill-ok">已发布</span>
        <a
          className="btn btn-ghost"
          style={{ marginLeft: "auto", padding: "4px 10px" }}
          href={githubUrl(item)}
          target="_blank"
          rel="noreferrer"
        >
          GitHub ↗
        </a>
        <button
          className="btn btn-ghost"
          style={{ padding: "4px 10px" }}
          onClick={revoke}
          disabled={revoking}
          aria-label="一键撤回已发布的 AI 审查"
        >
          <XCircleIcon size={14} />
          {revoking ? "撤回中…" : "撤回"}
        </button>
      </div>

      {norm.isIssue ? <IssueBody norm={norm} /> : <PrBody norm={norm} />}

      <button className="detail-btn" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
        {open ? "收起原始数据" : "查看原始数据"}
      </button>
      {open ? <JsonBlock data={item.result} /> : null}
    </article>
  );
}

function IssueBody({ norm }: { norm: NormResult }) {
  const r = norm.root;
  const conf = Object.keys(r).includes("confidence")
    ? (r.confidence as Conf)
    : undefined;
  const labels = stringArr(r.suggestedLabels);
  const missing = stringArr(r.missingInformation);
  const actions = stringArr(r.suggestedActions);
  const evidence = arrOf(r.evidence);
  const suggestedTitle = str(r.suggestedTitle);
  const probableCause = str(r.probableCause);
  const suggestedAssignee = str(r.suggestedAssignee)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const troubleshooting = stringArr(r.troubleshooting);
  const proposedChanges = arrOf(r.proposedChanges).map((p) => ({
    path: str(p.path),
    locator: str(p.locator),
    change: str(p.change),
  }));

  return (
    <>
      <p className="result-summary">{norm.summary || "无摘要"}</p>

      <div className="result-meta">
        <SeverityBadge value={str(r.severity)} />
        <PriorityBadge value={str(r.priority)} />
        <QualityBadge value={str(r.quality)} />
        {typeof r.category === "string" ? <CategoryPill value={r.category} /> : null}
      </div>

      {suggestedTitle ? (
        <div className="section">
          <h4>建议标题</h4>
          <p className="action-item">{suggestedTitle}</p>
        </div>
      ) : null}

      {probableCause ? (
        <div className="section">
          <h4>根因分析</h4>
          <p className="action-item">{probableCause}</p>
        </div>
      ) : null}

      {conf ? (
        <div className="section">
          <h4>置信度</h4>
          <div className="conf">
            <ConfItem label="Severity" value={conf.severity} />
            <ConfItem label="Root Cause" value={conf.rootCause} />
            <ConfItem label="Suggestion" value={conf.suggestion} />
          </div>
        </div>
      ) : null}

      {evidence.length > 0 ? (
        <div className="section">
          <h4>依据（Evidence）</h4>
          <ul>
            {evidence.map((e, i) => (
              <li key={i} className="action-item mono">
                {str(e?.kind ?? "")} — {str(e?.excerpt ?? "")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {troubleshooting.length > 0 ? (
        <div className="section">
          <h4>排查步骤</h4>
          <ol className="missing-list" style={{ paddingLeft: 20 }}>
            {troubleshooting.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ol>
        </div>
      ) : null}

      {missing.length > 0 ? (
        <div className="section">
          <h4>缺失信息</h4>
          <ul className="missing-list">
            {missing.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {suggestedAssignee.length > 0 ? (
        <div className="section">
          <h4>建议指派人</h4>
          <p className="action-item">
            {suggestedAssignee.map((login) => `@${login}`).join(" ")}
          </p>
        </div>
      ) : null}

      {labels.length > 0 ? (
        <div className="section">
          <h4>建议标签</h4>
          <div className="tag-row">
            {labels.map((l, i) => (
              <span key={i} className="tag">{suggestedLabelLabel(l)}</span>
            ))}
          </div>
        </div>
      ) : null}

      {proposedChanges.length > 0 ? (
        <div className="section">
          <h4>建议改动</h4>
          <ul>
            {proposedChanges.map((p, i) => (
              <li key={i} className="action-item">
                <code className="mono">
                  {p.path}
                  {p.locator ? `:${p.locator}` : ""}
                </code>
                <span> — {p.change}</span>
              </li>
            ))}
          </ul>
          {proposedChanges.every((p) => !p.locator) ? (
            <p className="faint" style={{ fontSize: 12, marginTop: 6 }}>
              提示：开启「分析设置 → Issue 深度分析（读取源码）」后，建议改动会精确到文件行号。
            </p>
          ) : null}
        </div>
      ) : null}

      {actions.length > 0 ? (
        <div className="section">
          <h4>建议动作</h4>
          <ul>
            {actions.map((a, i) => (
              <li key={i} className="action-item">{a}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {norm.related.length > 0 ? (
        <div className="section">
          <h4>语义关联 Issue</h4>
          <ul className="missing-list">
            {norm.related.slice(0, 5).map((rel, i) => (
              <li key={i}>
                <a
                  href={`https://github.com/${rel.repositoryFullName ?? "unknown/repo"}/issues/${rel.issueNumber}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  #{rel.issueNumber}
                </a>
                <span className="faint">
                  {" "}· {rel.repositoryFullName ?? "unknown/repo"}（{Math.round(rel.score * 100)}%
                  {rel.reasons.includes("signal") ? " 信号" : " 文本"}相似）
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

export type PrFinding = {
  rule: string;
  severity: string;
  file: string;
  message: string;
  evidence: string;
  suggestion: string;
  afterLine: number;
};

export type PrParsed = {
  summary: string;
  overallTone: string | null;
  stats: { files: number; additions: number; deletions: number } | null;
  findings: PrFinding[];
};

/** 规范化 PR 审查结果（pr-review/v1 契约），供展示与单元测试复用。 */
export function parsePrResult(root: Record<string, unknown>): PrParsed | null {
  if (typeof root.summary !== "string" && !Array.isArray(root.findings)) return null;
  const findings = Array.isArray(root.findings)
    ? (root.findings as Record<string, unknown>[]).map((f) => ({
        rule: typeof f.rule === "string" ? f.rule : "rule",
        severity: typeof f.severity === "string" ? f.severity : "info",
        file: typeof f.file === "string" ? f.file : "",
        message: typeof f.message === "string" ? f.message : "",
        evidence: typeof f.evidence === "string" ? f.evidence : "",
        suggestion: typeof f.suggestion === "string" ? f.suggestion : "",
        afterLine: typeof f.afterLine === "number" ? f.afterLine : 0,
      }))
    : [];
  const hasStats =
    typeof root.changedFileCount === "number" ||
    typeof root.additions === "number" ||
    typeof root.deletions === "number";
  return {
    summary: typeof root.summary === "string" ? root.summary : "",
    overallTone: typeof root.overallTone === "string" ? root.overallTone : null,
    stats: hasStats
      ? {
          files: typeof root.changedFileCount === "number" ? root.changedFileCount : 0,
          additions: typeof root.additions === "number" ? root.additions : 0,
          deletions: typeof root.deletions === "number" ? root.deletions : 0,
        }
      : null,
    findings,
  };
}

function PrBody({ norm }: { norm: NormResult }) {
  const pr = parsePrResult(norm.root);
  if (!pr) return <p className="result-summary">{norm.summary || "查看原始数据以展开分析内容"}</p>;

  return (
    <>
      <div className="result-meta">
        {pr.overallTone ? <ToneBadge tone={pr.overallTone} /> : null}
        {pr.stats ? (
          <span className="chip mono">
            {pr.stats.files} 文件 · +{pr.stats.additions}/-{pr.stats.deletions}
          </span>
        ) : null}
        <span className="pill pill-dim">{pr.findings.length} 条发现</span>
      </div>

      {pr.summary ? <p className="result-summary">{pr.summary}</p> : null}

      {pr.findings.length > 0 ? (
        <div className="section">
          <h4>审查发现（Findings）</h4>
          <ul className="finding-list">
            {pr.findings.map((f, i) => (
              <li key={i} className="finding">
                <div className="finding-head">
                  <span className={`pill ${prSeverityCls(f.severity)}`}>{f.severity}</span>
                  <span className="finding-rule mono">{f.rule}</span>
                  <span className="finding-file mono">
                    {f.file}
                    {f.afterLine ? `:${f.afterLine}` : ""}
                  </span>
                </div>
                {f.message ? <p className="finding-msg">{f.message}</p> : null}
                {f.evidence ? <pre className="finding-evidence">{f.evidence}</pre> : null}
                {f.suggestion ? <p className="finding-suggestion">建议：{f.suggestion}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

const TONE_LABELS: Record<string, string> = {
  approve: "通过",
  changes_requested: "需修改",
  comment: "评论",
};

function ToneBadge({ tone }: { tone: string }) {
  const cls =
    tone === "approve" ? "pill-ok" : tone === "changes_requested" ? "pill-err" : "pill-dim";
  return <span className={`pill ${cls}`}>{TONE_LABELS[tone] ?? tone}</span>;
}

function prSeverityCls(value: string): string {
  switch (value.toLowerCase()) {
    case "critical":
      return "s0";
    case "high":
      return "s1";
    case "medium":
      return "s2";
    case "low":
      return "s3";
    default:
      return "sunknown";
  }
}

function ConfItem({ label, value }: { label: string; value?: number }) {
  const pct = value === undefined ? 0 : Math.round(value * 100);
  return (
    <div className="conf-item">
      <span className="lab">{label}</span>
      <span className="conf-bar"><span className="conf-fill" style={{ width: `${pct}%` }} /></span>
      <span className="pct">{value === undefined ? "—" : `${pct}%`}</span>
    </div>
  );
}

function SeverityBadge({ value }: { value: string }) {
  if (!value) return null;
  return <span className={`pill ${severityCls(value)}`}>严重度 {value}</span>;
}
function PriorityBadge({ value }: { value: string }) {
  if (!value) return null;
  return <span className={`pill ${priorityCls(value)}`}>优先级 {value}</span>;
}
function QualityBadge({ value }: { value: string }) {
  if (!value) return null;
  return <span className={`pill ${qualityCls(value)}`}>质量 {value}</span>;
}
function CategoryPill({ value }: { value: string }) {
  return <span className="pill pill-dim">类型 {issueCategoryLabel(value)}</span>;
}

/* ---- class mapping (matches index.css tint classes) ---- */
function severityCls(v: string): string {
  const k = v.toLowerCase();
  return k === "unknown" ? "sunknown" : `s${k.replace(/[^0-9]/g, "")}`;
}
function priorityCls(v: string): string {
  const k = v.toLowerCase();
  return k === "needs_triage" ? "pneeds_triage" : `p${k.replace(/[^0-9]/g, "")}`;
}
function qualityCls(v: string): string {
  return `q${v.toLowerCase().replace(/[^a-z]/g, "")}`;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Builds the GitHub issue/PR html_url for a persisted subject result. */
function githubUrl(item: SubjectResult): string {
  const base = `https://github.com/${item.repositoryFullName}`;
  const kind = item.subjectType === "pr" ? "pull" : "issues";
  return `${base}/${kind}/${item.subjectNumber}`;
}
function stringArr(value: unknown): string[] {
  return Array.isArray(value) ? (value as unknown[]).filter((v): v is string => typeof v === "string") : [];
}
function arrOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}