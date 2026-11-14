/** 仓库显式开启自动合并；配置和真实执行结果同处查看。 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  fetchRepositorySettings,
  type Repository,
  type RepositorySettingItem,
} from "../lib/api/repository";
import { bumpCache } from "../lib/api/http";
import {
  fetchAutoMergeHistory,
  saveAutoMergeSettings,
  type AutoMergeHistory,
  type AutoMergeItem,
  type AutoMergeMethod,
  type AutoMergeSettings,
  type AutoMergeStatus,
} from "../lib/api/auto-merge";
import { explainUnknown } from "../lib/errors";
import { Empty, ErrorPanel, fmtTime, LoadingRows } from "./ui";
import {
  AUTO_MERGE_SETTING_KEYS as SETTING_KEYS,
  MAX_AUTO_MERGE_CHECKS,
  MAX_AUTO_MERGE_CHECK_NAME,
  MAX_AUTO_MERGE_CHECKS_TEXT,
  parseAutoMergeSettings,
  parseRequiredAutoMergeChecks,
} from "../../../../packages/config/src/auto-merge";

export const AUTO_MERGE_SETTING_KEYS = new Set<string>(SETTING_KEYS);

const METHOD_LABELS: Record<AutoMergeMethod, string> = {
  squash: "压缩合并（Squash）",
  merge: "创建合并提交（Merge）",
  rebase: "变基合并（Rebase）",
};
const STATUS_LABELS: Record<AutoMergeStatus, string> = {
  pending: "等待调度",
  waiting: "等待检查",
  blocked: "暂不能合并",
  merged: "已合并",
  canceled: "已取消",
};
const STATUS_CLASS: Record<AutoMergeStatus, string> = {
  pending: "pill-info",
  waiting: "pill-warn",
  blocked: "pill-err",
  merged: "pill-ok",
  canceled: "pill-dim",
};
const REASONS: Record<string, string> = {
  awaiting_checks: "等待 GitHub 检查",
  checks_pending: "GitHub 检查尚未完成",
  checks_failed: "GitHub 检查未通过",
  required_check_missing: "必须的检查尚未出现",
  no_checks: "尚无 GitHub 检查结果",
  review_failed: "审查未通过",
  workbench_gate_failed: "工作台质量门禁未通过",
  changes_requested: "有尚未解决的修改请求",
  draft: "PR 仍为草稿",
  merge_conflict: "存在合并冲突",
  retry_exhausted: "自动重试次数已用尽，请人工检查",
  branch_protection: "等待分支保护条件满足",
  waiting_task: "等待审查任务完成",
  review_superseded: "已有更新的审查任务",
  invalid_identity: "PR 身份无效",
  invalid_review: "审查结果无效",
  review_not_approved: "审查尚未批准",
  review_incomplete: "审查覆盖尚未完成",
  workbench_pending: "等待审查结果同步到工作台",
  workbench_blocked: "工作台质量门禁未通过",
  required_checks_missing: "必须的检查尚未出现",
  mergeability_pending: "等待 GitHub 计算合并状态",
  branch_blocked: "分支保护条件尚未满足",
  pr_closed: "PR 已关闭",
  github_error: "GitHub 请求失败，稍后重试",
  github_merge_refused: "GitHub 尚未允许合并",
  stale_head: "PR 已有新提交，需要重新审查",
  disabled: "本仓库已关闭自动合并",
  merged: "合并成功",
};

function settingsFromItems(items: RepositorySettingItem[]): AutoMergeSettings {
  const overrides = new Map(
    items
      .filter((item) => item.overridden)
      .map((item) => [item.key, item.value]),
  );
  // 使用与执行端相同的纯解析器；损坏的配置也显示为关闭。
  const parsed = parseAutoMergeSettings(overrides);
  return { ...parsed, requiredChecks: [...parsed.requiredChecks] };
}

function splitChecks(value: string): string[] {
  const names = value
    .split(/[\r\n]/)
    .map((name) => name.trim())
    .filter(Boolean);
  // 表单按行分隔，JSON 数组保留单个检查名中的逗号。
  return parseRequiredAutoMergeChecks(JSON.stringify(names));
}

export function AutoMergePanel({
  repo,
  onClose,
}: {
  repo: Repository;
  onClose: () => void;
}) {
  const fieldId = useId();
  const panel = useRef<HTMLElement>(null);
  const [settings, setSettings] = useState<AutoMergeSettings | null>(null);
  const [checksDraft, setChecksDraft] = useState("");
  const [history, setHistory] = useState<AutoMergeHistory | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    panel.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [repo.id]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setSettings(null);
    setHistory(null);
    setSettingsError(null);
    setHistoryError(null);
    setNotice(null);
    setSaveError(null);
    const requests = [
      fetchRepositorySettings(repo.id)
        .then((value) => {
          if (!active) return;
          const next = settingsFromItems(value.items);
          setSettings(next);
          setChecksDraft(next.requiredChecks.join("\n"));
        })
        .catch((error: unknown) => {
          if (active) setSettingsError(explainUnknown(error));
        }),
      fetchAutoMergeHistory(repo.id)
        .then((value) => {
          if (active) setHistory(value);
        })
        .catch((error: unknown) => {
          if (active) setHistoryError(explainUnknown(error));
        }),
    ];
    void Promise.all(requests).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [repo.id]);

  const refreshHistory = useCallback(async () => {
    setRefreshing(true);
    setHistoryError(null);
    bumpCache();
    try {
      setHistory(await fetchAutoMergeHistory(repo.id));
    } catch (error) {
      setHistoryError(explainUnknown(error));
    } finally {
      setRefreshing(false);
    }
  }, [repo.id]);

  const canManage = history?.canManage === true && historyError === null;
  const save = async () => {
    if (!settings || !canManage) return;
    setSaveError(null);
    setNotice(null);
    let checks: string[];
    try {
      checks = splitChecks(checksDraft);
    } catch (error) {
      setSaveError(explainUnknown(error));
      return;
    }
    setSaving(true);
    try {
      await saveAutoMergeSettings(repo.id, {
        ...settings,
        requiredChecks: checks,
      });
      setSettings({ ...settings, requiredChecks: checks });
      setChecksDraft(checks.join("\n"));
      setNotice(
        settings.enabled
          ? "已开启本仓库自动合并；后续审查通过后会等待检查结果。"
          : "已关闭本仓库自动合并。",
      );
      await refreshHistory();
    } catch (error) {
      setSaveError(explainUnknown(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section ref={panel} className="panel" aria-label={`${repo.fullName} 自动合并`}>
      <div className="panel-title">
        <h2>检查通过自动合并</h2>
        <div className="actions">
          <span className="count">{repo.fullName}</span>
          <button
            className="btn"
            type="button"
            disabled={saving}
            onClick={onClose}
          >
            收起
          </button>
        </div>
      </div>
      <p className="faint" style={{ fontSize: 12, lineHeight: 1.7 }}>
        对本仓库明确开启后，平台审查与质量门禁通过、所有 GitHub
        检查通过时，自动合并已审查的提交。
        检查失败、草稿或分支保护条件未满足时等待；出现新提交后必须重新审查。GitHub
        要求的人工审批仍然有效。
      </p>
      {loading ? <LoadingRows /> : null}
      {settingsError ? (
        <ErrorPanel error={`无法读取自动合并配置：${settingsError}`} />
      ) : null}
      {!loading && settings ? (
        <form
          className="stack"
          style={{ gap: 14 }}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset
            disabled={!canManage || saving}
            style={{
              border: 0,
              margin: 0,
              padding: 0,
              display: "grid",
              gap: 14,
            }}
          >
            <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(event) => {
                  const next = event.target.checked;
                  // 自动合并会直接写入远端分支，开启和关闭都要求二次确认。
                  const confirmed = window.confirm(
                    next
                      ? `将自动合并所有通过门禁的 PR。确定要为 ${repo.fullName} 开启检查通过自动合并吗？`
                      : `关闭后，${repo.fullName} 的 PR 不再自动合并。确定要关闭吗？`,
                  );
                  if (!confirmed) return;
                  setSettings({ ...settings, enabled: next });
                  setNotice(null);
                }}
              />
              在本仓库开启检查通过自动合并
            </label>
            <div className="field">
              <label htmlFor={`${fieldId}-method`}>合并方式</label>
              <select
                className="input"
                id={`${fieldId}-method`}
                value={settings.method}
                onChange={(event) => {
                  setSettings({
                    ...settings,
                    method: event.target.value as AutoMergeMethod,
                  });
                  setNotice(null);
                }}
              >
                {Object.entries(METHOD_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`${fieldId}-checks`}>必须通过的检查名称</label>
              <textarea
                className="input"
                rows={3}
                id={`${fieldId}-checks`}
                value={checksDraft}
                placeholder={"例如：build\ntest"}
                maxLength={MAX_AUTO_MERGE_CHECKS_TEXT}
                onChange={(event) => {
                  setChecksDraft(event.target.value);
                  setNotice(null);
                }}
                aria-describedby={`${fieldId}-checks-help`}
              />
              <p
                className="faint"
                id={`${fieldId}-checks-help`}
                style={{ fontSize: 12, margin: 0 }}
              >
                每行一个名称，需与 GitHub 检查名称完全一致（包括逗号）。最多{" "}
                {MAX_AUTO_MERGE_CHECKS} 项，每项 {MAX_AUTO_MERGE_CHECK_NAME}{" "}
                字符；留空仍要求全部已出现的检查通过，缺少结果不会视为成功。
              </p>
            </div>
            {canManage ? (
              <button
                className="btn btn-primary"
                type="submit"
                disabled={saving}
              >
                {saving ? "保存中…" : "保存自动合并配置"}
              </button>
            ) : null}
          </fieldset>
          {!canManage ? (
            <p className="faint">
              当前账号不能修改本仓库自动合并配置；需要仓库管理权限。
            </p>
          ) : null}
          {saveError ? (
            <p role="alert" className="wb-notice wb-notice-error">
              保存失败：{saveError}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="wb-notice">
              {notice}
            </p>
          ) : null}
        </form>
      ) : null}
      <div className="panel-title" style={{ marginTop: 24 }}>
        <h3>自动合并记录</h3>
        <button
          className="btn"
          type="button"
          disabled={loading || refreshing || saving}
          onClick={() => void refreshHistory()}
        >
          {refreshing ? "刷新中…" : "刷新记录"}
        </button>
      </div>
      {historyError ? (
        <ErrorPanel
          error={`无法读取执行记录：${historyError}`}
          onRetry={() => void refreshHistory()}
        />
      ) : history && !history.items.length ? (
        <Empty
          title="尚无自动合并记录"
          hint="开启后，新完成的审查会在这里显示等待检查、阻止原因或合并结果。"
        />
      ) : history ? (
        <div className="tablewrap">
          <table className="table">
            <thead>
              <tr>
                <th>Pull Request</th>
                <th>审查提交</th>
                <th>状态</th>
                <th>执行说明</th>
                <th>更新时间</th>
              </tr>
            </thead>
            <tbody>
              {history.items.map((item) => (
                <AutoMergeRow key={item.id} repo={repo} item={item} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function AutoMergeRow({
  repo,
  item,
}: {
  repo: Repository;
  item: AutoMergeItem;
}) {
  const repositoryPath = `${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  return (
    <tr>
      <td>
        <a
          href={`https://github.com/${repositoryPath}/pull/${item.pullNumber}`}
          target="_blank"
          rel="noreferrer"
        >
          #{item.pullNumber}
        </a>
        <div className="faint" style={{ fontSize: 11 }}>
          {METHOD_LABELS[item.method]}
        </div>
      </td>
      <td>
        <code title={item.headSha}>{item.headSha.slice(0, 12)}</code>
      </td>
      <td>
        <span className={`pill ${STATUS_CLASS[item.status] ?? "pill-dim"}`}>
          {STATUS_LABELS[item.status] ?? item.status}
        </span>
      </td>
      <td style={{ maxWidth: 380, overflowWrap: "anywhere" }}>
        {item.message || REASONS[item.reason] || item.reason}
        {item.mergeCommitSha ? (
          <div>
            <a
              href={`https://github.com/${repositoryPath}/commit/${encodeURIComponent(item.mergeCommitSha)}`}
              target="_blank"
              rel="noreferrer"
            >
              合并提交 {item.mergeCommitSha.slice(0, 12)}
            </a>
          </div>
        ) : null}
      </td>
      <td>{fmtTime(item.updatedAt)}</td>
    </tr>
  );
}
