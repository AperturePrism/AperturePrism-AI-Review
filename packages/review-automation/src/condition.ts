/**
 * 声明式条件：固定操作符、有限路径和线性边界，不使用 eval、Function 或用户正则。
 * 调用：evaluateCondition(parseCondition({field:'gate',op:'eq',value:'fail'}), event)。
 */
import type {
  ActiveWindow,
  Condition,
  ConditionExplanation,
  Json,
  ReviewEvent,
} from "./types.js";
import {
  AutomationError,
  canonical,
  integer,
  jsonValue,
  object,
  text,
} from "./utils/input.js";

const FIELDS = new Set([
  "id",
  "type",
  "repository",
  "occurredAt",
  "gate",
  "risk",
  "subject.kind",
  "subject.number",
  "subject.labels",
  "findings.total",
  "findings.new",
  "findings.critical",
  "findings.high",
  "findings.medium",
  "findings.low",
  "findings.info",
]);
const OPERATORS = new Set([
  "eq",
  "neq",
  "in",
  "contains",
  "gt",
  "gte",
  "lt",
  "lte",
  "exists",
  "glob",
]);

/** 校验一个完整条件树，限制总节点和深度，避免嵌套输入拖垮试跑和事件派发。 */
export function parseCondition(value: unknown): Condition {
  let count = 0;
  const parse = (input: unknown, depth: number): Condition => {
    count += 1;
    if (count > 200 || depth > 12)
      throw new AutomationError(
        "condition_too_complex",
        "condition must have at most 200 nodes and 12 nesting levels",
      );
    const source = object(input, "condition");
    const groups = ["all", "any", "not"].filter((key) =>
      Object.hasOwn(source, key),
    );
    if (groups.length > 1 || (groups.length && Object.hasOwn(source, "field")))
      throw new AutomationError(
        "invalid_condition",
        "condition must contain one group or one field comparison",
      );
    if (groups[0] === "not") return { not: parse(source.not, depth + 1) };
    if (groups[0] === "all" || groups[0] === "any") {
      const name = groups[0];
      const children = source[name];
      if (!Array.isArray(children) || children.length > 100)
        throw new AutomationError(
          "invalid_condition",
          "all and any must contain at most 100 conditions",
        );
      return {
        [name]: children.map((child) => parse(child, depth + 1)),
      } as Condition;
    }
    const field = text(source.field, "condition.field", 160);
    const parts = field.split(".");
    const dataField =
      field.startsWith("data.") &&
      parts.length <= 8 &&
      parts.every(
        (part) =>
          /^[a-zA-Z0-9_-]+$/.test(part) &&
          !["__proto__", "prototype", "constructor"].includes(part),
      );
    if (!FIELDS.has(field) && !dataField)
      throw new AutomationError(
        "invalid_condition",
        `field ${field} is not an allowed event field`,
      );
    const op = text(source.op, "condition.op", 30);
    if (!OPERATORS.has(op))
      throw new AutomationError(
        "invalid_condition",
        `operator ${op} is not supported`,
      );
    if (op === "exists") {
      if (source.value !== undefined && typeof source.value !== "boolean")
        throw new AutomationError(
          "invalid_condition",
          "exists requires a boolean value",
        );
      return { field, op, value: source.value ?? true };
    }
    if (!Object.hasOwn(source, "value"))
      throw new AutomationError(
        "invalid_condition",
        "comparison value is required",
      );
    const expected = jsonValue(source.value, 8192);
    if (["gt", "gte", "lt", "lte"].includes(op) && typeof expected !== "number")
      throw new AutomationError(
        "invalid_condition",
        "numeric comparison requires a number",
      );
    if (op === "in" && (!Array.isArray(expected) || expected.length > 100))
      throw new AutomationError(
        "invalid_condition",
        "in requires a list with at most 100 values",
      );
    if (
      op === "glob" &&
      (typeof expected !== "string" || expected.length > 200)
    )
      throw new AutomationError(
        "invalid_condition",
        "glob requires a pattern of at most 200 characters",
      );
    return { field, op, value: expected } as Condition;
  };
  return parse(value, 0);
}

