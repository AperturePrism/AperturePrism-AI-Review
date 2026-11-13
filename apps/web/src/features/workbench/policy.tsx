/** 审查策略：规则、版本和启停都在本页；新版本保存不会自动激活。 */
import { useState } from "react";
import {
  CollectionState,
  ConfirmAction,
  CreationForm,
  DefinitionList,
  Field,
  MutationNotice,
  PagedList,
  SEVERITIES,
  SEVERITY_LABELS,
  WorkbenchSection,
  formatDate,
} from "../../components/workbench";
import {
  useWorkbenchCollection,
  useWorkbenchMutation,
} from "../../hooks/useWorkbench";
import {
  nonnegativeNumber,
  workbench,
  type Policy,
  type PolicyRules,
  type Severity,
} from "../../lib/workbench";
import type { WorkbenchTab } from "../../lib/workbench-tabs";

export const tab: WorkbenchTab = {
  id: "policies",
  label: "策略与版本",
  description: "编辑质量门禁规则，保留版本历史，并显式激活需要执行的版本。",
  order: 10,
  render: ({ repository }) => <Policies repository={repository} />,
};
const EMPTY_RULES: PolicyRules = {
  blockedSeverities: ["critical", "high"],
  maxNewFindings: 10,
  minConfidence: 0.7,
  requireBaseline: false,
  requireHumanApproval: false,
  includePaths: [],
  excludePaths: [],
  labels: [],
};
function lineValues(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\n|,/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function Policies({ repository }: { repository: string }) {
  const list = useWorkbenchCollection("policies", repository);
  const mutation = useWorkbenchMutation(list.refresh);
  return (
    <WorkbenchSection
      title="审查策略"
      description="默认策略阻止严重及高危发现；根据仓库实际需要调整。"
      actions={
        <button className="btn" onClick={list.refresh} disabled={list.loading}>
          刷新策略
        </button>
      }
    >
      <MutationNotice {...mutation} />
      <CreationForm title="创建策略">
        <PolicyForm
          busy={mutation.busy}
          submitLabel="创建策略"
          onSubmit={async (input) =>
            mutation.run(
              () => workbench.create("policies", repository, input),
              "策略已创建",
            )
          }
        />
      </CreationForm>
      <CollectionState
        {...list}
        count={list.items.length}
        empty="尚未创建审查策略"
        hint="创建策略后可设置阻止级别、置信度与人工确认要求。"
      >
        <PagedList
          items={list.items}
          label="策略"
          searchText={(item) => `${item.name} ${item.description} ${item.id}`}
          render={(policy) => (
            <PolicyCard
              key={policy.id}
              policy={policy}
              repository={repository}
              refresh={list.refresh}
            />
          )}
        />
      </CollectionState>
    </WorkbenchSection>
  );
}

function PolicyCard({
  policy,
  repository,
  refresh,
}: {
  policy: Policy;
  repository: string;
  refresh: () => void;
}) {
  const mutation = useWorkbenchMutation(refresh);
  const [selectedVersion, setSelectedVersion] = useState(policy.activeVersion);
  const selected =
    policy.versions.find((version) => version.version === selectedVersion) ??
    policy.versions[0];
  const active = policy.versions.find(
    (version) => version.version === policy.activeVersion,
  );
  return (
    <article className="wb-record">
      <div className="wb-record-head">
        <div>
          <h3>{policy.name}</h3>
          <p>{policy.description || "未填写说明"}</p>
        </div>
        <span className={`pill ${policy.enabled ? "pill-ok" : "pill-dim"}`}>
          {policy.enabled ? "已启用" : "已停用"}
        </span>
      </div>
      <DefinitionList
        values={[
          ["生效版本", `v${policy.activeVersion}`],
          ["保存的版本", policy.versions.length],
          ["更新时间", formatDate(policy.updatedAt)],
        ]}
      />
      {active ? (
        <div className="wb-rule-summary">
          <span>
            阻止{" "}
            {active.rules.blockedSeverities
              .map((severity) => SEVERITY_LABELS[severity])
              .join("、") || "无"}
          </span>
          <span>最多新增 {active.rules.maxNewFindings} 个</span>
          <span>
            最低置信度 {Math.round(active.rules.minConfidence * 100)}%
          </span>
          {active.rules.requireBaseline ? <span>要求基线</span> : null}
          {active.rules.requireHumanApproval ? <span>要求人工确认</span> : null}
        </div>
      ) : null}
      <div className="actions">
        <ConfirmAction
          label={policy.enabled ? "停用策略" : "启用策略"}
          message={`确认${policy.enabled ? "停用" : "启用"}「${policy.name}」？门禁结果会随之重新计算。`}
          disabled={mutation.busy}
          onConfirm={() =>
            void mutation.run(
              () =>
                workbench.action("policies", policy.id, "toggle", repository, {
                  enabled: !policy.enabled,
                }),
              "策略状态已更新",
            )
          }
        />
      </div>
      <MutationNotice {...mutation} />
      <details className="wb-subdetails">
        <summary>版本历史与回滚</summary>
        <label className="wb-inline-label">
          查看版本{" "}
          <select
            className="input"
            value={selectedVersion}
            onChange={(event) => setSelectedVersion(Number(event.target.value))}
          >
            {[...policy.versions].reverse().map((version) => (
              <option key={version.version} value={version.version}>
                v{version.version} · {version.name}
                {version.version === policy.activeVersion ? " · 当前生效" : ""}
              </option>
            ))}
          </select>
        </label>
        {selected ? (
          <>
            <DefinitionList
              values={[
                ["版本说明", selected.note || "未填写"],
                ["保存时间", formatDate(selected.savedAt)],
                ["保存人", selected.savedBy],
                ["包含路径", selected.rules.includePaths.join(", ") || "全部"],
                ["排除路径", selected.rules.excludePaths.join(", ") || "无"],
                ["标签", selected.rules.labels.join(", ") || "无"],
              ]}
            />
            <ConfirmAction
              label={`激活 v${selected.version}`}
              message={`将版本 v${selected.version} 设为生效版本，后续门禁将使用这些规则。`}
              disabled={
                mutation.busy || selected.version === policy.activeVersion
              }
              onConfirm={() =>
                void mutation.run(
                  () =>
                    workbench.action(
                      "policies",
                      policy.id,
                      "activate",
                      repository,
                      { version: selected.version },
                    ),
                  `已激活 v${selected.version}`,
                )
              }
            />
          </>
        ) : null}
      </details>
      <CreationForm title="保存新版本">
        <PolicyForm
          initial={
            active
              ? {
                  name: active.name,
                  description: active.description,
                  rules: active.rules,
                }
              : undefined
          }
          busy={mutation.busy}
          submitLabel="保存为新版本"
          onSubmit={async (input) =>
            mutation.run(
              () =>
                workbench.action(
                  "policies",
                  policy.id,
                  "version",
                  repository,
                  input,
                ),
              "新版本已保存，请在版本历史中显式激活",
            )
          }
        />
      </CreationForm>
    </article>
  );
}

type PolicyFormInput = {
  name: string;
  description: string;
  rules: PolicyRules;
  note: string;
};
function PolicyForm({
  initial,
  busy,
  submitLabel,
  onSubmit,
}: {
  initial?: { name: string; description: string; rules: PolicyRules };
  busy: boolean;
  submitLabel: string;
  onSubmit: (input: PolicyFormInput) => Promise<boolean>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [rules, setRules] = useState<PolicyRules>(
    initial?.rules ?? EMPTY_RULES,
  );
  const [maximum, setMaximum] = useState(String(rules.maxNewFindings));
  const [confidence, setConfidence] = useState(String(rules.minConfidence));
  const [include, setInclude] = useState(rules.includePaths.join("\n"));
  const [exclude, setExclude] = useState(rules.excludePaths.join("\n"));
  const [labels, setLabels] = useState(rules.labels.join(", "));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const toggleSeverity = (severity: Severity) =>
    setRules((previous) => ({
      ...previous,
      blockedSeverities: previous.blockedSeverities.includes(severity)
        ? previous.blockedSeverities.filter((item) => item !== severity)
        : [...previous.blockedSeverities, severity],
    }));
  return (
    <form
      className="wb-form"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        const submit = async () => {
          try {
            if (!name.trim()) throw new Error("请填写策略名称");
            const minConfidence = nonnegativeNumber(
              confidence,
              "最低置信度",
              false,
            );
            if (minConfidence > 1)
              throw new Error("最低置信度必须在 0 到 1 之间");
            const input = {
              name: name.trim(),
              description: description.trim(),
              note: note.trim(),
              rules: {
                ...rules,
                maxNewFindings: nonnegativeNumber(maximum, "最多新增发现"),
                minConfidence,
                includePaths: lineValues(include),
                excludePaths: lineValues(exclude),
                labels: lineValues(labels),
              },
            };
            if (await onSubmit(input)) {
              if (!initial) {
                setName("");
                setDescription("");
              }
              setNote("");
            }
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : "策略填写有误");
          }
        };
        void submit();
      }}
    >
      <Field label="策略名称" required>
        <input
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={160}
        />
      </Field>
      <Field label="说明">
        <input
          className="input"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={2000}
        />
      </Field>
      <fieldset className="wb-field wb-field-wide">
        <legend>阻止合入的发现级别</legend>
        <div className="wb-checkboxes">
          {SEVERITIES.map((severity) => (
            <label key={severity}>
              <input
                type="checkbox"
                checked={rules.blockedSeverities.includes(severity)}
                onChange={() => toggleSeverity(severity)}
              />
              {SEVERITY_LABELS[severity]}
            </label>
          ))}
        </div>
      </fieldset>
      <Field
        label="最多新增发现"
        required
        help="超过此数量时门禁失败；0 表示不允许新增。"
      >
        <input
          className="input"
          inputMode="numeric"
          type="number"
          min="0"
          step="1"
          value={maximum}
          onChange={(event) => setMaximum(event.target.value)}
          required
        />
      </Field>
      <Field
        label="最低置信度"
        required
        help="范围 0–1；低于该值的发现不会作为阻止依据。"
      >
        <input
          className="input"
          type="number"
          min="0"
          max="1"
          step="0.01"
          value={confidence}
          onChange={(event) => setConfidence(event.target.value)}
          required
        />
      </Field>
      <Field label="包含路径" help="每行一个路径模式；留空表示全部路径。">
        <textarea
          className="input wb-code"
          rows={3}
          value={include}
          onChange={(event) => setInclude(event.target.value)}
          placeholder="src/**"
        />
      </Field>
      <Field label="排除路径" help="每行一个路径模式，例如文档或生成文件。">
        <textarea
          className="input wb-code"
          rows={3}
          value={exclude}
          onChange={(event) => setExclude(event.target.value)}
          placeholder="docs/**"
        />
      </Field>
      <Field label="附加标签">
        <input
          className="input"
          value={labels}
          onChange={(event) => setLabels(event.target.value)}
          placeholder="逗号分隔"
        />
      </Field>
      <Field label="版本备注">
        <input
          className="input"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={2000}
        />
      </Field>
      <div className="wb-checkboxes wb-field-wide">
        <label>
          <input
            type="checkbox"
            checked={rules.requireBaseline}
            onChange={(event) =>
              setRules({ ...rules, requireBaseline: event.target.checked })
            }
          />
          要求已有生效基线
        </label>
        <label>
          <input
            type="checkbox"
            checked={rules.requireHumanApproval}
            onChange={(event) =>
              setRules({ ...rules, requireHumanApproval: event.target.checked })
            }
          />
          要求人工确认
        </label>
      </div>
      {error ? (
        <div className="wb-notice wb-notice-error wb-field-wide" role="alert">
          {error}
        </div>
      ) : null}
      <div className="wb-form-footer">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "保存中…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
