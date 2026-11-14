/** 自动化运行：展示实际事件、条件解释和每一步状态；重试不会重跑已完成步骤。 */
import { useState } from "react";
import { AutomationPager, ExplanationTree } from "../../components/automation";
import {
  CollectionState,
  ConfirmAction,
  DefinitionList,
  MutationNotice,
  WorkbenchSection,
  formatDate,
} from "../../components/workbench";
import { useAutomationRows } from "../../hooks/useAutomation";
import { useWorkbenchMutation } from "../../hooks/useWorkbench";
import {
  automation,
  type AutomationPageContext,
  type AutomationRun,
  type RunState,
  type RunStep,
} from "../../lib/automation";
export const RUN_LABELS: Record<RunState, string> = {
  queued: "等待执行",
  running: "执行中",
  waiting: "等待审批",
  retry_wait: "等待重试",
  completed: "已完成",
  failed: "失败",
  canceled: "已取消",
};
const STEP_LABELS: Record<RunStep["state"], string> = {
  pending: "未开始",
  running: "执行中",
  waiting: "等待确认",
  completed: "已完成",
  failed: "失败",
};
export function AutomationRuns(context: AutomationPageContext) {
  const [state, setState] = useState("");
  const list = useAutomationRows("runs", context.repository, state);
  const changed = () => {
    list.refresh();
    context.onChanged();
  };
  return (
    <WorkbenchSection
      title="自动化执行记录"
      description="状态来自持久执行账本；等待审批的运行只能在审批完成后继续。"
      actions={
        <button className="btn" disabled={list.loading} onClick={list.refresh}>
          刷新执行记录
        </button>
      }
    >
      <label className="wb-inline-label">
        执行状态
        <select
          className="input"
          value={state}
          onChange={(event) => setState(event.target.value)}
        >
          <option value="">全部状态</option>
          {Object.entries(RUN_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <CollectionState
        {...list}
        count={list.items.length}
        empty="没有匹配的执行记录"
        hint="启用规则匹配真实审查事件后，执行记录会显示在这里。"
      >
        {list.items.map((run) => (
          <AutomationRunCard
            key={`${run.id}:${run.updatedAt}`}
            {...context}
            run={run}
            onRefresh={changed}
          />
        ))}
      </CollectionState>
      <AutomationPager {...list} />
    </WorkbenchSection>
  );
}
export function AutomationRunCard(
  context: AutomationPageContext & {
    run: AutomationRun;
    onRefresh: () => void;
  },
) {
  const { run } = context;
  const mutation = useWorkbenchMutation(context.onRefresh);
  const terminal = ["completed", "failed", "canceled"].includes(run.state);
  const canResume =
    run.state === "queued" ||
    (run.state === "retry_wait" &&
      !!run.nextAttemptAt &&
      Date.parse(run.nextAttemptAt) <= Date.now()) ||
    (run.state === "running" &&
      !!run.leaseUntil &&
      Date.parse(run.leaseUntil) <= Date.now());
  return (
    <article className="wb-record">
      <div className="wb-record-head">
        <div>
          <h3>{run.ruleName}</h3>
          <p>
            规则 v{run.ruleVersion} · 事件 {run.eventId}
          </p>
        </div>
        <span
          className={`pill ${run.state === "completed" ? "pill-ok" : run.state === "failed" ? "pill-err" : run.state === "waiting" ? "pill-warn" : "pill-info"}`}
        >
          {RUN_LABELS[run.state]}
        </span>
      </div>
      <DefinitionList
        values={[
          ["执行 ID", <code>{run.id}</code>],
          [
            "完成步骤",
            `${run.steps.filter((step) => step.state === "completed").length} / ${run.steps.length}`,
          ],
          ["累计成本单位", `${run.costUsed} / ${run.budget.maxCostUnits}`],
          ["累计耗时", `${run.durationMs} / ${run.budget.maxDurationMs} ms`],
          ["创建人", run.createdBy],
          ["创建时间", formatDate(run.createdAt)],
          ["下次重试", formatDate(run.nextAttemptAt)],
          ["执行租约", formatDate(run.leaseUntil)],
        ]}
      />
      {context.viewer.canWrite ? (
        <div className="actions">
          {canResume ? (
            <button
              className="btn btn-primary"
              disabled={mutation.busy}
              onClick={() =>
                void mutation.run(
                  () =>
                    automation.runAction(context.repository, run.id, "resume"),
                  "已请求恢复运行，状态以刷新结果为准",
                )
              }
            >
              继续执行
            </button>
          ) : null}
          {run.state === "failed" ? (
            <ConfirmAction
              label="重试失败步骤"
              message="保留已完成步骤和累计预算，只重试失败或未确认的步骤；剩余预算不足时服务端会拒绝。"
              disabled={mutation.busy}
              onConfirm={() =>
                void mutation.run(
                  () =>
                    automation.runAction(context.repository, run.id, "retry"),
                  "失败步骤重试已提交",
                )
              }
            />
          ) : null}
          {!terminal ? (
            <ConfirmAction
              label="取消执行"
              dangerous
              message="取消后未完成步骤不再继续，已有结果和审计会保留。待审批请求也将被关闭。"
              disabled={mutation.busy}
              onConfirm={() =>
                void mutation.run(
                  () =>
                    automation.runAction(context.repository, run.id, "cancel"),
                  "运行已取消",
                )
              }
            />
          ) : null}
        </div>
      ) : null}
      {run.state === "waiting" ? (
        <p className="wb-notice wb-notice-warning">
          此运行正在等待人工审批。
          <a
            href={`#/automation/approvals?repository=${encodeURIComponent(context.repository)}`}
          >
            查看待审批请求
          </a>
        </p>
      ) : run.state === "retry_wait" && !canResume ? (
        <p className="wb-help">重试时间尚未到达；到期后可刷新并继续执行。</p>
      ) : null}
      <MutationNotice {...mutation} />
      <details className="wb-subdetails">
        <summary>触发事件与匹配原因</summary>
        <pre className="wb-json">{JSON.stringify(run.event, null, 2)}</pre>
        <ExplanationTree explanation={run.explanation} />
      </details>
      <details className="wb-subdetails">
        <summary>执行步骤、结果与错误（{run.steps.length}）</summary>
        <ol className="auto-run-steps">
          {run.steps.map((step, index) => (
            <li key={step.id}>
              <div className="wb-record-head">
                <strong>
                  {index + 1}. {step.kind}
                </strong>
                <span
                  className={`pill ${step.state === "completed" ? "pill-ok" : step.state === "failed" ? "pill-err" : "pill-dim"}`}
                >
                  {STEP_LABELS[step.state]}
                </span>
              </div>
              <DefinitionList
                values={[
                  ["尝试次数", `${step.attempts} / ${step.maxAttempts}`],
                  ["成本单位", step.costUnits],
                  ["开始", formatDate(step.startedAt)],
                  ["完成", formatDate(step.completedAt)],
                ]}
              />
              {step.error ? (
                <p className="wb-notice wb-notice-error">{step.error}</p>
              ) : null}
              <details>
                <summary>输入参数与输出</summary>
                <h5>输入</h5>
                <pre className="wb-json">
                  {JSON.stringify(step.input, null, 2)}
                </pre>
                <h5>输出</h5>
                <pre className="wb-json">
                  {JSON.stringify(step.output, null, 2)}
                </pre>
              </details>
            </li>
          ))}
        </ol>
      </details>
    </article>
  );
}
