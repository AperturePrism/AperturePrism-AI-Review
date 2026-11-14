/** 可视条件树和服务端解释树使用同一 Condition 契约；JSON 模式仍送服务端统一校验。 */
import { useId, useState } from "react";
import type { Condition, Json } from "../../lib/automation";
export const NEW_CONDITION: Condition = {
  field: "gate",
  op: "eq",
  value: "fail",
};
const FIELDS = [
  "type",
  "gate",
  "risk",
  "repository",
  "subject.kind",
  "subject.number",
  "subject.labels",
  "findings.total",
  "findings.new",
  "findings.critical",
  "findings.high",
];
const OPERATORS: {
  value: Extract<Condition, { field: string }>["op"];
  label: string;
}[] = [
  { value: "eq", label: "等于" },
  { value: "neq", label: "不等于" },
  { value: "in", label: "属于列表" },
  { value: "contains", label: "包含" },
  { value: "gt", label: "大于" },
  { value: "gte", label: "大于等于" },
  { value: "lt", label: "小于" },
  { value: "lte", label: "小于等于" },
  { value: "exists", label: "存在" },
  { value: "glob", label: "路径模式匹配" },
];
export function ConditionEditor({
  condition,
  onChange,
  disabled,
  depth = 0,
}: {
  condition: Condition;
  onChange: (condition: Condition) => void;
  disabled: boolean;
  depth?: number;
}) {
  const kind =
    "all" in condition
      ? "all"
      : "any" in condition
        ? "any"
        : "not" in condition
          ? "not"
          : "field";
  const children =
    "all" in condition
      ? condition.all
      : "any" in condition
        ? condition.any
        : "not" in condition
          ? [condition.not]
          : [];
  const updateChildren = (values: Condition[]) =>
    onChange(
      kind === "all"
        ? { all: values }
        : kind === "any"
          ? { any: values }
          : { not: values[0] ?? NEW_CONDITION },
    );
  return (
    <fieldset className="auto-condition" disabled={disabled}>
      <legend>条件{depth ? ` · 层级 ${depth + 1}` : "树"}</legend>
      <label className="wb-inline-label">
        匹配方式{" "}
        <select
          className="input"
          value={kind}
          onChange={(event) => {
            const next = event.target.value;
            onChange(
              next === "all"
                ? { all: children.length ? children : [condition] }
                : next === "any"
                  ? { any: children.length ? children : [condition] }
                  : next === "not"
                    ? { not: children[0] ?? condition }
                    : NEW_CONDITION,
            );
          }}
        >
          <option value="field">比较一个字段</option>
          <option value="all" disabled={depth >= 10}>
            全部满足
          </option>
          <option value="any" disabled={depth >= 10}>
            任一满足
          </option>
          <option value="not" disabled={depth >= 10}>
            不满足
          </option>
        </select>
      </label>
      {"field" in condition ? (
        <ConditionComparison
          key={`${condition.op}:${condition.value === null ? "null" : typeof condition.value}`}
          condition={condition}
          onChange={onChange}
          disabled={disabled}
        />
      ) : (
        <div className="auto-condition-children">
          {children.map((child, index) => (
            <div key={index}>
              <ConditionEditor
                condition={child}
                depth={depth + 1}
                disabled={disabled}
                onChange={(value) =>
                  updateChildren(
                    children.map((previous, childIndex) =>
                      childIndex === index ? value : previous,
                    ),
                  )
                }
              />
              {kind !== "not" ? (
                <button
                  className="btn btn-ghost"
                  type="button"
                  disabled={disabled || children.length <= 1}
                  onClick={() =>
                    updateChildren(
                      children.filter((_, childIndex) => childIndex !== index),
                    )
                  }
                >
                  移除此条件
                </button>
              ) : null}
            </div>
          ))}
          {kind !== "not" ? (
            <button
              className="btn"
              type="button"
              disabled={disabled || children.length >= 20}
              onClick={() => updateChildren([...children, NEW_CONDITION])}
            >
              添加条件
            </button>
          ) : null}
        </div>
      )}
    </fieldset>
  );
}
function ConditionComparison({
  condition,
  onChange,
  disabled,
}: {
  condition: Extract<Condition, { field: string }>;
  onChange: (condition: Condition) => void;
  disabled: boolean;
}) {
  const fieldsId = useId();
  const [json, setJson] = useState(JSON.stringify(condition.value ?? null));
  const [error, setError] = useState<string | null>(null);
  const numeric = ["gt", "gte", "lt", "lte"].includes(condition.op);
  const numericValue = numeric || typeof condition.value === "number";
  const complex =
    condition.op === "in" ||
    Array.isArray(condition.value) ||
    (condition.value !== null && typeof condition.value === "object");
  return (
    <div className="auto-comparison">
      <label>
        事件字段
        <input
          className="input wb-code"
          list={fieldsId}
          value={condition.field}
          onChange={(event) =>
            onChange({ ...condition, field: event.target.value })
          }
          disabled={disabled}
          required
        />
        <datalist id={fieldsId}>
          {FIELDS.map((field) => (
            <option key={field} value={field} />
          ))}
        </datalist>
      </label>
      <label>
        操作符
        <select
          className="input"
          value={condition.op}
          onChange={(event) => {
            const op = event.target.value as typeof condition.op;
            onChange({
              ...condition,
              op,
              value:
                op === "exists"
                  ? true
                  : op === "in"
                    ? []
                    : ["gt", "gte", "lt", "lte"].includes(op)
                      ? 0
                      : "",
            });
          }}
          disabled={disabled}
        >
          {OPERATORS.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      {["eq", "neq", "contains"].includes(condition.op) ? (
        <label>
          比较值类型
          <select
            className="input"
            value={
              condition.value === null
                ? "null"
                : complex
                  ? "json"
                  : typeof condition.value
            }
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...condition,
                value:
                  event.target.value === "number"
                    ? 0
                    : event.target.value === "boolean"
                      ? true
                      : event.target.value === "null"
                        ? null
                        : event.target.value === "json"
                          ? []
                          : "",
              })
            }
          >
            <option value="string">文本</option>
            <option value="number">数字</option>
            <option value="boolean">布尔值</option>
            <option value="null">null</option>
            <option value="json">JSON 数组或对象</option>
          </select>
        </label>
      ) : null}
      {condition.op === "exists" ? (
        <label>
          是否存在
          <select
            className="input"
            value={condition.value === false ? "false" : "true"}
            onChange={(event) =>
              onChange({ ...condition, value: event.target.value === "true" })
            }
            disabled={disabled}
          >
            <option value="true">字段必须存在</option>
            <option value="false">字段必须不存在</option>
          </select>
        </label>
      ) : typeof condition.value === "boolean" ? (
        <label>
          比较值
          <select
            className="input"
            value={String(condition.value)}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...condition, value: event.target.value === "true" })
            }
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </label>
      ) : condition.value === null ? (
        <span className="wb-help">比较值：null</span>
      ) : complex ? (
        <label>
          比较值 JSON
          <textarea
            className="input wb-code"
            value={json}
            onChange={(event) => {
              setJson(event.target.value);
              try {
                const value = JSON.parse(event.target.value) as Json;
                onChange({ ...condition, value });
                setError(null);
                event.currentTarget.setCustomValidity("");
              } catch {
                event.currentTarget.setCustomValidity("比较值需要合法 JSON");
                setError("比较值需要合法 JSON");
              }
            }}
            disabled={disabled}
            required
            rows={2}
            aria-invalid={!!error}
          />
          {error ? <small role="alert">{error}</small> : null}
        </label>
      ) : (
        <label>
          比较值
          <input
            className="input"
            type={numericValue ? "number" : "text"}
            value={String(condition.value ?? "")}
            onChange={(event) =>
              onChange({
                ...condition,
                value: numericValue
                  ? Number(event.target.value)
                  : event.target.value,
              })
            }
            disabled={disabled}
            required
          />
        </label>
      )}
    </div>
  );
}

