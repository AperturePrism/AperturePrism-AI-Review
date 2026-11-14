/**
 * 自动化规则：可解释条件、固定动作计划、速率和执行预算由一个记录持有。
 * 调用：parseRule(input, repository, actor, now, supportedActions)。
 */
import { randomUUID } from "node:crypto";
import {
  evaluateCondition,
  evaluateWindow,
  parseCondition,
  parseWindow,
} from "./condition.js";
import type {
  ActionPlan,
  AutomationRule,
  ConditionExplanation,
  ObjectValue,
  ReviewEvent,
} from "./types.js";
import {
  AutomationError,
  bool,
  integer,
  jsonObject,
  object,
  text,
} from "./utils/input.js";

/** 创建或更新规则时完整校验，不将未知动作留到生产事件执行时才报错。 */
export function parseRule(
  input: Record<string, unknown>,
  repository: string,
  actor: string,
  now: string,
  supported: ReadonlySet<string>,
  previous?: AutomationRule,
): AutomationRule {
  if (
    !Array.isArray(input.actions) ||
    input.actions.length < 1 ||
    input.actions.length > 20
  )
    throw new AutomationError(
      "invalid_rule",
      "rules require between 1 and 20 actions",
    );
  const actions: ActionPlan[] = input.actions.map((value) => {
    const action = object(value, "action");
    const kind = text(action.kind, "action.kind", 80);
    if (!supported.has(kind))
      throw new AutomationError(
        "unsupported_action",
        `action ${kind} is not installed`,
      );
    return {
      kind,
      input:
        action.input === undefined
          ? {}
          : jsonObject(action.input, "action.input"),
      costUnits: integer(action.costUnits, "action.costUnits", 1, 1000, 1),
      maxAttempts: integer(action.maxAttempts, "action.maxAttempts", 1, 10, 3),
    };
  });
  const rate = input.rate === undefined ? {} : object(input.rate, "rate");
  const budget =
    input.budget === undefined ? {} : object(input.budget, "budget");
  const rule: AutomationRule = {
    id: previous?.id ?? randomUUID(),
    repository,
    name: text(input.name, "name"),
    description:
      input.description === undefined || input.description === ""
        ? ""
        : text(input.description, "description", 2000),
    enabled: bool(input.enabled, "enabled", true),
    version: previous ? previous.version + 1 : 1,
    condition: parseCondition(input.condition),
    actions,
    window: parseWindow(input.window),
    rate: {
      limit: integer(rate.limit, "rate.limit", 1, 10000, 100),
      windowSeconds: integer(
        rate.windowSeconds,
        "rate.windowSeconds",
        1,
        86400,
        3600,
      ),
    },
    budget: {
      maxActions: integer(budget.maxActions, "budget.maxActions", 1, 20, 20),
      maxCostUnits: integer(
        budget.maxCostUnits,
        "budget.maxCostUnits",
        1,
        100000,
        1000,
      ),
      maxDurationMs: integer(
        budget.maxDurationMs,
        "budget.maxDurationMs",
        10,
        300000,
        30000,
      ),
    },
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    createdBy: previous?.createdBy ?? actor,
  };
  if (
    actions.length > rule.budget.maxActions ||
    actions.reduce((sum, action) => sum + action.costUnits, 0) >
      rule.budget.maxCostUnits
  )
    throw new AutomationError(
      "rule_budget_exceeded",
      "planned actions exceed the rule execution budget",
    );
  return rule;
}

/** 试跑使用和真正派发完全相同的条件与时间窗口。 */
export function explainRule(
  rule: AutomationRule,
  event: ReviewEvent,
  now: Date,
): ConditionExplanation {
  const condition = evaluateCondition(rule.condition, event);
  const window = evaluateWindow(rule.window, now);
  const enabled = {
    passed: rule.enabled,
    description: rule.enabled ? "rule is enabled" : "rule is disabled",
  };
  return {
    passed: enabled.passed && condition.passed && window.passed,
    description: `rule ${rule.name}`,
    children: [enabled, condition, window],
  };
}

/** 动作参数只支持完整的 {$event:'path'} 引用，不执行插值表达式或拼接代码。 */
export function resolveActionInput(
  input: ObjectValue,
  event: ReviewEvent,
): ObjectValue {
  const read = (field: string): unknown => {
    const parts = field.split(".");
    if (
      parts.length > 8 ||
      parts.some(
        (part) =>
          !/^[a-zA-Z0-9_-]+$/.test(part) ||
          ["__proto__", "prototype", "constructor"].includes(part),
      )
    )
      throw new AutomationError("invalid_reference", "invalid event reference");
    let value: unknown = event;
    for (const part of parts) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, part))
        throw new AutomationError(
          "missing_reference",
          `event field ${field} is missing`,
        );
      value = (value as Record<string, unknown>)[part];
    }
    return value;
  };
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (Object.keys(record).length === 1 && typeof record.$event === "string")
        return read(record.$event);
      return Object.fromEntries(
        Object.entries(record).map(([key, child]) => [key, visit(child)]),
      );
    }
    return value;
  };
  return jsonObject(visit(input));
}
