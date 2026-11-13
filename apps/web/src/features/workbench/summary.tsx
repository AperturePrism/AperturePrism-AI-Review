/** 仓库的门禁与审查概览；数据来自 /api/workbench/summary，没有客户端示例指标。 */
import { useCallback, useEffect, useState } from "react";
import {
  CollectionState,
  DefinitionList,
  MutationNotice,
  SEVERITIES,
  SeverityBadge,
  WorkbenchSection,
  formatDate,
} from "../../components/workbench";
import {
  workbench,
  explainWorkbenchError,
  formatDollars,
  downloadReport,
  type WorkbenchSummary,
  type ReportFormat,
} from "../../lib/workbench";
import type { WorkbenchTab } from "../../lib/workbench-tabs";
import { useWorkbenchMutation } from "../../hooks/useWorkbench";

export const tab: WorkbenchTab = {
  id: "summary",
  label: "总览与门禁",
  description: "查看当前策略的实际门禁结果，以及新增、已有、抑制和已解决发现。",
  order: 0,
  render: ({ repository }) => <Summary repository={repository} />,
};

const DECISION_LABEL = { pass: "通过", warn: "需关注", fail: "阻止合入" };
export function Summary({ repository }: { repository: string }) {
  const [summary, setSummary] = useState<WorkbenchSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [format, setFormat] = useState<ReportFormat>("markdown");
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  const mutation = useWorkbenchMutation();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    workbench
      .summary(repository, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setSummary(value);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(explainWorkbenchError(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [repository, version]);
  return (
    <>
      <WorkbenchSection
        title="仓库审查概况"
        actions={
          <button
            className="btn"
            type="button"
            disabled={loading}
            onClick={refresh}
          >
            刷新概况
          </button>
        }
      >
        <CollectionState
          loading={loading}
          error={error}
          count={summary ? 1 : 0}
          refresh={refresh}
          empty="尚无概况"
        >
          {summary ? (
            <>
              <div className="wb-metrics">
                <Metric
                  label="待处置发现"
                  value={summary.openFindings}
                  hint={`全部 ${summary.findings} 个`}
                />
                <Metric
                  label="生效策略"
                  value={summary.activePolicies}
                  hint={`已保存 ${summary.policies} 份`}
                />
                <Metric
                  label="运行中批次"
                  value={summary.runningBatches}
                  hint={`全部 ${summary.batches} 批`}
                />
                <Metric
                  label="待处理反馈"
                  value={summary.pendingFeedback}
                  hint="人工审查的改进信号"
                />
              </div>
              <div className="wb-severity-grid">
                {SEVERITIES.map((severity) => (
                  <div key={severity}>
                    <SeverityBadge severity={severity} />
                    <strong>{summary.severity[severity]}</strong>
                  </div>
                ))}
              </div>
              <DefinitionList
                values={[
                  ["基线数量", summary.baselines],
                  ["已抑制发现", summary.suppressedFindings],
                  ["预算总额", formatDollars(summary.budgetAmountMicros)],
                  ["已用金额", formatDollars(summary.spentAmountMicros)],
                ]}
              />
            </>
          ) : null}
        </CollectionState>
      </WorkbenchSection>
      {summary ? (
        <WorkbenchSection
          title="质量门禁"
          description="门禁由生效策略、基线和当前发现计算；具体阻止原因保持可见。"
        >
          <div className={`wb-gate wb-gate-${summary.gate.decision}`}>
            <span className="wb-gate-mark" aria-hidden="true">
              {summary.gate.decision === "pass"
                ? "✓"
                : summary.gate.decision === "warn"
                  ? "!"
                  : "×"}
            </span>
            <div>
              <strong>{DECISION_LABEL[summary.gate.decision]}</strong>
              <p>评估于 {formatDate(summary.gate.evaluatedAt)}</p>
            </div>
          </div>
          <div className="wb-gate-counts">
            {Object.entries({
              新增: summary.gate.counts.new,
              已有: summary.gate.counts.existing,
              抑制: summary.gate.counts.suppressed,
              已解决: summary.gate.counts.resolved,
            }).map(([label, count]) => (
              <span key={label}>
                {label} <strong>{count}</strong>
              </span>
            ))}
          </div>
          <ul className="wb-checks">
            {summary.gate.checks.map((check, index) => (
              <li key={`${check.name}:${index}`}>
                <span className={`pill wb-gate-${check.decision}`}>
                  {DECISION_LABEL[check.decision]}
                </span>
                <div>
                  <strong>{check.name}</strong>
                  <p>{check.message}</p>
                  {check.findingIds.length ? (
                    <small>关联 {check.findingIds.length} 个发现</small>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          <DefinitionList
            values={[
              ["策略版本", summary.gate.policyVersion ?? "尚无生效策略"],
              ["策略 ID", summary.gate.policyId ?? "未设置"],
              ["基线 ID", summary.gate.baselineId ?? "未设置"],
            ]}
          />
        </WorkbenchSection>
      ) : null}
      <WorkbenchSection
        title="导出审查报告"
        description="报告包含当前仓库的审查状态。CSV 可用于表格分析，SARIF 可导入支持该格式的工具。"
      >
        <div className="actions">
          <label className="wb-inline-label">
            格式{" "}
            <select
              className="input"
              value={format}
              onChange={(event) =>
                setFormat(event.target.value as ReportFormat)
              }
            >
              <option value="markdown">Markdown</option>
              <option value="json">JSON</option>
              <option value="csv">CSV</option>
              <option value="sarif">SARIF 2.1.0</option>
            </select>
          </label>
          <button
            className="btn btn-primary"
            type="button"
            disabled={mutation.busy}
            onClick={() =>
              void mutation.run(
                () => downloadReport(repository, format),
                "报告已下载",
              )
            }
          >
            {mutation.busy ? "生成报告中…" : "下载报告"}
          </button>
        </div>
        <MutationNotice {...mutation} />
      </WorkbenchSection>
    </>
  );
}
function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint: string;
}) {
  return (
    <div className="wb-metric">
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
      <small>{hint}</small>
    </div>
  );
}
