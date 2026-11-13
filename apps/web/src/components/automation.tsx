/** 自动化页的解释树与分页零件；每个业务主体的表单仍放在其主体文件。 */
import type { ReactNode } from "react";
import type { ConditionExplanation } from "../lib/automation";
export function ExplanationTree({
  explanation,
}: {
  explanation: ConditionExplanation;
}) {
  return (
    <div className="auto-explanation">
      <div>
        <span
          className={`pill ${explanation.passed ? "pill-ok" : "pill-warn"}`}
        >
          {explanation.passed ? "满足" : "不满足"}
        </span>
        <strong>{explanation.description}</strong>
      </div>
      {explanation.field ? (
        <p>
          <code>{explanation.field}</code>
          {Object.hasOwn(explanation, "actual")
            ? ` · 实际 ${JSON.stringify(explanation.actual)}`
            : " · 字段未出现"}
          {Object.hasOwn(explanation, "expected")
            ? ` · 期望 ${JSON.stringify(explanation.expected)}`
            : ""}
        </p>
      ) : null}
      {explanation.children?.length ? (
        <ul>
          {explanation.children.map((child, index) => (
            <li key={index}>
              <ExplanationTree explanation={child} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
export function AutomationPager(props: {
  total: number;
  offset: number;
  hasPrevious: boolean;
  hasNext: boolean;
  previous: () => void;
  next: () => void;
  loading: boolean;
}) {
  return (
    <div className="wb-pagination">
      <span>
        共 {props.total} 条 · 第 {Math.floor(props.offset / 50) + 1} 页
      </span>
      <button
        className="btn"
        disabled={props.loading || !props.hasPrevious}
        onClick={props.previous}
      >
        上一页记录
      </button>
      <button
        className="btn"
        disabled={props.loading || !props.hasNext}
        onClick={props.next}
      >
        下一页记录
      </button>
    </div>
  );
}
export function AutomationEmpty({ children }: { children: ReactNode }) {
  return <p className="wb-notice">{children}</p>;
}