/** 只检查可视编辑需要的树形状；字段白名单与操作符语义仍由服务端验证。 */
export function visualCondition(value: unknown): Condition {
  let nodes = 0;
  const parse = (input: unknown, depth: number): Condition => {
    nodes += 1;
    if (
      nodes > 200 ||
      depth > 12 ||
      !input ||
      typeof input !== "object" ||
      Array.isArray(input)
    )
      throw new Error("条件树必须是最多 200 个节点、12 层的对象结构");
    const object = input as Record<string, unknown>;
    const groups = ["all", "any", "not"].filter((key) =>
      Object.hasOwn(object, key),
    );
    if (
      groups.length > 1 ||
      (groups.length > 0 && Object.hasOwn(object, "field"))
    )
      throw new Error("条件不能同时包含分组和字段比较");
    if (Object.hasOwn(object, "all") || Object.hasOwn(object, "any")) {
      const key = Object.hasOwn(object, "all") ? "all" : "any";
      const children = object[key];
      if (!Array.isArray(children) || children.length > 100)
        throw new Error("all/any 必须是条件数组");
      return key === "all"
        ? { all: children.map((child) => parse(child, depth + 1)) }
        : { any: children.map((child) => parse(child, depth + 1)) };
    }
    if (Object.hasOwn(object, "not"))
      return { not: parse(object.not, depth + 1) };
    if (
      typeof object.field !== "string" ||
      !OPERATORS.some((operator) => operator.value === object.op)
    )
      throw new Error("比较条件需要 field 和受支持的 op");
    return object as Extract<Condition, { field: string }>;
  };
  return parse(value, 0);
}