/** 只走自有属性，data.constructor 等原型路径既不能校验通过，也不会被读取。 */
export function eventField(
  event: ReviewEvent,
  field: string,
): Json | undefined {
  let current: unknown = event;
  for (const part of field.split(".")) {
    if (
      !current ||
      typeof current !== "object" ||
      !Object.hasOwn(current, part)
    )
      return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current as Json | undefined;
}

/**
 * 简单 glob 只有 * 和 ? 两种通配，使用有限动态规划；没有正则回溯。
 * 对外条件的 pattern 已限制 200 字符，被比较字段限制到 2000 字符。
 */
export function matchGlob(value: string, pattern: string): boolean {
  if (value.length > 2000 || pattern.length > 200) return false;
  let previous = Array.from(
    { length: value.length + 1 },
    (_, index) => index === 0,
  );
  for (const character of pattern) {
    const current: boolean[] = [character === "*" && previous[0] === true];
    for (let index = 1; index <= value.length; index += 1) {
      current[index] =
        character === "*"
          ? previous[index] === true || current[index - 1] === true
          : previous[index - 1] === true &&
            (character === "?" || character === value[index - 1]);
    }
    previous = current;
  }
  return previous[value.length] === true;
}

function equal(left: Json | undefined, right: Json): boolean {
  return left !== undefined && canonical(left) === canonical(right);
}

/** 完整计算每个子条件，为规则试跑提供失败原因，而不只返回一个真假值。 */
export function evaluateCondition(
  condition: Condition,
  event: ReviewEvent,
): ConditionExplanation {
  if ("all" in condition) {
    const children = condition.all.map((child) =>
      evaluateCondition(child, event),
    );
    return {
      passed: children.every((child) => child.passed),
      description: "all conditions must pass",
      children,
    };
  }
  if ("any" in condition) {
    const children = condition.any.map((child) =>
      evaluateCondition(child, event),
    );
    return {
      passed: children.some((child) => child.passed),
      description: "at least one condition must pass",
      children,
    };
  }
  if ("not" in condition) {
    const child = evaluateCondition(condition.not, event);
    return {
      passed: !child.passed,
      description: "condition must not pass",
      children: [child],
    };
  }
  const actual = eventField(event, condition.field);
  const expected = condition.value ?? null;
  let passed = false;
  switch (condition.op) {
    case "exists":
      passed = (actual !== undefined) === (expected === true);
      break;
    case "eq":
      passed = equal(actual, expected);
      break;
    case "neq":
      passed = actual !== undefined && !equal(actual, expected);
      break;
    case "in":
      passed = (expected as Json[]).some((entry) => equal(actual, entry));
      break;
    case "contains":
      passed = Array.isArray(actual)
        ? actual.some((entry) => equal(entry, expected))
        : typeof actual === "string" &&
          typeof expected === "string" &&
          actual.includes(expected);
      break;
    case "glob":
      passed =
        typeof actual === "string" && matchGlob(actual, expected as string);
      break;
    case "gt":
      passed = typeof actual === "number" && actual > (expected as number);
      break;
    case "gte":
      passed = typeof actual === "number" && actual >= (expected as number);
      break;
    case "lt":
      passed = typeof actual === "number" && actual < (expected as number);
      break;
    case "lte":
      passed = typeof actual === "number" && actual <= (expected as number);
      break;
  }
  return {
    passed,
    description: `${condition.field} ${condition.op}`,
    field: condition.field,
    ...(actual !== undefined ? { actual } : {}),
    expected,
  };
}

/** 时间窗口用显式 UTC 偏移；调度不会随容器的系统时区改变。 */
export function parseWindow(value: unknown): ActiveWindow | null {
  if (value === undefined || value === null) return null;
  const source = object(value, "window");
  if (
    !Array.isArray(source.days) ||
    !source.days.length ||
    source.days.length > 7
  )
    throw new AutomationError(
      "invalid_window",
      "window.days must contain weekdays 0 through 6",
    );
  const days = [
    ...new Set(source.days.map((day) => integer(day, "window.day", 0, 6))),
  ];
  const start = text(source.start, "window.start", 5);
  const end = text(source.end, "window.end", 5);
  if (
    ![start, end].every((time) =>
      /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(time),
    )
  )
    throw new AutomationError("invalid_window", "window times must use HH:MM");
  return {
    days,
    start,
    end,
    utcOffsetMinutes: integer(
      source.utcOffsetMinutes,
      "window.utcOffsetMinutes",
      -840,
      840,
      0,
    ),
  };
}

/** 跨午夜窗口在午夜后的部分仍归属开始的那一天，星期边界不会多触发一晚。 */
export function evaluateWindow(
  window: ActiveWindow | null,
  now: Date,
): ConditionExplanation {
  if (!window)
    return { passed: true, description: "no active-time restriction" };
  const local = new Date(now.getTime() + window.utcOffsetMinutes * 60_000);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const toMinutes = (time: string): number =>
    Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  const overnight = start > end;
  const day =
    overnight && minutes < end
      ? (local.getUTCDay() + 6) % 7
      : local.getUTCDay();
  const inside =
    start === end ||
    (overnight
      ? minutes >= start || minutes < end
      : minutes >= start && minutes < end);
  return {
    passed: window.days.includes(day) && inside,
    description: `active on selected weekdays from ${window.start} to ${window.end} UTC offset ${window.utcOffsetMinutes}`,
    actual: `${local.getUTCDay()} ${local.toISOString().slice(11, 16)}`,
    expected: window.days,
  };
}
