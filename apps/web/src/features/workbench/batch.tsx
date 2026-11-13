/** 批次计划显示每项的真实执行状态；按钮只提供当前状态允许的操作。 */
import { useMemo, useState } from "react";
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
  nonnegativeNumber,
  parseJsonArray,
  workbench,
  type Batch,
  type BatchItem,
  type BatchStatus,
} from "../../lib/workbench";
import type { WorkbenchTab } from "../../lib/workbench-tabs";
export const tab: WorkbenchTab = {
  id: "batches",
  label: "批量审查",
  description: "规划并发、依赖和重试，逐项跟踪批次执行结果。",
  order: 50,
  render: ({ repository }) => <Batches repository={repository} />,
};
const BATCH_LABELS: Record<BatchStatus, string> = {
  draft: "草稿",
  queued: "排队中",
  running: "执行中",
  paused: "已暂停",
  completed: "已完成",
  canceled: "已取消",
};
const ITEM_LABELS: Record<BatchItem["status"], string> = {
  pending: "等待",
  running: "执行中",
  completed: "完成",
  failed: "失败",
  canceled: "取消",
};

export function Batches({ repository }: { repository: string }) {
  const list = useWorkbenchCollection("batches", repository);
  const mutation = useWorkbenchMutation(list.refresh);
  const [status, setStatus] = useState<BatchStatus | "all">("all");
  const items = list.items.filter(
    (batch) => status === "all" || batch.status === status,
  );
  return (
    <WorkbenchSection
      title="审查批次"
      actions={
        <button className="btn" onClick={list.refresh} disabled={list.loading}>
          刷新批次
        </button>
      }
    >
      <p className="wb-help">
        启动后系统自动派发到真实审查队列，完成数量由审查任务状态回流；暂停会停止后续领取。
      </p>
      <MutationNotice {...mutation} />
      <CreationForm title="创建审查批次">
        <BatchForm
          busy={mutation.busy}
          onSubmit={(input) =>
            mutation.run(
              () => workbench.create("batches", repository, input),
              "批次草稿已创建，可检查后启动",
            )
          }
        />
      </CreationForm>
      <label className="wb-inline-label">
        状态{" "}
        <select
          className="input"
          value={status}
          onChange={(event) =>
            setStatus(event.target.value as BatchStatus | "all")
          }
        >
          <option value="all">全部状态</option>
          {(Object.keys(BATCH_LABELS) as BatchStatus[]).map((value) => (
            <option key={value} value={value}>
              {BATCH_LABELS[value]}
            </option>
          ))}
        </select>
      </label>
      <CollectionState
        {...list}
        count={items.length}
        empty="没有匹配的批次"
        hint="创建一个批次，为每项指定审查对象和版本。"
      >
        <PagedList
          items={items}
          label="批次"
          searchText={(item) => `${item.name} ${item.note} ${item.id}`}
          render={(batch) => (
            <BatchCard
              key={`${batch.id}:${batch.revision}`}
              batch={batch}
              repository={repository}
              refresh={list.refresh}
            />
          )}
        />
      </CollectionState>
    </WorkbenchSection>
  );
}
function BatchCard({
  batch,
  repository,
  refresh,
}: {
  batch: Batch;
  repository: string;
  refresh: () => void;
}) {
  const mutation = useWorkbenchMutation(refresh);
  const [itemStatus, setItemStatus] = useState("all");
  const [selectedFailures, setSelectedFailures] = useState<string[]>([]);
  const counts = useMemo(() => {
    const result = {
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      canceled: 0,
    };
    for (const item of batch.items) result[item.status] += 1;
    return result;
  }, [batch.items]);
  const shown = batch.items.filter(
    (item) => itemStatus === "all" || item.status === itemStatus,
  );
  const act = (action: string, input: Record<string, unknown> = {}) =>
    mutation.run(
      () => workbench.action("batches", batch.id, action, repository, input),
      "批次操作已保存",
    );
  return (
    <article className="wb-record">
      <div className="wb-record-head">
        <div>
          <h3>{batch.name}</h3>
          <p>{batch.note || "未填写说明"}</p>
        </div>
        <span
          className={`pill ${batch.status === "completed" ? "pill-ok" : batch.status === "running" ? "pill-info" : "pill-dim"}`}
        >
          {BATCH_LABELS[batch.status]}
        </span>
      </div>
      <ProgressMeter
        label="已完成"
        value={counts.completed}
        max={batch.items.length}
      />
      <div className="wb-gate-counts">
        {Object.entries(counts).map(([status, count]) => (
          <span key={status}>
            {ITEM_LABELS[status as BatchItem["status"]]}{" "}
            <strong>{count}</strong>
          </span>
        ))}
      </div>
      <DefinitionList
        values={[
          ["并发上限", batch.concurrency],
          ["创建时间", formatDate(batch.createdAt)],
          ["最近更新", formatDate(batch.updatedAt)],
        ]}
      />
      <div className="actions">
        {batch.status === "draft" ? (
          <ConfirmAction
            label="启动批次"
            message={`启动「${batch.name}」中的 ${batch.items.length} 项审查？`}
            disabled={mutation.busy}
            onConfirm={() => void act("start")}
          />
        ) : null}
        {batch.status === "queued" || batch.status === "running" ? (
          <button
            className="btn"
            disabled={mutation.busy}
            onClick={() => void act("pause")}
          >
            暂停领取
          </button>
        ) : null}
        {batch.status === "paused" ? (
          <button
            className="btn btn-primary"
            disabled={mutation.busy}
            onClick={() => void act("resume")}
          >
            恢复执行
          </button>
        ) : null}
        {!["completed", "canceled"].includes(batch.status) ? (
          <ConfirmAction
            label="取消批次"
            message="取消后未完成项目不再执行；已经完成的结果会保留。"
            dangerous
            disabled={mutation.busy}
            onConfirm={() => void act("cancel")}
          />
        ) : null}
        {counts.failed > 0 ? (
          <button
            className="btn"
            disabled={mutation.busy}
            onClick={() => void act("retry")}
          >
            重试全部失败项（{counts.failed}）
          </button>
        ) : null}
      </div>
      <MutationNotice {...mutation} />
      <details className="wb-subdetails">
        <summary>批次项目与执行结果</summary>
        <div className="wb-filters">
          <label>
            项目状态{" "}
            <select
              className="input"
              value={itemStatus}
              onChange={(event) => setItemStatus(event.target.value)}
            >
              <option value="all">全部</option>
              {Object.entries(ITEM_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {selectedFailures.length ? (
            <button
              className="btn"
              disabled={mutation.busy}
              onClick={() => void act("retry", { itemIds: selectedFailures })}
            >
              重试选中失败项（{selectedFailures.length}）
            </button>
          ) : null}
        </div>
        <PagedList
          items={shown}
          label="批次项目"
          pageSize={10}
          searchText={(item) =>
            `${item.subject} ${item.reference} ${item.worker} ${item.error}`
          }
          render={(item) => (
            <BatchItemCard
              key={item.id}
              item={item}
              selected={selectedFailures.includes(item.id)}
              onSelect={() =>
                setSelectedFailures((previous) =>
                  previous.includes(item.id)
                    ? previous.filter((id) => id !== item.id)
                    : [...previous, item.id],
                )
              }
            />
          )}
        />
      </details>
    </article>
  );
}
function BatchItemCard({
  item,
  selected,
  onSelect,
}: {
  item: BatchItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const taskId =
    typeof item.result?.taskId === "string" ? item.result.taskId : null;
  return (
    <article className="wb-mini-record">
      <div className="wb-record-head">
        <div className="wb-select-record">
          {item.status === "failed" ? (
            <input
              aria-label={`选择失败项目 ${item.subject}`}
              type="checkbox"
              checked={selected}
              onChange={onSelect}
            />
          ) : null}
          <strong>{item.subject}</strong>
          <code>{item.reference}</code>
        </div>
        <span className="pill pill-dim">{ITEM_LABELS[item.status]}</span>
      </div>
      <DefinitionList
        values={[
          ["尝试次数", `${item.attempts} / ${item.maxAttempts}`],
          ["执行端", item.worker || "尚未领取"],
          ["执行代次", item.generation ?? 0],
          [
            "真实任务",
            taskId ? (
              <a href={`#/tasks/${encodeURIComponent(taskId)}`}>
                查看任务 {taskId.slice(0, 12)}
              </a>
            ) : (
              "尚未派发"
            ),
          ],
          ["开始时间", formatDate(item.startedAt)],
          ["完成时间", formatDate(item.completedAt)],
          ["租约到期", formatDate(item.leaseUntil)],
          ["依赖", item.dependencies.join(", ") || "无"],
        ]}
      />
      {item.error ? (
        <p className="wb-notice wb-notice-error">{item.error}</p>
      ) : null}
      {item.result ? (
        <details>
          <summary>查看执行结果</summary>
          <pre className="wb-json">{JSON.stringify(item.result, null, 2)}</pre>
        </details>
      ) : null}
    </article>
  );
}
function BatchForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (input: Record<string, unknown>) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [concurrency, setConcurrency] = useState("2");
  const [mode, setMode] = useState<"lines" | "json">("lines");
  const [targets, setTargets] = useState("");
  const [json, setJson] = useState("[]");
  const [reference, setReference] = useState("current");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="wb-form"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        const submit = async () => {
          try {
            if (!name.trim()) throw new Error("请填写批次名称");
            const limit = nonnegativeNumber(concurrency, "并发上限");
            if (limit < 1 || limit > 100)
              throw new Error("并发上限必须在 1 到 100 之间");
            const items =
              mode === "json"
                ? parseJsonArray(json, "批次项目")
                : [
                    ...new Set(
                      targets
                        .split("\n")
                        .map((item) => item.trim())
                        .filter(Boolean),
                    ),
                  ].map((subject) => ({
                    subject,
                    reference: reference.trim(),
                    dependencies: [],
                  }));
            if (!items.length) throw new Error("批次至少需要一个审查对象");
            if (mode === "lines" && !reference.trim())
              throw new Error("请填写各项目共同使用的引用");
            if (
              await onSubmit({
                name: name.trim(),
                concurrency: limit,
                note: note.trim(),
                items,
              })
            ) {
              setName("");
              setTargets("");
            }
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : "批次填写有误");
          }
        };
        void submit();
      }}
    >
      <Field label="批次名称" required>
        <input
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={160}
        />
      </Field>
      <Field label="并发上限" required>
        <input
          className="input"
          value={concurrency}
          onChange={(event) => setConcurrency(event.target.value)}
          type="number"
          min={1}
          max={100}
          step={1}
          required
        />
      </Field>
      <Field label="输入方式">
        <select
          className="input"
          value={mode}
          onChange={(event) => setMode(event.target.value as "lines" | "json")}
        >
          <option value="lines">每行一个审查对象</option>
          <option value="json">JSON 项目与依赖</option>
        </select>
      </Field>
      <Field label="说明">
        <input
          className="input"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={2000}
        />
      </Field>
      {mode === "lines" ? (
        <>
          <Field
            label="审查对象"
            required
            wide
            help="例如 pr:12、issue:34 或同仓库 GitHub URL，每行一个；重复行自动合并。"
          >
            <textarea
              className="input wb-code"
              value={targets}
              onChange={(event) => setTargets(event.target.value)}
              rows={5}
              required
            />
          </Field>
          <Field
            label="共同引用"
            required
            help="填写 current、latest、head 或对象的精确修订；PR 可填写提交 SHA，Issue 可填写 ISO 更新时间。"
          >
            <input
              className="input wb-code"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              required
            />
          </Field>
        </>
      ) : (
        <Field
          label="项目 JSON"
          required
          wide
          help="每项包含 subject、reference，可指定 id 和 dependencies（依赖项目 ID）。"
        >
          <textarea
            className="input wb-code"
            value={json}
            onChange={(event) => setJson(event.target.value)}
            rows={8}
            required
            spellCheck={false}
          />
        </Field>
      )}
      {error ? (
        <div className="wb-notice wb-notice-error wb-field-wide" role="alert">
          {error}
        </div>
      ) : null}
      <div className="wb-form-footer">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "创建中…" : "创建批次草稿"}
        </button>
      </div>
    </form>
  );
}
