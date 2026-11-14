/** 自动化规则：创建、版本更新、启停与无副作用试跑都在同一主体中定位。 */
import { useRef, useState } from "react";
import { AutomationPager, ExplanationTree } from "../../components/automation";
import {
  CollectionState,
  ConfirmAction,
  CreationForm,
  DefinitionList,
  Field,
  MutationNotice,
  WorkbenchSection,
  formatDate,
} from "../../components/workbench";
import { useAutomationRows } from "../../hooks/useAutomation";
import { useWorkbenchMutation } from "../../hooks/useWorkbench";
import {
  automation,
  parseAutomationObject,
  saveAutomationFile,
  type ActionPlan,
  type AutomationPageContext,
  type AutomationPreview,
  type AutomationRule,
  type Condition,
  type ObjectValue,
} from "../../lib/automation";
import { ConditionEditor, NEW_CONDITION, visualCondition } from "./condition";
const ACTION_LABELS: Record<string, string> = {
  "audit.record": "记录审计说明",
  "approval.request": "等待人工审批",
  "report.create": "生成审查报告",
  "finding.transition": "更新发现状态",
};
export function AutomationRules(context: AutomationPageContext) {
  const list = useAutomationRows("rules", context.repository);
  const changed = () => {
    list.refresh();
    context.onChanged();
  };
  const mutation = useWorkbenchMutation(changed);
  return (
    <WorkbenchSection
      title="事件规则"
      description="规则可以先保存为停用状态，使用真实结构的样本事件试跑后再启用。"
      actions={
        <button className="btn" disabled={list.loading} onClick={list.refresh}>
          刷新规则
        </button>
      }
    >
      <MutationNotice {...mutation} />
      {context.viewer.canWrite ? (
        <CreationForm title="新建自动化规则">
          <AutomationRuleForm {...context} onSaved={changed} />
        </CreationForm>
      ) : null}
      <button
        className="btn"
        disabled={mutation.busy}
        onClick={() =>
          void mutation.run(async () => {
            const result = await automation.exportRules(context.repository);
            saveAutomationFile(
              result.content,
              `${context.repository.replace("/", "-")}-automation-rules.jsonl`,
              "application/x-ndjson",
            );
          }, "规则已导出")
        }
      >
        导出规则 JSONL
      </button>
      <CollectionState
        {...list}
        count={list.items.length}
        empty="尚无自动化规则"
        hint="创建条件和动作后，后续审查事件就能按这些规则执行。"
      >
        {list.items.map((rule) => (
          <AutomationRuleCard
            key={`${rule.id}:${rule.version}`}
            {...context}
            rule={rule}
            onSaved={changed}
          />
        ))}
      </CollectionState>
      <AutomationPager {...list} />
    </WorkbenchSection>
  );
}
function AutomationRuleCard(
  context: AutomationPageContext & {
    rule: AutomationRule;
    onSaved: () => void;
  },
) {
  const { rule } = context;
  const mutation = useWorkbenchMutation(context.onSaved);
  return (
    <article className="wb-record">
      <div className="wb-record-head">
        <div>
          <h3>{rule.name}</h3>
          <p>{rule.description}</p>
        </div>
        <span className={`pill ${rule.enabled ? "pill-ok" : "pill-dim"}`}>
          {rule.enabled ? "已启用" : "已停用"} · v{rule.version}
        </span>
      </div>
      <DefinitionList
        values={[
          [
            "动作",
            rule.actions
              .map((action) => ACTION_LABELS[action.kind] ?? action.kind)
              .join(" → "),
          ],
          ["触发上限", `${rule.rate.limit} 次 / ${rule.rate.windowSeconds} 秒`],
          [
            "每次执行预算",
            `${rule.budget.maxActions} 步 · ${rule.budget.maxCostUnits} 单位 · ${rule.budget.maxDurationMs} ms`,
          ],
          ["更新时间", formatDate(rule.updatedAt)],
        ]}
      />
      {context.viewer.canWrite ? (
        <div className="actions">
          <ConfirmAction
            label={rule.enabled ? "停用规则" : "启用规则"}
            message={`确认${rule.enabled ? "停用" : "启用"}「${rule.name}」？之后收到的事件会使用更新后的状态。`}
            disabled={mutation.busy}
            onConfirm={() =>
              void mutation.run(
                () =>
                  automation.toggleRule(
                    context.repository,
                    rule.id,
                    !rule.enabled,
                  ),
                "规则状态已更新",
              )
            }
          />
          <ConfirmAction
            label="删除规则"
            dangerous
            message="删除后不再匹配新事件，已有执行记录和审计保留。"
            disabled={mutation.busy}
            onConfirm={() =>
              void mutation.run(
                () => automation.deleteRule(context.repository, rule.id),
                "规则已删除",
              )
            }
          />
        </div>
      ) : null}
      <MutationNotice {...mutation} />
      <details className="wb-subdetails">
        <summary>
          {context.viewer.canWrite
            ? "编辑规则与只读试跑"
            : "查看规则与只读试跑"}
        </summary>
        <AutomationRuleForm {...context} initial={rule} />
      </details>
    </article>
  );
}
export function AutomationRuleForm(
  context: AutomationPageContext & {
    initial?: AutomationRule;
    onSaved: () => void;
  },
) {
  const { initial } = context;
  const formRef = useRef<HTMLFormElement>(null);
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [condition, setCondition] = useState<Condition>(
    initial?.condition ?? NEW_CONDITION,
  );
  const [mode, setMode] = useState<"visual" | "json">("visual");
  const [conditionJson, setConditionJson] = useState(
    JSON.stringify(condition, null, 2),
  );
  const [actions, setActions] = useState<ActionPlan[]>(
    initial?.actions ?? [
      {
        kind: "audit.record",
        input: { message: "审查事件匹配规则" },
        costUnits: 1,
        maxAttempts: 3,
      },
    ],
  );
  const [rate, setRate] = useState(
    initial?.rate ?? { limit: 100, windowSeconds: 3600 },
  );
  const [budget, setBudget] = useState(
    initial?.budget ?? {
      maxActions: 20,
      maxCostUnits: 1000,
      maxDurationMs: 30000,
    },
  );
  const [windowJson, setWindowJson] = useState(
    initial?.window ? JSON.stringify(initial.window, null, 2) : "",
  );
  const [eventJson, setEventJson] = useState(
    JSON.stringify(
      {
        id: "preview-event",
        type: "review.completed",
        repository: context.repository,
        occurredAt: new Date().toISOString(),
        gate: "fail",
        risk: "high",
        findings: { total: 1, new: 1 },
      },
      null,
      2,
    ),
  );
  const [preview, setPreview] = useState<AutomationPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mutation = useWorkbenchMutation(context.onSaved);
  const previewMutation = useWorkbenchMutation();
  const makeRule = () => ({
    name:
      name.trim() ||
      (context.viewer.canWrite ? "" : (initial?.name ?? "试跑规则")),
    description: description.trim(),
    enabled,
    condition:
      mode === "json"
        ? parseAutomationObject(conditionJson, "规则条件")
        : condition,
    actions,
    rate,
    budget,
    window: windowJson.trim()
      ? parseAutomationObject(windowJson, "执行时间窗口")
      : null,
  });
  const editingDisabled = !context.viewer.canWrite;
  return (
    <div className="stack">
      <form
        ref={formRef}
        className="wb-form"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          void mutation.run(
            async () => {
              const rule = makeRule();
              if (!rule.name) throw new Error("请填写规则名称");
              if (initial)
                await automation.updateRule(
                  context.repository,
                  initial.id,
                  initial.version,
                  rule,
                );
              else await automation.createRule(context.repository, rule);
            },
            initial ? "规则新版本已保存" : "规则已保存",
          );
        }}
      >
        <Field label="规则名称" required>
          <input
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            disabled={editingDisabled}
            maxLength={200}
          />
        </Field>
        <Field label="规则说明">
          <input
            className="input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={editingDisabled}
            maxLength={2000}
          />
        </Field>
        <label className="wb-inline-label wb-field-wide">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            disabled={editingDisabled}
          />
          启用规则匹配新事件
        </label>
        <div className="wb-field-wide auto-condition-section">
          <div className="wb-filters">
            <strong>匹配条件</strong>
            <label className="wb-inline-label">
              编辑方式
              <select
                className="input"
                value={mode}
                onChange={(event) => {
                  const next = event.target.value as "visual" | "json";
                  try {
                    if (next === "json")
                      setConditionJson(JSON.stringify(condition, null, 2));
                    else
                      setCondition(
                        visualCondition(
                          parseAutomationObject(conditionJson, "规则条件"),
                        ),
                      );
                    setMode(next);
                    setError(null);
                  } catch (reason) {
                    setError(
                      reason instanceof Error ? reason.message : "条件无效",
                    );
                  }
                }}
              >
                <option value="visual">条件树</option>
                <option value="json">JSON 条件</option>
              </select>
            </label>
          </div>
          {mode === "visual" ? (
            <ConditionEditor
              condition={condition}
              onChange={(next) => {
                setCondition(next);
                setPreview(null);
              }}
              disabled={editingDisabled}
            />
          ) : (
            <Field label="规则条件 JSON">
              <textarea
                className="input wb-code"
                rows={8}
                value={conditionJson}
                onChange={(event) => {
                  setConditionJson(event.target.value);
                  setPreview(null);
                }}
                readOnly={editingDisabled}
              />
            </Field>
          )}
        </div>
        <fieldset className="wb-field-wide auto-actions">
          <legend>执行动作（按顺序）</legend>
          {actions.map((action, index) => (
            <ActionEditor
              key={`${index}:${action.kind}`}
              action={action}
              index={index}
              disabled={editingDisabled}
              supportedActions={context.supportedActions}
              onChange={(value) => {
                setActions(
                  actions.map((previous, at) =>
                    at === index ? value : previous,
                  ),
                );
                setPreview(null);
              }}
              onRemove={() =>
                setActions(actions.filter((_, at) => at !== index))
              }
              canRemove={actions.length > 1}
            />
          ))}
          {context.viewer.canWrite ? (
            <button
              className="btn"
              type="button"
              disabled={actions.length >= 20}
              onClick={() =>
                setActions([
                  ...actions,
                  {
                    kind: "audit.record",
                    input: { message: "审查事件匹配规则" },
                    costUnits: 1,
                    maxAttempts: 3,
                  },
                ])
              }
            >
              添加执行动作
            </button>
          ) : null}
        </fieldset>
        <Field label="每个窗口最多触发次数">
          <input
            className="input"
            type="number"
            min={1}
            max={10000}
            value={rate.limit}
            onChange={(event) =>
              setRate({ ...rate, limit: Number(event.target.value) })
            }
            disabled={editingDisabled}
            required
          />
        </Field>
        <Field label="速率窗口（秒）">
          <input
            className="input"
            type="number"
            min={1}
            max={86400}
            value={rate.windowSeconds}
            onChange={(event) =>
              setRate({ ...rate, windowSeconds: Number(event.target.value) })
            }
            disabled={editingDisabled}
            required
          />
        </Field>
        <Field label="每次最多动作数">
          <input
            className="input"
            type="number"
            min={1}
            max={20}
            value={budget.maxActions}
            onChange={(event) =>
              setBudget({ ...budget, maxActions: Number(event.target.value) })
            }
            disabled={editingDisabled}
            required
          />
        </Field>
        <Field label="每次最多成本单位">
          <input
            className="input"
            type="number"
            min={1}
            max={100000}
            value={budget.maxCostUnits}
            onChange={(event) =>
              setBudget({ ...budget, maxCostUnits: Number(event.target.value) })
            }
            disabled={editingDisabled}
            required
          />
        </Field>
        <Field label="每次最长执行时间（毫秒）">
          <input
            className="input"
            type="number"
            min={10}
            max={300000}
            value={budget.maxDurationMs}
            onChange={(event) =>
              setBudget({
                ...budget,
                maxDurationMs: Number(event.target.value),
              })
            }
            disabled={editingDisabled}
            required
          />
        </Field>
        <Field
          label="执行时间窗口 JSON"
          help="留空表示全天。对象包含 days（0–6）、start/end（HH:mm）和 utcOffsetMinutes。"
        >
          <textarea
            className="input wb-code"
            rows={3}
            value={windowJson}
            onChange={(event) => setWindowJson(event.target.value)}
            readOnly={editingDisabled}
          />
        </Field>
        {error ? (
          <p className="wb-notice wb-notice-error wb-field-wide" role="alert">
            {error}
          </p>
        ) : null}
        {context.viewer.canWrite ? (
          <div className="wb-form-footer">
            <button
              className="btn btn-primary"
              type="submit"
              disabled={mutation.busy}
            >
              {mutation.busy
                ? "保存中…"
                : initial
                  ? "保存规则新版本"
                  : "保存自动化规则"}
            </button>
          </div>
        ) : null}
      </form>
      <MutationNotice {...mutation} />
      <div className="auto-preview">
        <h4>只读试跑</h4>
        <p className="wb-help">
          下方是供试跑编辑的事件样本。试跑只解释条件和解析动作参数，不派发事件、不执行动作，也不产生审批或报告。
        </p>
        <Field label="试跑事件 JSON">
          <textarea
            className="input wb-code"
            rows={8}
            value={eventJson}
            onChange={(event) => {
              setEventJson(event.target.value);
              setPreview(null);
            }}
          />
        </Field>
        <button
          className="btn"
          type="button"
          disabled={previewMutation.busy}
          onClick={() =>
            void previewMutation.run(async () => {
              const invalid =
                formRef.current?.querySelector<HTMLTextAreaElement>(
                  "textarea:invalid",
                );
              if (invalid) {
                invalid.reportValidity();
                throw new Error("请先修正无效的 JSON 参数");
              }
              const event = parseAutomationObject(eventJson, "试跑事件");
              const result = await automation.preview(
                context.repository,
                initial && !context.viewer.canWrite
                  ? { id: initial.id, event }
                  : {
                      rule: {
                        ...makeRule(),
                        name: name.trim() || "未保存规则试跑",
                      },
                      event,
                    },
              );
              setPreview(result);
            }, "试跑完成，没有执行任何动作")
          }
        >
          解释规则匹配
        </button>
        <MutationNotice {...previewMutation} />
        {preview ? (
          <div>
            <strong>
              {preview.matched ? "该事件会匹配规则" : "该事件不会匹配规则"}
            </strong>
            <ExplanationTree explanation={preview.explanation} />
            {preview.actions.length ? (
              <div>
                <h4>匹配后将执行的动作</h4>
                {preview.actions.map((action, index) => (
                  <details key={index}>
                    <summary>
                      {index + 1}. {ACTION_LABELS[action.kind] ?? action.kind}
                    </summary>
                    <pre className="wb-json">
                      {JSON.stringify(action.input, null, 2)}
                    </pre>
                  </details>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
function ActionEditor({
  action,
  index,
  disabled,
  supportedActions,
  onChange,
  onRemove,
  canRemove,
}: {
  action: ActionPlan;
  index: number;
  disabled: boolean;
  supportedActions: string[];
  onChange: (action: ActionPlan) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const [json, setJson] = useState(JSON.stringify(action.input, null, 2));
  const [error, setError] = useState<string | null>(null);
  const changeInput = (input: ObjectValue) => {
    onChange({ ...action, input });
    setJson(JSON.stringify(input, null, 2));
  };
  return (
    <div className="auto-action">
      <div className="wb-filters">
        <strong>动作 {index + 1}</strong>
        <label className="wb-inline-label">
          类型
          <select
            className="input"
            value={action.kind}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...action,
                kind: event.target.value,
                input:
                  event.target.value === "approval.request"
                    ? {
                        title: "确认审查结果",
                        reason: "需要人工确认",
                        requireDifferentActor: true,
                      }
                    : event.target.value === "report.create"
                      ? { format: "markdown" }
                      : event.target.value === "finding.transition"
                        ? {
                            findingId: "",
                            status: "acknowledged",
                            reason: "自动化规则匹配",
                          }
                        : { message: "审查事件匹配规则" },
              })
            }
          >
            {supportedActions.map((kind) => (
              <option key={kind} value={kind}>
                {ACTION_LABELS[kind] ?? kind}
              </option>
            ))}
          </select>
        </label>
        {!disabled ? (
          <button
            className="btn btn-ghost"
            type="button"
            disabled={!canRemove}
            onClick={onRemove}
          >
            移除动作
          </button>
        ) : null}
      </div>
      {action.kind === "audit.record" ? (
        <Field label="审计说明">
          <input
            className="input"
            value={String(action.input.message ?? "")}
            onChange={(event) =>
              changeInput({ ...action.input, message: event.target.value })
            }
            disabled={disabled}
            required
          />
        </Field>
      ) : action.kind === "approval.request" ? (
        <div className="wb-form">
          <Field label="审批标题">
            <input
              className="input"
              value={String(action.input.title ?? "")}
              onChange={(event) =>
                changeInput({ ...action.input, title: event.target.value })
              }
              disabled={disabled}
              required
            />
          </Field>
          <Field label="审批原因">
            <input
              className="input"
              value={String(action.input.reason ?? "")}
              onChange={(event) =>
                changeInput({ ...action.input, reason: event.target.value })
              }
              disabled={disabled}
              required
            />
          </Field>
          <label className="wb-inline-label wb-field-wide">
            <input
              type="checkbox"
              checked={action.input.requireDifferentActor !== false}
              onChange={(event) =>
                changeInput({
                  ...action.input,
                  requireDifferentActor: event.target.checked,
                })
              }
              disabled={disabled}
            />
            审批人必须与请求人不同
          </label>
        </div>
      ) : action.kind === "report.create" ? (
        <Field label="生成报告格式">
          <select
            className="input"
            value={String(action.input.format ?? "markdown")}
            disabled={disabled}
            onChange={(event) =>
              changeInput({ ...action.input, format: event.target.value })
            }
          >
            <option value="markdown">Markdown</option>
            <option value="json">JSON</option>
            <option value="csv">CSV</option>
            <option value="sarif">SARIF</option>
          </select>
        </Field>
      ) : (
        <Field
          label="动作参数 JSON"
          help="可用完整对象 {$event:'字段路径'} 引用事件字段，不会执行表达式。"
        >
          <textarea
            className="input wb-code"
            value={json}
            onChange={(event) => {
              setJson(event.target.value);
              try {
                onChange({
                  ...action,
                  input: parseAutomationObject(
                    event.target.value,
                    "动作参数",
                  ) as ObjectValue,
                });
                setError(null);
                event.currentTarget.setCustomValidity("");
              } catch (reason) {
                event.currentTarget.setCustomValidity(
                  "动作参数需要合法 JSON 对象",
                );
                setError(
                  reason instanceof Error ? reason.message : "动作参数无效",
                );
              }
            }}
            readOnly={disabled}
            rows={4}
            aria-invalid={!!error}
          />
        </Field>
      )}
      {error ? (
        <p className="wb-notice wb-notice-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="wb-form">
        <Field label="动作成本单位">
          <input
            className="input"
            type="number"
            min={1}
            max={1000}
            value={action.costUnits}
            onChange={(event) =>
              onChange({ ...action, costUnits: Number(event.target.value) })
            }
            disabled={disabled}
            required
          />
        </Field>
        <Field label="动作最多尝试次数">
          <input
            className="input"
            type="number"
            min={1}
            max={10}
            value={action.maxAttempts}
            onChange={(event) =>
              onChange({ ...action, maxAttempts: Number(event.target.value) })
            }
            disabled={disabled}
            required
          />
        </Field>
      </div>
    </div>
  );
}
