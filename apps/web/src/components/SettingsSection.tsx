import { useCallback, useEffect, useState } from "react";
import {
  clearSetting,
  fetchSettings,
  saveSetting,
  type SettingItem,
} from "../lib/api";
import { ErrorPanel, LoadingRows, fmtTime } from "./ui";
import { explainUnknown } from "../lib/errors";
import { useToast } from "./Toast";
import { enumOptionLabel } from "../lib/labels";

/**
 * 生效来源徽章：数据库覆盖 / 环境变量 / 应用默认。
 * 系统配置去重后，各功能页（GitHub 接入、机器人、模型路由、分析设置）共用。
 */
export function SourceBadge({ item }: { item: SettingItem }) {
  if (item.source === "database")
    return <span className="pill pill-info">已覆盖 · 数据库</span>;
  if (item.source === "env")
    return (
      <span className="pill pill-ok" title={item.envVar ?? undefined}>
        来自环境变量{item.envVar ? ` · ${item.envVar}` : ""}
      </span>
    );
  return (
    <span className="pill pill-dim" title={`应用默认：${item.defaultValue || "空"}`}>
      应用默认{item.defaultValue ? ` · ${item.defaultValue}` : ""}
    </span>
  );
}

/** Issue 结果区块选项的中文展示名（options 本身是契约键，文案只在这里维护一份）。 */
const RESULT_SECTION_LABELS: Record<string, string> = {
  summary: "总结",
  suggested_title: "建议标题",
  probable_cause: "可能原因",
  troubleshooting: "排查步骤",
  evidence: "证据",
  missing_information: "缺失信息",
  suggested_labels: "建议标签",
  proposed_changes: "建议改动",
  suggested_actions: "建议动作",
  suggested_assignee: "建议指派人",
};

/**
 * multicheck（多选）设置项：Issue 结果区块的勾选组。
 * 勾选即本地暂存，点「保存」才写库；summary 始终勾选且不可取消（契约硬性要求）。
 */
function MultiCheckField({
  item,
  save,
  clear,
  busy,
  canRevert,
}: {
  item: SettingItem;
  save: (key: string, value: string) => void;
  clear: (key: string) => void;
  busy: boolean;
  canRevert: boolean;
}) {
  const options = item.options ?? [];
  // 当前生效值是逗号分隔串；summary 必须在其中（保证至少一个可保存）。
  const split = (value: string) => {
    const list = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return list.includes("summary") ? list : ["summary", ...list];
  };
  const [checked, setChecked] = useState<string[]>(() => split(item.value));
  useEffect(() => {
    setChecked(split(item.value));
  }, [item.value]);

  const toggle = (option: string) => {
    if (option === "summary") return;
    setChecked((prev) =>
      prev.includes(option)
        ? prev.filter((o) => o !== option)
        : [...prev, option],
    );
  };

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {options.map((option) => {
          const on = checked.includes(option);
          return (
            <button
              key={option}
              type="button"
              role="checkbox"
              aria-checked={on}
              disabled={busy || option === "summary"}
              className="chip"
              data-on={on ? "true" : "false"}
              onClick={() => toggle(option)}
              title={option === "summary" ? "总结始终输出，不可关闭" : undefined}
            >
              {RESULT_SECTION_LABELS[option] ?? option}
            </button>
          );
        })}
      </div>
      <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button
          className="btn btn-primary"
          onClick={() => save(item.key, checked.join(","))}
          disabled={busy}
        >
          {busy ? "保存中…" : `保存（已启用 ${checked.length}/${options.length}）`}
        </button>
        {canRevert ? (
          <button className="btn" style={{ fontSize: 12 }} disabled={busy} onClick={() => clear(item.key)}>
            {item.envConfigured ? "回落环境变量" : "回落默认"}
          </button>
        ) : null}
        <span className="faint" style={{ fontSize: 12 }}>
          保存后对新分析的 Issue 生效
        </span>
      </div>
    </div>
  );
}

