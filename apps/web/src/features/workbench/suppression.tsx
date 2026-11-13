/** 抑制规则始终有原因和作用范围；到期状态从服务器时间戳直接计算并清楚显示。 */
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
  workbench,
  type Severity,
  type Suppression,
} from "../../lib/workbench";
import type { WorkbenchTab } from "../../lib/workbench-tabs";

export const tab: WorkbenchTab = {
  id: "suppressions",
  label: "抑制与到期",
  description: "为已知问题设置有理由、有限定范围和到期时间的抑制规则。",
  order: 40,
  render: ({ repository }) => <Suppressions repository={repository} />,
};
export function Suppressions({ repository }: { repository: string }) {
  const list = useWorkbenchCollection("suppressions", repository);
  const mutation = useWorkbenchMutation(list.refresh);
  const [filter, setFilter] = useState("all");
  const now = Date.now();
  const items = list.items.filter(
    (item) =>
      filter === "all" ||
      (filter === "enabled"
        ? item.enabled && (!item.expiresAt || Date.parse(item.expiresAt) > now)
        : filter === "expired"
          ? !!item.expiresAt && Date.parse(item.expiresAt) <= now
          : !item.enabled),
  );
  return (
    <WorkbenchSection
      title="发现抑制规则"
      description="抑制只影响质量门禁与报告，不删除原发现及处置历史。"
      actions={
        <button className="btn" disabled={list.loading} onClick={list.refresh}>
          刷新抑制
        </button>
      }
    >
      <MutationNotice {...mutation} />
      <CreationForm title="添加抑制规则">
        <SuppressionForm
          busy={mutation.busy}
          onSubmit={(input) =>
            mutation.run(
              () => workbench.create("suppressions", repository, input),
              "抑制规则已创建",
            )
          }
        />
      </CreationForm>
      <label className="wb-inline-label">
        显示{" "}
        <select
          className="input"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        >
          <option value="all">全部规则</option>
          <option value="enabled">正在生效</option>
          <option value="expired">已经到期</option>
          <option value="disabled">已经停用</option>
        </select>
      </label>
      <CollectionState
        {...list}
        count={items.length}
        empty={list.items.length ? "没有匹配的抑制规则" : "尚未设置抑制规则"}
        hint="确认问题可暂时接受后，为它填写原因、匹配条件和到期日。"
      >
        <PagedList
          items={items}
          label="抑制规则"
          searchText={(item) =>
            `${item.name} ${item.reason} ${item.ruleId} ${item.pathPattern} ${item.fingerprint}`
          }
          render={(item) => (
            <SuppressionCard
              key={item.id}
              suppression={item}
              repository={repository}
              refresh={list.refresh}
            />
          )}
        />
      </CollectionState>
    </WorkbenchSection>
  );
}
function SuppressionCard({
  suppression,
  repository,
  refresh,
}: {
  suppression: Suppression;
  repository: string;
  refresh: () => void;
}) {
  const mutation = useWorkbenchMutation(refresh);
  const expired =
    suppression.expiresAt !== null &&
    Date.parse(suppression.expiresAt) <= Date.now();
  return (
    <article className="wb-record">
      <div className="wb-record-head">
        <div>
          <h3>{suppression.name}</h3>
          <p>{suppression.reason}</p>
        </div>
        <span
          className={`pill ${expired ? "pill-warn" : suppression.enabled ? "pill-ok" : "pill-dim"}`}
        >
          {expired ? "已到期" : suppression.enabled ? "已启用" : "已停用"}
        </span>
      </div>
      <DefinitionList
        values={[
          ["规则标识", suppression.ruleId || "不限定"],
          ["路径模式", <code>{suppression.pathPattern || "不限定"}</code>],
          ["指纹", <code>{suppression.fingerprint || "不限定"}</code>],
          [
            "级别范围",
            suppression.severities.length
              ? suppression.severities
                  .map((severity) => SEVERITY_LABELS[severity])
                  .join("、")
              : "不限定",
          ],
          [
            "到期时间",
            suppression.expiresAt
              ? formatDate(suppression.expiresAt)
              : "长期有效",
          ],
          ["创建时间", formatDate(suppression.createdAt)],
        ]}
      />
      {expired ? (
        <p className="wb-notice wb-notice-warning">
          此规则已经到期，匹配发现会重新参与质量门禁。需要延长时请创建一条新规则并说明原因。
        </p>
      ) : null}
      <ConfirmAction
        label={suppression.enabled ? "停用规则" : "启用规则"}
        message={`确认${suppression.enabled ? "停用" : "启用"}「${suppression.name}」？抑制结果会立即影响门禁。`}
        disabled={mutation.busy || (!suppression.enabled && expired)}
        onConfirm={() =>
          void mutation.run(
            () =>
              workbench.action(
                "suppressions",
                suppression.id,
                "toggle",
                repository,
                { enabled: !suppression.enabled },
              ),
            "抑制状态已保存",
          )
        }
      />
      <MutationNotice {...mutation} />
    </article>
  );
}
function SuppressionForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (input: Record<string, unknown>) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [ruleId, setRuleId] = useState("");
  const [pathPattern, setPathPattern] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [expires, setExpires] = useState("");
  const [severities, setSeverities] = useState<Severity[]>([]);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="wb-form"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        const submit = async () => {
          try {
            if (!name.trim() || !reason.trim())
              throw new Error("名称和抑制原因均为必填");
            if (!ruleId.trim() && !pathPattern.trim() && !fingerprint.trim())
              throw new Error("至少填写规则标识、路径模式或发现指纹中的一项");
            const date = expires ? new Date(expires) : null;
            if (
              date &&
              (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now())
            )
              throw new Error("到期时间必须晚于现在");
            const saved = await onSubmit({
              name: name.trim(),
              reason: reason.trim(),
              ruleId: ruleId.trim(),
              pathPattern: pathPattern.trim(),
              fingerprint: fingerprint.trim(),
              severities,
              expiresAt: date?.toISOString() ?? null,
            });
            if (saved) {
              setName("");
              setReason("");
            }
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : "抑制填写有误");
          }
        };
        void submit();
      }}
    >
      <Field label="规则名称" required>
        <input
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={160}
        />
      </Field>
      <Field label="规则标识">
        <input
          className="input wb-code"
          value={ruleId}
          onChange={(event) => setRuleId(event.target.value)}
          maxLength={200}
        />
      </Field>
      <Field
        label="路径模式"
        help="例如 src/generated/**；与其他条件共同匹配。"
      >
        <input
          className="input wb-code"
          value={pathPattern}
          onChange={(event) => setPathPattern(event.target.value)}
          maxLength={1000}
        />
      </Field>
      <Field label="发现指纹" help="只抑制一个发现时填写其稳定指纹。">
        <input
          className="input wb-code"
          value={fingerprint}
          onChange={(event) => setFingerprint(event.target.value)}
          maxLength={300}
        />
      </Field>
      <Field
        label="到期时间"
        help="使用本地时间选择，保存时转换为 UTC；留空长期有效。"
      >
        <input
          className="input"
          type="datetime-local"
          value={expires}
          onChange={(event) => setExpires(event.target.value)}
        />
      </Field>
      <fieldset className="wb-field">
        <legend>限定级别（不选表示全部）</legend>
        <div className="wb-checkboxes">
          {SEVERITIES.map((severity) => (
            <label key={severity}>
              <input
                type="checkbox"
                checked={severities.includes(severity)}
                onChange={() =>
                  setSeverities((values) =>
                    values.includes(severity)
                      ? values.filter((value) => value !== severity)
                      : [...values, severity],
                  )
                }
              />
              {SEVERITY_LABELS[severity]}
            </label>
          ))}
        </div>
      </fieldset>
      <Field label="抑制原因" required wide>
        <textarea
          className="input"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          required
          rows={3}
          maxLength={2000}
        />
      </Field>
      {error ? (
        <div className="wb-notice wb-notice-error wb-field-wide" role="alert">
          {error}
        </div>
      ) : null}
      <div className="wb-form-footer">
        <button className="btn btn-primary" disabled={busy} type="submit">
          {busy ? "保存中…" : "创建抑制规则"}
        </button>
      </div>
    </form>
  );
}
