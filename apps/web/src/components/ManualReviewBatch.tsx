/** 选中多个真实 Issue/PR，持久创建批次后启动；失败恢复不重建批次。 */
import { useEffect, useState } from "react";
import type { RepoSubjectItem } from "../lib/api/repository";
import {
  createManualReviewBatch,
  startManualReviewBatch,
  MAX_MANUAL_REVIEW_BATCH_ITEMS,
  type ManualReviewType,
} from "../lib/api/review-batch";
import { explainUnknown } from "../lib/errors";
import type { Batch } from "../lib/workbench";

type Receipt = {
  repository: string;
  type: ManualReviewType;
  batch: Batch;
  error: string | null;
};
const STATUS: Record<Batch["status"], string> = {
  draft: "待启动",
  queued: "已排队",
  running: "执行中",
  paused: "已暂停",
  completed: "已完成",
  canceled: "已取消",
};

export function ManualReviewBatch({
  repository,
  type,
  subjects,
  loading,
  listError,
  disabled = false,
  onBusyChange,
}: {
  repository: string;
  type: ManualReviewType;
  subjects: RepoSubjectItem[];
  loading: boolean;
  listError: string | null;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [concurrency, setConcurrency] = useState("2");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const scope = `${repository}:${type}`;
  const [selectionScope, setSelectionScope] = useState(scope);
  const selected = selectionScope === scope ? selection : new Set<number>();
  const available = [
    ...new Map(
      subjects
        .filter((item) => Number.isSafeInteger(item.number) && item.number > 0)
        .map((item) => [item.number, item]),
    ).values(),
  ].slice(0, MAX_MANUAL_REVIEW_BATCH_ITEMS);

  useEffect(() => {
    setSelection(new Set());
    setSelectionScope(scope);
    setError(null);
  }, [scope]);

  const changeBusy = (value: boolean) => {
    setBusy(value);
    onBusyChange?.(value);
  };
  const setReceipt = (receipt: Receipt) =>
    setReceipts((current) => [
      receipt,
      ...current.filter((item) => item.batch.id !== receipt.batch.id),
    ]);
  const start = async (receipt: Receipt) => {
    try {
      const batch = await startManualReviewBatch(
        receipt.repository,
        receipt.batch.id,
      );
      setReceipt({ ...receipt, batch, error: null });
    } catch (reason) {
      setReceipt({ ...receipt, error: explainUnknown(reason) });
    }
  };
  const submit = async () => {
    if (!repository || !selected.size || busy || disabled) return;
    changeBusy(true);
    setError(null);
    try {
      const batch = await createManualReviewBatch({
        repository,
        type,
        numbers: [...selected],
        concurrency: Number(concurrency),
      });
      const receipt = { repository, type, batch, error: null };
      setReceipt(receipt); // 创建成功即保留永久 id，即使接下来的 start 失败。
      setSelection(new Set());
      await start(receipt);
    } catch (reason) {
      setError(
        `批次创建未完成：${explainUnknown(reason)}。请先查看批次列表确认，再决定是否重新创建。`,
      );
    } finally {
      changeBusy(false);
    }
  };

  return (
    <div
      style={{
        borderTop: "1px solid var(--border)",
        marginTop: 18,
        paddingTop: 16,
      }}
    >
      <h3 style={{ fontSize: 14, marginTop: 0 }}>多选批量审查</h3>
      <p className="faint" style={{ fontSize: 12 }}>
        勾选同一仓库的多个 {type === "issue" ? "Issue" : "PR"}
        ，保存为持久批次并启动。关闭页面后任务仍会执行，可在批量审查页查看真实进度。
      </p>
      {!repository ? (
        <p className="faint">请先选择仓库。</p>
      ) : loading ? (
        <p role="status">正在加载可选对象…</p>
      ) : listError ? (
        <p className="wb-notice wb-notice-error" role="alert">
          无法读取可选对象：{listError}
        </p>
      ) : !available.length ? (
        <p className="faint">
          当前列表没有可选的 {type === "issue" ? "Issue" : "PR"}
          ，仍可在上方输入单个编号。
        </p>
      ) : (
        <>
          <div className="actions" style={{ marginBottom: 10 }}>
            <button
              className="btn"
              type="button"
              disabled={busy || disabled}
              onClick={() => {
                setSelectionScope(scope);
                setSelection(new Set(available.map((item) => item.number)));
              }}
            >
              选择当前列表
            </button>
            <button
              className="btn"
              type="button"
              disabled={busy || disabled || !selected.size}
              onClick={() => setSelection(new Set())}
            >
              清空选择
            </button>
            <span className="faint">
              已选 {selected.size} / {MAX_MANUAL_REVIEW_BATCH_ITEMS}
            </span>
          </div>
          <div
            style={{
              display: "grid",
              gap: 8,
              maxHeight: 280,
              overflowY: "auto",
              padding: "4px 0",
            }}
            role="group"
            aria-label={`选择多个 ${type === "issue" ? "Issue" : "PR"}`}
          >
            {available.map((item) => (
              <label
                key={item.number}
                style={{
                  display: "flex",
                  alignItems: "start",
                  gap: 10,
                  fontSize: 13,
                  padding: "8px 10px",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(item.number)}
                  disabled={busy || disabled}
                  aria-label={`选择 ${type === "issue" ? "Issue" : "PR"} #${item.number}`}
                  onChange={(event) => {
                    setSelectionScope(scope);
                    const next = new Set(selected);
                    if (event.target.checked) next.add(item.number);
                    else next.delete(item.number);
                    setSelection(next);
                  }}
                />
                <span>
                  <strong>#{item.number}</strong> {item.title}
                </span>
              </label>
            ))}
          </div>
          <form
            className="actions"
            style={{ marginTop: 12 }}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label
              className="faint"
              style={{ display: "flex", alignItems: "center", gap: 8 }}
            >
              批次并发数
              <input
                className="input"
                type="number"
                min={1}
                max={100}
                step={1}
                value={concurrency}
                disabled={busy || disabled}
                onChange={(event) => setConcurrency(event.target.value)}
                style={{ width: 90 }}
                required
              />
            </label>
            <button
              className="btn btn-primary"
              type="submit"
              disabled={busy || disabled || !selected.size}
            >
              {busy ? "提交中…" : `审查选中的 ${selected.size} 项`}
            </button>
          </form>
        </>
      )}
      {error ? (
        <p role="alert" className="wb-notice wb-notice-error">
          {error}
        </p>
      ) : null}
      {repository ? (
        <p>
          <a
            href={`#/workbench/batches?repository=${encodeURIComponent(repository)}`}
          >
            查看本仓库批次列表
          </a>
        </p>
      ) : null}
      {receipts.map((receipt) => (
        <div
          key={receipt.batch.id}
          className="wb-notice"
          style={{ marginTop: 10 }}
        >
          <p role="status" style={{ marginTop: 0 }}>
            {receipt.repository} · {receipt.batch.items.length} 项
            {receipt.type === "issue" ? " Issue" : " PR"} ·{" "}
            {STATUS[receipt.batch.status]} · 批次 {receipt.batch.id}
          </p>
          {receipt.error ? (
            <p role="alert">
              批次已创建，启动未确认：{receipt.error}。重试只会启动这个批次。
            </p>
          ) : null}
          <div className="actions">
            {receipt.error ? (
              <button
                type="button"
                className="btn"
                disabled={busy || disabled}
                onClick={() => {
                  changeBusy(true);
                  void start(receipt).finally(() => changeBusy(false));
                }}
              >
                重试启动批次 {receipt.batch.id}
              </button>
            ) : null}
            <a
              href={`#/workbench/batches?repository=${encodeURIComponent(receipt.repository)}`}
            >
              查看实时进度
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}
