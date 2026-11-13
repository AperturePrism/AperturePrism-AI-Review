import { TagIcon as PageIcon } from "../components/icons";
import type { ConsolePage } from "../lib/navigation";

/** 本页的位置与入口同处维护；导航由页面目录自动读取。 */
export const consolePages: ConsolePage[] = [{ path: "/labels", label: "标签配置", group: "data", order: 47, icon: PageIcon, render: () => <LabelsPage /> }];

import { useCallback, useEffect, useState } from "react";
import {
  deleteLabelRule,
  fetchLabelRules,
  saveLabelRule,
  type LabelRuleItem,
} from "../lib/api";
import { useToast } from "../components/Toast";
import { GearIcon, XCircleIcon } from "../components/icons";
import { ErrorPanel, LoadingRows } from "../components/ui";
import { explainUnknown } from "../lib/errors";

const RULE_PREFIXES = ["category", "severity", "priority", "quality"] as const;

const VALUE_SUGGESTIONS: Record<string, string[]> = {
  category: [
    "bug",
    "security",
    "performance",
    "dependency",
    "documentation",
    "testing",
    "refactor",
    "enhancement",
    "feature",
    "question",
    "other",
  ],
  severity: ["S0", "S1", "S2", "S3", "unknown"],
  priority: ["P0", "P1", "P2", "P3", "needs_triage"],
  quality: ["complete", "actionable", "incomplete", "invalid"],
};

/** 标签配置：分析结果字段 → GitHub 标签。表单免前缀，选字段 + 填取值即可。 */
export function LabelsPage() {
  const toast = useToast();
  const [items, setItems] = useState<LabelRuleItem[]>([]);
  const [prefixes, setPrefixes] = useState<string[]>([]);
  const [draft, setDraft] = useState({
    prefix: "category" as string,
    value: "",
    label: "",
    enabled: true,
  });
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchLabelRules()
      .then((result) => {
        setItems(result.items);
        setPrefixes(result.prefixes);
      })
      // 不能静默失败：否则加载出错时页面显示「尚未配置标签规则」，
      // 用户无法区分真的没配还是加载失败，也没有重试入口。
      .catch((err: unknown) => setError(explainUnknown(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  const save = async () => {
    const value = draft.value.trim();
    if (!value) {
      toast.error("请填写分析取值，如 bug / S1 / P0");
      return;
    }
    const key = `${draft.prefix}:${value}`;
    const label = draft.label.trim();
    setBusy(true);
    try {
      await saveLabelRule({ key, label, enabled: draft.enabled });
      toast.success(
        label
          ? `已保存规则：${key} → ${label}（${draft.enabled ? "启用" : "停用"}）`
          : `已删除规则：${key}`,
      );
      setDraft({ prefix: "category", value: "", label: "", enabled: true });
      load();
    } catch (err) {
      toast.error(`保存失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (key: string) => {
    if (!window.confirm(`确定要删除标签规则「${key}」吗？`)) return;
    setBusy(true);
    try {
      await deleteLabelRule(key);
      toast.success(`已删除规则：${key}`);
      load();
    } catch (err) {
      toast.error(`删除失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  };

  const suggestions = VALUE_SUGGESTIONS[draft.prefix] ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <h1>标签配置</h1>
        <p className="sub">
          分析结果字段 → GitHub 标签；Issue 分析完成后命中规则由 worker 自动打标（幂等，失败不影响分析任务）。
        </p>
      </div>

      <div className="stack">
        <section className="panel">
          <div className="panel-title">
            <h2>
              <GearIcon size={14} /> 标签规则
            </h2>
            <span className="count">
              {items.length} 条{prefixes.length > 0 ? ` · 前缀 ${prefixes.join(" / ")}` : ""}
            </span>
          </div>

          <p className="faint" style={{ margin: "0 0 12px", fontSize: 12, lineHeight: 1.6 }}>
            每条规则把一个<strong>分析结果取值</strong>映射为 <strong>GitHub 标签</strong>，例如
            <code className="mono"> 分类 </code>取值为 <span className="chip">bug</span> → 标签{" "}
            <span className="chip">bug</span>、
            <code className="mono"> 严重度 </code>取值为 <span className="chip">S1</span> → 标签{" "}
            <span className="chip">critical</span>。
            左侧箭头后才是实际打到 GitHub Issue 上的标签名，可改成任意 GitHub 标签
            （如 <code className="mono">enhancement</code>）。新增时无需手写前缀，选字段、填取值即可。
          </p>

          <div className="stack" style={{ gap: 8 }}>
            {loading ? (
              <LoadingRows />
            ) : error ? (
              <ErrorPanel error={error} onRetry={load} />
            ) : items.length === 0 ? (
              <p className="faint" style={{ margin: 0, fontSize: 12 }}>
                尚未配置标签规则。Issue 分析完成后，命中规则会由 worker 自动给 GitHub Issue 打标签。
              </p>
            ) : (
              items.map((item) => (
                <div
                  key={item.key}
                  className="result-card"
                  style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
                >
                  <code className="mono" style={{ fontSize: 12 }}>
                    {item.key}
                  </code>
                  <span className="chip">→ {item.label}</span>
                  <span className={`pill ${item.enabled ? "pill-ok" : "pill-dim"}`}>
                    {item.enabled ? "启用" : "停用"}
                  </span>
                  <button
                    className="btn"
                    style={{ marginLeft: "auto" }}
                    onClick={() => remove(item.key)}
                    disabled={busy}
                    aria-label={`删除 ${item.key}`}
                  >
                    <XCircleIcon size={14} />
                  </button>
                </div>
              ))
            )}
          </div>

          <div
            style={{ marginTop: 14, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
          >
            <select
              className="input"
              style={{ flex: "0 0 118px" }}
              value={draft.prefix}
              onChange={(event) => setDraft((prev) => ({ ...prev, prefix: event.target.value }))}
              title="分析结果字段"
            >
              {RULE_PREFIXES.map((prefix) => (
                <option key={prefix} value={prefix}>
                  {prefix === "category"
                    ? "分类"
                    : prefix === "severity"
                      ? "严重度"
                      : prefix === "priority"
                        ? "优先级"
                        : "完整度"}
                  {" "}({prefix})
                </option>
              ))}
            </select>
            <input
              className="input"
              style={{ flex: "1 1 150px" }}
              list="label-rule-values"
              placeholder="取值，如 bug / S1 / P0"
              value={draft.value}
              onChange={(event) => setDraft((prev) => ({ ...prev, value: event.target.value }))}
            />
            <datalist id="label-rule-values">
              {suggestions.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
            <span className="faint">→</span>
            <input
              className="input"
              style={{ flex: "1 1 150px" }}
              placeholder="GitHub 标签名（留空=删除该规则）"
              value={draft.label}
              onChange={(event) => setDraft((prev) => ({ ...prev, label: event.target.value }))}
            />
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => setDraft((prev) => ({ ...prev, enabled: event.target.checked }))}
              />
              启用
            </label>
            <button className="btn btn-primary" onClick={save} disabled={busy}>
              {busy ? "保存中…" : "保存规则"}
            </button>
          </div>
          <p className="faint" style={{ marginTop: 12, fontSize: 12 }}>
            例如：选「分类」、填 <code>bug</code>、标签名填 <code>bug</code>，即保存为{" "}
            <code>category:bug → bug</code>。首次进入会自动填充一组默认常用标签，可直接修改或删除。
          </p>
        </section>
      </div>
    </div>
  );
}