/**
 * 单个设置项的可编辑行：按 kind 渲染开关 / 下拉 / 文本框，保存即写数据库。
 * 从原系统配置页抽取，供各功能页复用，避免每个页面各写一份字段控件。
 */
export function SettingField({
  item,
  draft,
  setDraft,
  save,
  clear,
  busyKey,
}: {
  item: SettingItem;
  draft: string;
  setDraft: (value: string) => void;
  save: (key: string, value: string) => void;
  clear: (key: string) => void;
  busyKey: string | null;
}) {
  const busy = busyKey === item.key;
  // 只有数据库覆盖才谈得上「回落」；env / 默认状态下没有可删除的东西。
  const canRevert = item.source === "database";
  const on = item.value === "true";

  return (
    <div className="result-card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{item.label}</span>
        <SourceBadge item={item} />
        {item.repoScoped ? (
          <span className="pill pill-dim" title="可在「已安装仓库」页为单个仓库覆盖">
            可按仓库覆盖
          </span>
        ) : null}
        {item.hotReload === "restart" ? (
          <span className="pill pill-warn">需重启容器</span>
        ) : null}
      </div>

      {item.kind === "boolean" ? (
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={item.label}
            className="switch"
            data-on={on ? "true" : "false"}
            disabled={busy}
            onClick={() => save(item.key, on ? "false" : "true")}
          >
            <span className="switch-knob" />
          </button>
          <span className="faint" style={{ fontSize: 12 }}>
            {busy ? "保存中…" : on ? "已开启" : "已关闭"}
          </span>
          {canRevert ? (
            <button className="btn" style={{ fontSize: 12 }} disabled={busy} onClick={() => clear(item.key)}>
              {item.envConfigured ? "回落环境变量" : "回落默认"}
            </button>
          ) : null}
        </div>
      ) : item.kind === "enum" ? (
        <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <select
            className="input"
            style={{ flex: "0 1 200px" }}
            value={item.value}
            disabled={busy}
            onChange={(event) => save(item.key, event.target.value)}
          >
            {(item.options ?? []).map((option) => (
              <option key={option} value={option}>
                {enumOptionLabel(item.key, option)}
              </option>
            ))}
          </select>
          {busy ? <span className="faint" style={{ fontSize: 12 }}>保存中…</span> : null}
          {canRevert ? (
            <button className="btn" style={{ fontSize: 12 }} disabled={busy} onClick={() => clear(item.key)}>
              {item.envConfigured ? "回落环境变量" : "回落默认"}
            </button>
          ) : null}
        </div>
      ) : item.kind === "multicheck" ? (
        <MultiCheckField
          item={item}
          save={save}
          clear={clear}
          busy={busy}
          canRevert={canRevert}
        />
      ) : item.multiline ? (
        <div className="stack" style={{ marginTop: 10 }}>
          <textarea
            className="input"
            aria-label={item.label}
            aria-describedby={`setting-${item.key}-hint`}
            rows={8}
            maxLength={item.maxLength}
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button
              className="btn btn-primary"
              onClick={() => save(item.key, draft)}
              disabled={
                busy ||
                draft === item.value ||
                (item.maxLength !== undefined && draft.length > item.maxLength)
              }
            >
              {busy ? "保存中…" : "保存"}
            </button>
            {canRevert ? (
              <button className="btn" disabled={busy} onClick={() => clear(item.key)}>
                {item.envConfigured ? "回落环境变量" : "回落默认"}
              </button>
            ) : null}
            {item.maxLength !== undefined ? (
              <span className="faint" style={{ fontSize: 12 }}>
                {draft.length}/{item.maxLength} 字符
              </span>
            ) : null}
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input
            className="input"
            style={{ flex: "1 1 260px" }}
            type={item.secret ? "password" : "text"}
            placeholder={
              item.secret
                ? item.hasValue
                  ? "已配置（不回显），输入新值可替换"
                  : "输入新值"
                : item.value
                  ? `当前：${item.value}`
                  : "输入新值"
            }
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            data-lpignore="true"
          />
          <button
            className="btn btn-primary"
            onClick={() => save(item.key, draft.trim())}
            disabled={busy || draft.trim().length === 0}
          >
            {busy ? "保存中…" : "保存"}
          </button>
          {canRevert ? (
            <button className="btn" style={{ fontSize: 12 }} disabled={busy} onClick={() => clear(item.key)}>
              {item.secret && item.rotation?.hasPrevious
                ? "回滚旧值"
                : item.envConfigured
                  ? "回落环境变量"
                  : "回落默认"}
            </button>
          ) : null}
        </div>
      )}

      {item.secret && item.rotation?.hasPrevious ? (
        <p className="faint" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--warn)" }}>
          已轮换：旧值保留至 {fmtTime(item.rotation.previousExpiresAt ?? "")}，点「回滚旧值」可恢复。
        </p>
      ) : null}
      <p id={`setting-${item.key}-hint`} className="faint" style={{ margin: "8px 0 0", fontSize: 12 }}>{item.hint}</p>
    </div>
  );
}

