/** 发现的完整处置主线：录入 → 指派 → 确认/修复/误报 → 查阅历史。 */
import { useMemo, useState } from "react";
import {
  CollectionState,
  CreationForm,
  DefinitionList,
  Field,
  MutationNotice,
  PagedList,
  SEVERITIES,
  SEVERITY_LABELS,
  SeverityBadge,
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
  type Finding,
  type FindingStatus,
  type Severity,
} from "../../lib/workbench";
import type { WorkbenchTab } from "../../lib/workbench-tabs";

export const tab: WorkbenchTab = {
  id: "findings",
  label: "发现与处置",
  description: "集中分配和跟踪审查发现，所有状态变化都保留操作者、原因和时间。",
  order: 30,
  render: ({ repository }) => <Findings repository={repository} />,
};
export const FINDING_STATUS_LABEL: Record<FindingStatus, string> = {
  open: "待确认",
  acknowledged: "已确认",
  fixed: "已修复",
  false_positive: "误报",
  accepted_risk: "接受风险",
};
const STATUSES = Object.keys(FINDING_STATUS_LABEL) as FindingStatus[];

export function Findings({ repository }: { repository: string }) {
  const list = useWorkbenchCollection("findings", repository);
  const mutation = useWorkbenchMutation(list.refresh);
  const [severity, setSeverity] = useState<Severity | "all">("all");
  const [status, setStatus] = useState<FindingStatus | "all">("all");
  const [assignee, setAssignee] = useState("");
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState<FindingStatus>("acknowledged");
  const [bulkReason, setBulkReason] = useState("");
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  const filtered = useMemo(
    () =>
      list.items.filter(
        (finding) =>
          (severity === "all" || finding.severity === severity) &&
          (status === "all" || finding.status === status) &&
          (!assignee.trim() ||
            finding.assignee
              .toLocaleLowerCase()
              .includes(assignee.trim().toLocaleLowerCase())),
      ),
    [list.items, severity, status, assignee],
  );
  return (
    <WorkbenchSection
      title="审查发现"
      actions={
        <button className="btn" onClick={list.refresh} disabled={list.loading}>
          刷新发现
        </button>
      }
    >
      <MutationNotice {...mutation} />
      <CreationForm title="手动录入发现">
        <FindingForm
          busy={mutation.busy}
          onSubmit={(input) =>
            mutation.run(
              () => workbench.create("findings", repository, input),
              "发现已录入",
            )
          }
        />
      </CreationForm>
      <div className="wb-filters">
        <label>
          级别{" "}
          <select
            className="input"
            value={severity}
            onChange={(event) => {
              setSeverity(event.target.value as Severity | "all");
              setSelection(new Set());
            }}
          >
            <option value="all">全部级别</option>
            {SEVERITIES.map((value) => (
              <option key={value} value={value}>
                {SEVERITY_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          状态{" "}
          <select
            className="input"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as FindingStatus | "all");
              setSelection(new Set());
            }}
          >
            <option value="all">全部状态</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {FINDING_STATUS_LABEL[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          指派给{" "}
          <input
            className="input"
            value={assignee}
            onChange={(event) => {
              setAssignee(event.target.value);
              setSelection(new Set());
            }}
            placeholder="用户名"
          />
        </label>
        <button
          className="btn"
          onClick={() => {
            setStatus("all");
            setSeverity("all");
            setAssignee("");
            setSelection(new Set());
          }}
        >
          清除筛选
        </button>
      </div>
      <details className="wb-subdetails">
        <summary>批量处置（已选 {selection.size} 个）</summary>
        <form
          className="wb-form"
          onSubmit={(event) => {
            event.preventDefault();
            void mutation.run(async () => {
              if (!selection.size) throw new Error("请先选择需要处置的发现");
              if (!bulkReason.trim()) throw new Error("批量处置需要说明原因");
              if (selection.size > 500)
                throw new Error("一次最多批量处置 500 个发现，请缩小筛选范围");
              const result = await workbench.transitionFindings(
                repository,
                [...selection],
                bulkStatus,
                bulkReason.trim(),
              );
              setBulkResult(
                `已在同一个事务中处置 ${result.items.length} 个发现`,
              );
              setSelection(new Set());
            }, "批量处置已结束，请查看逐项结果");
          }}
        >
          <Field label="批量设置状态">
            <select
              className="input"
              value={bulkStatus}
              onChange={(event) =>
                setBulkStatus(event.target.value as FindingStatus)
              }
            >
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {FINDING_STATUS_LABEL[value]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="处置原因" required>
            <input
              className="input"
              value={bulkReason}
              onChange={(event) => setBulkReason(event.target.value)}
              required
              maxLength={2000}
            />
          </Field>
          <div className="wb-form-footer">
            <button
              className="btn"
              type="button"
              onClick={() =>
                setSelection(new Set(filtered.map((finding) => finding.id)))
              }
            >
              选择筛选结果（{filtered.length}）
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => setSelection(new Set())}
            >
              清空选择
            </button>
            <button
              className="btn btn-primary"
              type="submit"
              disabled={mutation.busy || !selection.size}
            >
              处置选中的发现
            </button>
          </div>
        </form>
        {bulkResult ? (
          <p className="wb-notice" role="status">
            {bulkResult}
          </p>
        ) : null}
      </details>
      <CollectionState
        {...list}
        count={filtered.length}
        empty={list.items.length ? "没有符合筛选的发现" : "尚无审查发现"}
        hint="审查产生发现后在此跟踪，也可以手动录入经过确认的问题。"
      >
        <PagedList
          items={filtered}
          label="发现"
          searchText={(finding) =>
            `${finding.title} ${finding.description} ${finding.path} ${finding.ruleId} ${finding.fingerprint}`
          }
          render={(finding) => (
            <FindingCard
              key={`${finding.id}:${finding.revision}`}
              finding={finding}
              repository={repository}
              refresh={list.refresh}
              selected={selection.has(finding.id)}
              onSelect={() =>
                setSelection((previous) => {
                  const next = new Set(previous);
                  if (next.has(finding.id)) next.delete(finding.id);
                  else next.add(finding.id);
                  return next;
                })
              }
            />
          )}
        />
      </CollectionState>
    </WorkbenchSection>
  );
}

function FindingCard({
  finding,
  repository,
  refresh,
  selected,
  onSelect,
}: {
  finding: Finding;
  repository: string;
  refresh: () => void;
  selected: boolean;
  onSelect: () => void;
}) {
  const mutation = useWorkbenchMutation(refresh);
  const [nextStatus, setNextStatus] = useState(finding.status);
  const [reason, setReason] = useState("");
  const [assignee, setAssignee] = useState(finding.assignee);
  return (
    <article className={`wb-record${selected ? " wb-record-selected" : ""}`}>
      <div className="wb-record-head">
        <div>
          <label className="wb-select-record">
            <input
              type="checkbox"
              checked={selected}
              onChange={onSelect}
              aria-label={`选择发现 ${finding.title}`}
            />
            <h3>{finding.title}</h3>
          </label>
          <p>
            <code>
              {finding.path}:{finding.line}
              {finding.endLine !== finding.line ? `–${finding.endLine}` : ""}
            </code>{" "}
            · {finding.ruleId}
          </p>
        </div>
        <div className="actions">
          <SeverityBadge severity={finding.severity} />
          <span className="pill pill-dim">
            {FINDING_STATUS_LABEL[finding.status]}
          </span>
        </div>
      </div>
      <p className="wb-preserve-text">{finding.description}</p>
      <DefinitionList
        values={[
          ["置信度", `${Math.round(finding.confidence * 100)}%`],
          ["指派给", finding.assignee || "尚未分配"],
          ["出现次数", finding.occurrences],
          ["最近发现", formatDate(finding.lastSeenAt)],
          ["来源", finding.source || "未填写"],
          ["引用", finding.reference || "未填写"],
        ]}
      />
      {finding.tags.length ? (
        <div className="actions">
          {finding.tags.map((tag) => (
            <span key={tag} className="chip">
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      <details className="wb-subdetails">
        <summary>处置与指派</summary>
        <form
          className="wb-form"
          onSubmit={(event) => {
            event.preventDefault();
            void mutation.run(async () => {
              if (!reason.trim()) throw new Error("请填写本次处置或指派的原因");
              let expectedRevision = finding.revision;
              if (nextStatus !== finding.status) {
                const updated = await workbench.action<Finding>(
                  "findings",
                  finding.id,
                  "transition",
                  repository,
                  {
                    status: nextStatus,
                    reason: reason.trim(),
                    expectedRevision,
                  },
                );
                expectedRevision = updated.revision;
              }
              if (assignee.trim() !== finding.assignee)
                await workbench.action(
                  "findings",
                  finding.id,
                  "assign",
                  repository,
                  {
                    assignee: assignee.trim(),
                    reason: reason.trim(),
                    expectedRevision,
                  },
                );
              if (
                nextStatus === finding.status &&
                assignee.trim() === finding.assignee
              )
                throw new Error("状态和指派均未变化");
            }, "发现处置已保存");
          }}
        >
          <Field label="设置状态">
            <select
              className="input"
              value={nextStatus}
              onChange={(event) =>
                setNextStatus(event.target.value as FindingStatus)
              }
            >
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {FINDING_STATUS_LABEL[value]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="指派给" help="留空表示清除当前指派。">
            <input
              className="input"
              value={assignee}
              onChange={(event) => setAssignee(event.target.value)}
              maxLength={200}
            />
          </Field>
          <Field label="原因" required wide>
            <textarea
              className="input"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={2}
              required
              maxLength={2000}
            />
          </Field>
          <div className="wb-form-footer">
            <button
              className="btn btn-primary"
              type="submit"
              disabled={mutation.busy}
            >
              保存处置
            </button>
          </div>
        </form>
      </details>
      <MutationNotice {...mutation} />
      <details className="wb-subdetails">
        <summary>历史记录（{finding.history.length}）</summary>
        <ol className="wb-timeline">
          {[...finding.history].reverse().map((change, index) => (
            <li key={`${change.at}:${index}`}>
              <strong>
                {change.action} · {change.from || "无"} → {change.to}
              </strong>
              <p>{change.reason}</p>
              <small>
                {formatDate(change.at)} · {change.actor}
              </small>
            </li>
          ))}
        </ol>
        <p className="wb-help">
          稳定指纹：<code>{finding.fingerprint}</code>
        </p>
      </details>
    </article>
  );
}

function FindingForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (input: Record<string, unknown>) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [ruleId, setRuleId] = useState("");
  const [path, setPath] = useState("");
  const [line, setLine] = useState("1");
  const [endLine, setEndLine] = useState("");
  const [severity, setSeverity] = useState<Severity>("medium");
  const [confidence, setConfidence] = useState("0.9");
  const [reference, setReference] = useState("");
  const [tags, setTags] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="wb-form"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        const submit = async () => {
          try {
            const start = nonnegativeNumber(line, "起始行");
            const end = endLine.trim()
              ? nonnegativeNumber(endLine, "结束行")
              : start;
            const probability = nonnegativeNumber(confidence, "置信度", false);
            if (start < 1 || end < start)
              throw new Error("起始行至少为 1，结束行不能小于起始行");
            if (probability > 1) throw new Error("置信度必须在 0 到 1 之间");
            if (!title.trim() || !ruleId.trim() || !path.trim())
              throw new Error("标题、规则和文件路径均为必填");
            const saved = await onSubmit({
              title: title.trim(),
              description: description.trim(),
              ruleId: ruleId.trim(),
              path: path.trim(),
              line: start,
              endLine: end,
              severity,
              confidence: probability,
              reference: reference.trim(),
              source: "manual",
              tags: [
                ...new Set(
                  tags
                    .split(",")
                    .map((tag) => tag.trim())
                    .filter(Boolean),
                ),
              ],
            });
            if (saved) {
              setTitle("");
              setDescription("");
            }
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : "发现填写有误");
          }
        };
        void submit();
      }}
    >
      <Field label="发现标题" required wide>
        <input
          className="input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
          maxLength={300}
        />
      </Field>
      <Field label="规则标识" required>
        <input
          className="input wb-code"
          value={ruleId}
          onChange={(event) => setRuleId(event.target.value)}
          required
          maxLength={200}
        />
      </Field>
      <Field label="文件路径" required>
        <input
          className="input wb-code"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          required
          maxLength={1000}
          placeholder="src/example.ts"
        />
      </Field>
      <Field label="起始行" required>
        <input
          className="input"
          type="number"
          min={1}
          step={1}
          value={line}
          onChange={(event) => setLine(event.target.value)}
          required
        />
      </Field>
      <Field label="结束行" help="留空表示仅起始行。">
        <input
          className="input"
          type="number"
          min={1}
          step={1}
          value={endLine}
          onChange={(event) => setEndLine(event.target.value)}
        />
      </Field>
      <Field label="严重级别">
        <select
          className="input"
          value={severity}
          onChange={(event) => setSeverity(event.target.value as Severity)}
        >
          {SEVERITIES.map((value) => (
            <option key={value} value={value}>
              {SEVERITY_LABELS[value]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="置信度" required>
        <input
          className="input"
          type="number"
          min={0}
          max={1}
          step={0.01}
          value={confidence}
          onChange={(event) => setConfidence(event.target.value)}
          required
        />
      </Field>
      <Field label="引用">
        <input
          className="input wb-code"
          value={reference}
          onChange={(event) => setReference(event.target.value)}
          maxLength={300}
        />
      </Field>
      <Field label="标签" help="逗号分隔。">
        <input
          className="input"
          value={tags}
          onChange={(event) => setTags(event.target.value)}
        />
      </Field>
      <Field label="问题说明" wide required>
        <textarea
          className="input"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={4}
          required
          maxLength={10000}
        />
      </Field>
      {error ? (
        <div className="wb-notice wb-notice-error wb-field-wide" role="alert">
          {error}
        </div>
      ) : null}
      <div className="wb-form-footer">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "保存中…" : "录入发现"}
        </button>
      </div>
    </form>
  );
}
