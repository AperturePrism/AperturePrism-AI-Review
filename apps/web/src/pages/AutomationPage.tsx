/** 自动化工作台入口；身份和写权限来自宿主 summary.viewer，不从本地角色名猜测。 */
import { useCallback, useEffect, useState } from "react";
import { SparkleIcon } from "../components/icons";
import { ErrorPanel } from "../components/ui";
import { Field } from "../components/workbench";
import type { ConsolePage } from "../lib/navigation";
import { automation, type AutomationSummary } from "../lib/automation";
import { normalizeRepository } from "../lib/workbench";
import { fetchRepositories } from "../lib/api";
import { navigate, useHashRoute } from "../hooks/useHash";
import { AutomationRules } from "../features/automation/rule";
import { AutomationRuns } from "../features/automation/run";
import { AutomationEvents } from "../features/automation/event";
import { AutomationApprovals } from "../features/automation/approval";
import { AutomationReports } from "../features/automation/report";
import { AutomationAuditPage } from "../features/automation/audit";
export const consolePages: ConsolePage[] = [
  {
    path: "/automation",
    label: "审查自动化",
    group: "analysis",
    order: 24,
    icon: SparkleIcon,
    render: () => <AutomationPage />,
  },
];
const SECTIONS = [
  { id: "rules", label: "规则与试跑" },
  { id: "runs", label: "执行记录" },
  { id: "events", label: "事件记录" },
  { id: "approvals", label: "人工审批" },
  { id: "reports", label: "生成报告" },
  { id: "audit", label: "操作审计" },
];
const STORAGE_KEY = "apertureprism.automation.repository";
function initialRepository(route: string): string {
  try {
    const value =
      new URLSearchParams(route.split("?")[1] ?? "").get("repository") ??
      localStorage.getItem(STORAGE_KEY) ??
      "";
    return value ? normalizeRepository(value).toLowerCase() : "";
  } catch {
    return "";
  }
}
export function AutomationPage() {
  const route = useHashRoute();
  const [repository, setRepository] = useState(() => initialRepository(route));
  const [draft, setDraft] = useState(repository);
  const [choices, setChoices] = useState<string[]>([]);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [summaryState, setSummary] = useState<{
    repository: string;
    data: AutomationSummary;
  } | null>(null);
  const summary =
    summaryState?.repository === repository ? summaryState.data : null;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const onChanged = useCallback(() => setRevision((value) => value + 1), []);
  const part = (route.split("?")[0] ?? "").split("/")[2] ?? "rules";
  const section = SECTIONS.some((item) => item.id === part) ? part : "rules";
  useEffect(() => {
    let active = true;
    fetchRepositories()
      .then((data) => {
        if (active) setChoices(data.items.map((item) => item.fullName));
      })
      .catch(() => {
        /* 仓库列表不可用时仍允许显式输入授权仓库。 */
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const next = initialRepository(route);
    if (next) {
      setRepository(next);
      setDraft(next);
    }
  }, [route]);
  useEffect(() => {
    if (!repository) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    automation
      .summary(repository, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setSummary({ repository, data });
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setError(
            reason instanceof Error ? reason.message : "读取自动化概况失败",
          );
          setSummary(null);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [repository, revision]);
  const context = summary
    ? {
        repository,
        viewer: summary.viewer,
        supportedActions: summary.supportedActions,
        onChanged,
      }
    : null;
  return (
    <div className="stack wb-page auto-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">审查自动化</h1>
          <p className="page-desc">
            按真实事件匹配规则，追踪每一步执行、人工确认与报告结果。
          </p>
        </div>
        <button
          className="btn"
          disabled={!repository || loading}
          onClick={onChanged}
        >
          刷新概况
        </button>
      </div>
      <section className="panel wb-scope">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            try {
              const normalized = normalizeRepository(draft).toLowerCase();
              setSummary(null);
              setRepository(normalized);
              setScopeError(null);
              onChanged();
              try {
                localStorage.setItem(STORAGE_KEY, normalized);
              } catch {
                /* 禁用本地存储时当前会话仍可使用。 */
              }
              navigate(
                `/automation/${section}?repository=${encodeURIComponent(normalized)}`,
              );
            } catch (reason) {
              setScopeError(
                reason instanceof Error ? reason.message : "仓库名称无效",
              );
            }
          }}
        >
          <Field label="自动化仓库" required>
            <div className="wb-scope-input">
              <input
                className="input"
                list="automation-repositories"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                required
                placeholder="owner/repository"
                autoCapitalize="none"
                spellCheck={false}
              />
              <button className="btn btn-primary" type="submit">
                选择仓库
              </button>
            </div>
          </Field>
          <datalist id="automation-repositories">
            {choices.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </form>
        {scopeError ? (
          <p role="alert" className="wb-notice wb-notice-error">
            {scopeError}
          </p>
        ) : null}
      </section>
      {summary ? (
        <div className="wb-metrics">
          <div className="wb-metric">
            <span>启用规则</span>
            <strong>
              {summary.enabledRules}
              <small> / {summary.rules}</small>
            </strong>
          </div>
          <div className="wb-metric">
            <span>自动化执行</span>
            <strong>{summary.runs}</strong>
          </div>
          <div className="wb-metric">
            <span>等待人工审批</span>
            <strong>{summary.pendingApprovals}</strong>
          </div>
          <div className="wb-metric">
            <span>当前权限</span>
            <strong className="auto-permission">
              {summary.viewer.canWrite ? "可管理" : "只读"}
            </strong>
            <small>
              {summary.viewer.userId}
              {summary.viewer.isAdmin ? " · 管理员" : ""}
            </small>
          </div>
        </div>
      ) : null}
      <nav className="wb-tabs" aria-label="自动化功能">
        {SECTIONS.map((item) => (
          <a
            key={item.id}
            href={`#/automation/${item.id}${repository ? `?repository=${encodeURIComponent(repository)}` : ""}`}
            className={section === item.id ? "wb-tab wb-tab-active" : "wb-tab"}
            aria-current={section === item.id ? "page" : undefined}
          >
            {item.label}
          </a>
        ))}
      </nav>
      {!repository ? (
        <div className="panel wb-welcome">
          <SparkleIcon size={32} />
          <h2>选择仓库后管理审查自动化</h2>
          <p>可以先创建停用规则并试跑，核对匹配条件和动作，再启用正式执行。</p>
        </div>
      ) : error ? (
        <ErrorPanel error={error} onRetry={onChanged} />
      ) : !context ? (
        <p role="status">读取当前仓库权限与自动化概况…</p>
      ) : (
        <div key={`${repository}:${section}`} className="stack">
          {!context.viewer.canWrite ? (
            <p className="wb-notice">
              当前账号只有查看权限；可以查看记录、下载报告和只读试跑规则。
            </p>
          ) : null}
          {section === "rules" ? (
            <AutomationRules {...context} />
          ) : section === "runs" ? (
            <AutomationRuns {...context} />
          ) : section === "events" ? (
            <AutomationEvents {...context} />
          ) : section === "approvals" ? (
            <AutomationApprovals {...context} />
          ) : section === "reports" ? (
            <AutomationReports {...context} />
          ) : (
            <AutomationAuditPage {...context} />
          )}
        </div>
      )}
    </div>
  );
}
