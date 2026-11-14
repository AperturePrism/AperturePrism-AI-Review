/** 工作台共用的表单与列表零件；主体表单仍放在自己的页面文件里。 */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Empty, ErrorPanel, LoadingRows } from "./ui";
import { type Severity } from "../lib/workbench";

export const SEVERITIES: Severity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
];
export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "严重",
  high: "高危",
  medium: "中危",
  low: "低危",
  info: "提示",
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={`pill wb-severity-${severity}`}>
      {SEVERITY_LABELS[severity]}
    </span>
  );
}

export function WorkbenchSection(props: {
  title: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="panel wb-section">
      <div className="panel-title">
        <div>
          <h2>{props.title}</h2>
          {props.description ? (
            <p className="wb-help">{props.description}</p>
          ) : null}
        </div>
        <div className="actions">{props.actions}</div>
      </div>
      {props.children}
    </section>
  );
}

export function Field(props: {
  label: string;
  children: ReactNode;
  help?: string;
  required?: boolean;
  wide?: boolean;
}) {
  return (
    <label className={`wb-field${props.wide ? " wb-field-wide" : ""}`}>
      <span>
        {props.label}
        {props.required ? <span aria-hidden="true"> *</span> : null}
      </span>
      {props.children}
      {props.help ? <small>{props.help}</small> : null}
    </label>
  );
}

export function MutationNotice(props: {
  error: string | null;
  message: string | null;
}) {
  return (
    <>
      {props.error ? (
        <div className="wb-notice wb-notice-error" role="alert">
          {props.error}
        </div>
      ) : null}
      {props.message ? (
        <div className="wb-notice wb-notice-success" role="status">
          {props.message}
        </div>
      ) : null}
    </>
  );
}

/** 原生 details 支持键盘；提交失败时保持展开，避免错误藏到折叠区域。 */
export function CreationForm(props: {
  title: string;
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details className="wb-create" open={props.open}>
      <summary>
        {props.title}
        <span aria-hidden="true">＋</span>
      </summary>
      <div className="wb-create-body">{props.children}</div>
    </details>
  );
}

export function CollectionState(props: {
  loading: boolean;
  error: string | null;
  count: number;
  refresh: () => void;
  empty: string;
  hint?: string;
  children: ReactNode;
  hasMore?: boolean;
  loadingMore?: boolean;
  pageError?: string | null;
  loadMore?: () => void;
  total?: number;
  items?: unknown[];
}) {
  if (props.error)
    return <ErrorPanel error={props.error} onRetry={props.refresh} />;
  if (props.loading)
    return (
      <div role="status" aria-label="正在加载工作台数据">
        <LoadingRows />
      </div>
    );
  return (
    <>
      {!props.count ? (
        <Empty title={props.empty} hint={props.hint} />
      ) : (
        props.children
      )}
      {props.pageError ? (
        <div className="wb-notice wb-notice-error" role="alert">
          {props.pageError}
        </div>
      ) : null}
      {props.hasMore ? (
        <div className="wb-pagination">
          <span>
            已加载 {props.items?.length ?? props.count} / {props.total} 条
          </span>
          <button
            className="btn"
            type="button"
            disabled={props.loadingMore}
            onClick={props.loadMore}
          >
            {props.loadingMore ? "加载中…" : "加载更多记录"}
          </button>
        </div>
      ) : null}
    </>
  );
}

/** 小型客户端分页一次只渲染一页；筛选变化重置页码并显示总数。 */
export function PagedList<T>(props: {
  items: T[];
  label: string;
  searchText: (item: T) => string;
  render: (item: T) => ReactNode;
  filters?: ReactNode;
  pageSize?: number;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const size = props.pageSize ?? 20;
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return props.items.filter((item) =>
      props.searchText(item).toLocaleLowerCase().includes(query),
    );
  }, [props.items, props.searchText, search]);
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const current = Math.min(page, pages - 1);
  const id = useId();
  useEffect(() => setPage(0), [search, props.items]);
  return (
    <>
      <div className="wb-list-toolbar">
        <label className="wb-search" htmlFor={id}>
          <span className="sr-only">搜索{props.label}</span>
          <input
            id={id}
            className="input"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={`搜索${props.label}`}
          />
        </label>
        {props.filters}
        <span className="muted" aria-live="polite">
          {filtered.length} / {props.items.length} 条
        </span>
      </div>
      {filtered.length ? (
        <div className="wb-records">
          {filtered
            .slice(current * size, (current + 1) * size)
            .map(props.render)}
        </div>
      ) : (
        <Empty title="没有匹配的记录" hint="调整筛选条件或搜索词" />
      )}
      <div className="wb-pagination" aria-label={`${props.label}分页`}>
        <button
          type="button"
          className="btn"
          disabled={current === 0}
          onClick={() => setPage(current - 1)}
        >
          上一页
        </button>
        <span>
          第 {current + 1} / {pages} 页
        </span>
        <button
          type="button"
          className="btn"
          disabled={current + 1 >= pages}
          onClick={() => setPage(current + 1)}
        >
          下一页
        </button>
      </div>
    </>
  );
}

/** 确认框仅用于影响既有记录的操作；焦点回到触发按钮，Escape 可以取消。 */
export function ConfirmAction(props: {
  label: string;
  message: string;
  disabled?: boolean;
  dangerous?: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    cancel.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`btn${props.dangerous ? " btn-danger" : ""}`}
        disabled={props.disabled}
        onClick={() => setOpen(true)}
      >
        {props.label}
      </button>
      {open ? (
        <div
          className="wb-confirm"
          role="alertdialog"
          aria-modal="false"
          aria-labelledby={id}
        >
          <p id={id}>{props.message}</p>
          <div className="actions">
            <button
              ref={cancel}
              type="button"
              className="btn"
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              返回
            </button>
            <button
              type="button"
              className={`btn${props.dangerous ? " btn-danger" : " btn-primary"}`}
              onClick={() => {
                setOpen(false);
                props.onConfirm();
                trigger.current?.focus();
              }}
            >
              确认{props.label}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function formatDate(value: string | null): string {
  if (!value) return "未设置";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

export function DefinitionList({ values }: { values: [string, ReactNode][] }) {
  return (
    <dl className="wb-definitions">
      {values.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ProgressMeter({
  value,
  max,
  label,
}: {
  value: number;
  max: number;
  label: string;
}) {
  const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="wb-meter">
      <div>
        <span>{label}</span>
        <strong>
          {value.toLocaleString()} / {max.toLocaleString()}
        </strong>
      </div>
      <progress max={100} value={percent} aria-label={label} />
    </div>
  );
}