/**
 * 一个设置分区：按 key 白名单从注册表渲染设置项。每项自带来源徽章、保存/回落、
 * 热更新提示。各功能页用它承载属于自己的设置，实现「每项单一归属」。
 */
export function SettingsSection({
  keys,
  title,
  desc,
  countLabel,
  onSaved,
}: {
  keys: readonly string[];
  title: string;
  desc?: string;
  /** 自定义计数文案（默认「N 项」）。 */
  countLabel?: (count: number) => string;
  onSaved?: () => void;
}) {
  const toast = useToast();
  const [items, setItems] = useState<SettingItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchSettings()
      .then((s) => {
        const byKey = new Map(s.items.map((i) => [i.key, i]));
        setItems(
          keys
            .map((k) => byKey.get(k))
            .filter((x): x is SettingItem => Boolean(x)),
        );
        setDrafts({});
      })
      .catch((err: unknown) => {
        setError(explainUnknown(err));
      })
      .finally(() => setLoading(false));
  }, [keys.join(",")]);

  useEffect(() => load(), [load]);

  const refresh = async (key: string) => {
    const fresh = await fetchSettings();
    const byKey = new Map(fresh.items.map((i) => [i.key, i]));
    setItems((prev) =>
      prev.map((item) => byKey.get(item.key) ?? item),
    );
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const labelOf = (key: string) =>
    items.find((item) => item.key === key)?.label ?? key;

  const save = async (key: string, value: string) => {
    setBusyKey(key);
    try {
      await saveSetting(key, value);
      toast.success(`已保存：${labelOf(key)}`);
      await refresh(key);
      onSaved?.();
    } catch (err) {
      toast.error(`保存失败：${explainUnknown(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const clear = async (key: string) => {
    setBusyKey(key);
    try {
      const item = items.find((i) => i.key === key);
      await clearSetting(key);
      toast.success(
        `已清除覆盖：${labelOf(key)}，${item?.envConfigured ? "回落到环境变量" : "回落到应用默认"}`,
      );
      await refresh(key);
      onSaved?.();
    } catch (err) {
      toast.error(`清除失败：${explainUnknown(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <section className="panel">
      <div className="panel-title">
        <h2>{title}</h2>
        <span className="count">{countLabel ? countLabel(items.length) : `${items.length} 项`}</span>
      </div>
      {desc ? (
        <p className="faint" style={{ margin: "0 0 12px", fontSize: 12 }}>{desc}</p>
      ) : null}
      {error ? (
        <ErrorPanel error={error} onRetry={load} />
      ) : loading ? (
        <LoadingRows />
      ) : (
        <div className="stack">
          {items.map((item) => (
            <SettingField
              key={item.key}
              item={item}
              draft={drafts[item.key] ?? (item.multiline ? item.value : "")}
              setDraft={(value) =>
                setDrafts((prev) => ({ ...prev, [item.key]: value }))
              }
              save={save}
              clear={clear}
              busyKey={busyKey}
            />
          ))}
        </div>
      )}
    </section>
  );
}
