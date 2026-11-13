/** 门禁试算是只读操作；人工确认选项只影响本次计算，不会写入审批记录。 */
import { useEffect, useRef, useState } from "react";
import {
  DefinitionList,
  Field,
  WorkbenchSection,
  formatDate,
} from "../../components/workbench";
import { useWorkbenchCollection } from "../../hooks/useWorkbench";
import {
  workbench,
  explainWorkbenchError,
  type GateResult,
} from "../../lib/workbench";
import type { WorkbenchTab } from "../../lib/workbench-tabs";
export const tab: WorkbenchTab = {
  id: "gate",
  label: "门禁试算",
  description: "组合不同策略和基线重算质量门禁，检查调整会带来哪些变化。",
  order: 15,
  render: ({ repository }) => <GatePreview repository={repository} />,
};
const DECISIONS = { pass: "通过", warn: "需关注", fail: "阻止合入" };
export function GatePreview({ repository }: { repository: string }) {
  const policies = useWorkbenchCollection("policies", repository);
  const baselines = useWorkbenchCollection("baselines", repository);
  const findings = useWorkbenchCollection("findings", repository);
  const [policyId, setPolicyId] = useState("");
  const [baselineId, setBaselineId] = useState("");
  const [approved, setApproved] = useState(false);
  const [result, setResult] = useState<GateResult | null>(null);
  const [previous, setPrevious] = useState<GateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  return (
    <WorkbenchSection
      title="质量门禁试算"
      description="试算不激活策略、不替换基线，也不代表已经取得人工审批。只有保存并激活后的规则才会用于默认门禁。"
    >
      <form
        className="wb-form"
        onSubmit={(event) => {
          event.preventDefault();
          controller.current?.abort();
          const current = new AbortController();
          controller.current = current;
          setBusy(true);
          setError(null);
          workbench
            .gate(repository, current.signal, {
              policyId,
              baselineId,
              humanApproved: approved,
            })
            .then((value) => {
              if (!current.signal.aborted) {
                setPrevious(result);
                setResult(value);
              }
            })
            .catch((reason) => {
              if (!current.signal.aborted)
                setError(explainWorkbenchError(reason));
            })
            .finally(() => {
              if (!current.signal.aborted) setBusy(false);
            });
        }}
      >
        <Field
          label="使用策略"
          help="留空使用最近更新的启用策略；显式选择可重现历史规则。"
        >
          <select
            className="input"
            value={policyId}
            onChange={(event) => setPolicyId(event.target.value)}
          >
            <option value="">自动选择生效策略</option>
            {policies.items.map((policy) => (
              <option key={policy.id} value={policy.id}>
                {policy.name} · v{policy.activeVersion}
                {policy.enabled ? "" : " · 已停用"}
              </option>
            ))}
          </select>
          {policies.error ? <small role="alert">{policies.error}</small> : null}
        </Field>
        <Field
          label="对照基线"
          help="留空使用当前生效基线；这里选择不会改变仓库默认基线。"
        >
          <select
            className="input"
            value={baselineId}
            onChange={(event) => setBaselineId(event.target.value)}
          >
            <option value="">自动选择当前基线</option>
            {baselines.items
              .filter((baseline) => !baseline.archived)
              .map((baseline) => (
                <option key={baseline.id} value={baseline.id}>
                  {baseline.name} · {baseline.reference}
                </option>
              ))}
          </select>
          {baselines.error ? (
            <small role="alert">{baselines.error}</small>
          ) : null}
        </Field>
        <label className="wb-inline-label wb-field-wide">
          <input
            type="checkbox"
            checked={approved}
            onChange={(event) => setApproved(event.target.checked)}
          />
          模拟已取得人工确认（仅本次只读试算）
        </label>
        <div className="wb-form-footer">
          <button
            className="btn btn-primary"
            type="submit"
            disabled={busy || policies.loading || baselines.loading}
          >
            {busy ? "计算中…" : "计算门禁"}
          </button>
        </div>
      </form>
      {error ? (
        <p role="alert" className="wb-notice wb-notice-error">
          {error}
        </p>
      ) : null}
      {result ? (
        <div className="wb-gate-preview" aria-live="polite">
          <div className={`wb-gate wb-gate-${result.decision}`}>
            <strong>{DECISIONS[result.decision]}</strong>
            <span>{formatDate(result.evaluatedAt)}</span>
          </div>
          <DefinitionList
            values={[
              ["新增发现", result.counts.new],
              ["已有发现", result.counts.existing],
              ["抑制发现", result.counts.suppressed],
              ["已解决发现", result.counts.resolved],
              ["策略版本", result.policyVersion ?? "默认规则"],
              [
                "基线",
                baselines.items.find(
                  (baseline) => baseline.id === result.baselineId,
                )?.name ?? "未设置",
              ],
            ]}
          />
          {previous ? (
            <p className="wb-notice">
              与上一次试算比较：{DECISIONS[previous.decision]} →{" "}
              {DECISIONS[result.decision]}；新增发现 {previous.counts.new} →{" "}
              {result.counts.new}；抑制发现 {previous.counts.suppressed} →{" "}
              {result.counts.suppressed}。
            </p>
          ) : null}
          <ul className="wb-checks">
            {result.checks.map((check, index) => (
              <li key={`${check.name}:${index}`}>
                <span className={`pill wb-gate-${check.decision}`}>
                  {DECISIONS[check.decision]}
                </span>
                <div>
                  <strong>{check.name}</strong>
                  <p>{check.message}</p>
                  {check.findingIds.length ? (
                    <details>
                      <summary>关联发现（{check.findingIds.length}）</summary>
                      <ul>
                        {check.findingIds.map((id) => (
                          <li key={id}>
                            {findings.items.find((finding) => finding.id === id)
                              ?.title ?? id}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="wb-help">
          选择试算条件后点击「计算门禁」。页面不自动假定人工确认，也不会写入审批结论。
        </p>
      )}
    </WorkbenchSection>
  );
}
