/** 预算界面只用整数微美元与整数 token；额度和真实用量分别展示。 */
import { useState } from "react";
import {
  CollectionState,
  ConfirmAction,
  CreationForm,
  DefinitionList,
  Field,
  MutationNotice,
  PagedList,
  ProgressMeter,
  WorkbenchSection,
  formatDate,
} from "../../components/workbench";
import {
  useWorkbenchCollection,
  useWorkbenchMutation,
} from "../../hooks/useWorkbench";
import {
  dollarsToMicros,
  formatDollars,
  nonnegativeNumber,
  workbench,
  type Budget,
} from "../../lib/workbench";
import type { WorkbenchTab } from "../../lib/workbench-tabs";
export const tab: WorkbenchTab = {
  id: "budgets",
  label: "预算与用量",
  description: "按时间窗口管理金额、token 和请求额度，核对实际使用量。",
  order: 70,
  render: ({ repository }) => <Budgets repository={repository} />,
};
export function Budgets({ repository }: { repository: string }) {
  const list = useWorkbenchCollection("budgets", repository);
  const mutation = useWorkbenchMutation(list.refresh);
  const [name, setName] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [amount, setAmount] = useState("");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [requests, setRequests] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <WorkbenchSection
      title="仓库预算"
      description="额度使用独立预占与结算流程；页面中用量由执行端实际结算，不按批次数估算。"
      actions={
        <button className="btn" onClick={list.refresh} disabled={list.loading}>
          刷新预算
        </button>
      }
    >
      <MutationNotice {...mutation} />
      <CreationForm title="创建预算窗口">
        <form
          className="wb-form"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            const submit = async () => {
              try {
                if (!name.trim()) throw new Error("请填写预算名称");
                const periodStart = new Date(start);
                const periodEnd = new Date(end);
                if (
                  !Number.isFinite(periodStart.getTime()) ||
                  !Number.isFinite(periodEnd.getTime()) ||
                  periodEnd <= periodStart
                )
                  throw new Error("结束时间必须晚于开始时间");
                const limits = {
                  amountMicros: dollarsToMicros(amount),
                  inputTokens: nonnegativeNumber(input, "输入 token 额度"),
                  outputTokens: nonnegativeNumber(output, "输出 token 额度"),
                  requests: nonnegativeNumber(requests, "请求次数额度"),
                };
                if (
                  await mutation.run(
                    () =>
                      workbench.create("budgets", repository, {
                        name: name.trim(),
                        periodStart: periodStart.toISOString(),
                        periodEnd: periodEnd.toISOString(),
                        limits,
                      }),
                    "预算窗口已创建",
                  )
                )
                  setName("");
              } catch (reason) {
                setError(
                  reason instanceof Error ? reason.message : "预算填写有误",
                );
              }
            };
            void submit();
          }}
        >
          <Field label="预算名称" required>
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={160}
            />
          </Field>
          <Field
            label="美元额度"
            required
            help="最多六位小数；0 表示不允许消费金额。"
          >
            <input
              className="input"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              placeholder="10.00"
              required
            />
          </Field>
          <Field label="开始时间" required>
            <input
              className="input"
              type="datetime-local"
              value={start}
              onChange={(event) => setStart(event.target.value)}
              required
            />
          </Field>
          <Field label="结束时间" required>
            <input
              className="input"
              type="datetime-local"
              value={end}
              onChange={(event) => setEnd(event.target.value)}
              required
            />
          </Field>
          <Field label="输入 token 额度" required>
            <input
              className="input"
              type="number"
              min={0}
              step={1}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              required
            />
          </Field>
          <Field label="输出 token 额度" required>
            <input
              className="input"
              type="number"
              min={0}
              step={1}
              value={output}
              onChange={(event) => setOutput(event.target.value)}
              required
            />
          </Field>
          <Field label="请求次数额度" required>
            <input
              className="input"
              type="number"
              min={0}
              step={1}
              value={requests}
              onChange={(event) => setRequests(event.target.value)}
              required
            />
          </Field>
          {error ? (
            <p className="wb-notice wb-notice-error wb-field-wide" role="alert">
              {error}
            </p>
          ) : null}
          <div className="wb-form-footer">
            <button
              className="btn btn-primary"
              type="submit"
              disabled={mutation.busy}
            >
              {mutation.busy ? "创建中…" : "创建预算"}
            </button>
          </div>
        </form>
      </CreationForm>
      <CollectionState
        {...list}
        count={list.items.length}
        empty="尚未配置预算"
        hint="为审查设置明确的时间窗口和额度。"
      >
        <PagedList
          items={list.items}
          label="预算"
          searchText={(item) =>
            `${item.name} ${item.periodStart} ${item.periodEnd}`
          }
          render={(budget) => (
            <BudgetCard
              key={budget.id}
              budget={budget}
              repository={repository}
              refresh={list.refresh}
            />
          )}
        />
      </CollectionState>
    </WorkbenchSection>
  );
}
function BudgetCard({
  budget,
  repository,
  refresh,
}: {
  budget: Budget;
  repository: string;
  refresh: () => void;
}) {
  const mutation = useWorkbenchMutation(refresh);
  const now = Date.now();
  const window =
    now < Date.parse(budget.periodStart)
      ? "尚未开始"
      : now >= Date.parse(budget.periodEnd)
        ? "已结束"
        : "当前窗口";
  const remaining = budget.limits.amountMicros - budget.usage.amountMicros;
  return (
    <article className="wb-record">
      <div className="wb-record-head">
        <div>
          <h3>{budget.name}</h3>
          <p>
            {formatDate(budget.periodStart)} — {formatDate(budget.periodEnd)}
          </p>
        </div>
        <span
          className={`pill ${budget.enabled && window === "当前窗口" ? "pill-ok" : "pill-dim"}`}
        >
          {budget.enabled ? window : "已停用"}
        </span>
      </div>
      <div className="wb-budget-headline">
        <strong>{formatDollars(budget.usage.amountMicros)}</strong>
        <span>已用 / {formatDollars(budget.limits.amountMicros)} 额度</span>
      </div>
      <ProgressMeter
        label="金额（微美元）"
        value={budget.usage.amountMicros}
        max={budget.limits.amountMicros}
      />
      <div className="wb-two-columns">
        <ProgressMeter
          label="输入 token"
          value={budget.usage.inputTokens}
          max={budget.limits.inputTokens}
        />
        <ProgressMeter
          label="输出 token"
          value={budget.usage.outputTokens}
          max={budget.limits.outputTokens}
        />
      </div>
      <ProgressMeter
        label="请求次数"
        value={budget.usage.requests}
        max={budget.limits.requests}
      />
      <DefinitionList
        values={[
          ["剩余金额", formatDollars(Math.max(0, remaining))],
          ["币种", budget.currency],
          ["创建时间", formatDate(budget.createdAt)],
        ]}
      />
      {remaining <= 0 ? (
        <p className="wb-notice wb-notice-warning">
          金额额度已用尽，新的预占请求会被预算边界拒绝。
        </p>
      ) : null}
      <ConfirmAction
        label={budget.enabled ? "停用预算" : "启用预算"}
        message={
          budget.enabled
            ? "停用后此预算窗口不再接受新的预占，现有用量记录会保留。"
            : "启用后将按此窗口额度限制新的预占，现有用量记录会保留。"
        }
        disabled={mutation.busy}
        onConfirm={() =>
          void mutation.run(
            () =>
              workbench.action("budgets", budget.id, "toggle", repository, {
                enabled: !budget.enabled,
              }),
            "预算状态已更新",
          )
        }
      />
      <MutationNotice {...mutation} />
    </article>
  );
}
