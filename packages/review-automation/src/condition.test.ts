import { describe, expect, it } from "vitest";
import {
  evaluateCondition,
  evaluateWindow,
  matchGlob,
  parseCondition,
  parseWindow,
} from "./condition.js";
import { reviewEvent } from "./utils/input.js";
const event = reviewEvent(
  {
    id: "review-1",
    type: "review.completed",
    repository: "owner/repo",
    occurredAt: "2026-11-13T10:00:00Z",
    subject: { kind: "pr", number: 4, labels: ["security", "backend"] },
    gate: "fail",
    risk: "high",
    findings: { total: 4, new: 2, high: 1 },
    data: { branch: "feature/auth", nested: { value: 3 } },
  },
  "owner/repo",
);

describe("safe declarative event conditions", () => {
  it("combines all, any and not while explaining every child", () => {
    const condition = parseCondition({
      all: [
        { field: "repository", op: "eq", value: "owner/repo" },
        {
          any: [
            { field: "gate", op: "eq", value: "fail" },
            { field: "risk", op: "eq", value: "critical" },
          ],
        },
        {
          not: {
            field: "subject.labels",
            op: "contains",
            value: "skip-review",
          },
        },
      ],
    });
    const result = evaluateCondition(condition, event);
    expect(result.passed).toBe(true);
    expect(result.children).toHaveLength(3);
    expect(
      result.children?.[1]?.children?.map((child) => child.passed),
    ).toEqual([true, false]);
  });
  it.each([
    ["eq", "high", true],
    ["neq", "low", true],
    ["in", ["high", "critical"], true],
    ["eq", "critical", false],
    ["in", ["low"], false],
  ])("compares risk with %s", (op, value, passed) => {
    expect(
      evaluateCondition(parseCondition({ field: "risk", op, value }), event)
        .passed,
    ).toBe(passed);
  });
  it.each([
    ["gt", 1, true],
    ["gte", 2, true],
    ["lt", 2, false],
    ["lte", 2, true],
  ])(
    "uses numeric comparison %s without type coercion",
    (op, value, passed) => {
      expect(
        evaluateCondition(
          parseCondition({ field: "findings.new", op, value }),
          event,
        ).passed,
      ).toBe(passed);
    },
  );
  it("does not coerce a string field into a number", () => {
    expect(
      evaluateCondition(
        parseCondition({ field: "risk", op: "gt", value: 0 }),
        event,
      ).passed,
    ).toBe(false);
  });
  it("matches label membership rather than a substring across labels", () => {
    expect(
      evaluateCondition(
        parseCondition({
          field: "subject.labels",
          op: "contains",
          value: "security",
        }),
        event,
      ).passed,
    ).toBe(true);
    expect(
      evaluateCondition(
        parseCondition({
          field: "subject.labels",
          op: "contains",
          value: "secure",
        }),
        event,
      ).passed,
    ).toBe(false);
  });
  it("can test missing fields explicitly", () => {
    expect(
      evaluateCondition(
        parseCondition({ field: "data.absent", op: "exists", value: false }),
        event,
      ).passed,
    ).toBe(true);
    expect(
      evaluateCondition(
        parseCondition({ field: "data.absent", op: "neq", value: "x" }),
        event,
      ).passed,
    ).toBe(false);
  });
  it("reads a bounded nested JSON field", () => {
    expect(
      evaluateCondition(
        parseCondition({ field: "data.nested.value", op: "eq", value: 3 }),
        event,
      ).passed,
    ).toBe(true);
  });
  it.each([
    "data.__proto__.secret",
    "data.constructor",
    "constructor",
    "subject.unknown",
    "data.foo()",
  ])("rejects unsafe or unknown field %s", (field) => {
    expect(() => parseCondition({ field, op: "exists" })).toThrow();
  });
  it.each(["eval", "regex", "exec", "function", "javascript"])(
    "does not install an executable operator %s",
    (op) => {
      expect(() =>
        parseCondition({ field: "type", op, value: "process.exit()" }),
      ).toThrow();
    },
  );
  it("bounds condition nesting before evaluation", () => {
    let condition: unknown = { field: "gate", op: "eq", value: "fail" };
    for (let depth = 0; depth < 14; depth += 1) condition = { not: condition };
    expect(() => parseCondition(condition)).toThrow("nesting");
  });
  it("rejects mixed boolean and field forms", () => {
    expect(() =>
      parseCondition({ all: [], field: "gate", op: "eq", value: "fail" }),
    ).toThrow();
  });
  it("compares structured values with stable object-key order", () => {
    expect(
      evaluateCondition(
        parseCondition({ field: "data.nested", op: "eq", value: { value: 3 } }),
        event,
      ).passed,
    ).toBe(true);
  });
});

describe("bounded glob matching", () => {
  it.each([
    ["owner/repo", "owner/*", true],
    ["auth", "a?th", true],
    ["auth", "a?", false],
    ["abc", "*a*b*c*", true],
    ["", "*", true],
    ["", "?", false],
    ["a.b", "a.b", true],
    ["axb", "a.b", false],
  ])(
    "matches %s against %s without regex semantics",
    (value, pattern, passed) => {
      expect(matchGlob(value, pattern)).toBe(passed);
    },
  );
  it("rejects work exceeding the field or pattern bounds", () => {
    expect(matchGlob("a".repeat(2001), "*")).toBe(false);
    expect(matchGlob("a", "*".repeat(201))).toBe(false);
  });
});

describe("explicit local-time windows", () => {
  it("supports UTC+8 independently of the machine timezone", () => {
    const window = parseWindow({
      days: [5],
      start: "09:00",
      end: "17:00",
      utcOffsetMinutes: 480,
    });
    expect(
      evaluateWindow(window, new Date("2026-11-13T08:59:00Z")).passed,
    ).toBe(true);
    expect(
      evaluateWindow(window, new Date("2026-11-13T09:00:00Z")).passed,
    ).toBe(false);
  });
  it("assigns an overnight tail to the weekday on which the window started", () => {
    const window = parseWindow({
      days: [5],
      start: "22:00",
      end: "02:00",
      utcOffsetMinutes: 0,
    });
    expect(
      evaluateWindow(window, new Date("2026-11-14T01:00:00Z")).passed,
    ).toBe(true);
    expect(
      evaluateWindow(window, new Date("2026-11-14T23:00:00Z")).passed,
    ).toBe(false);
  });
  it("treats equal endpoints as an all-day window on the selected weekday", () => {
    const window = parseWindow({ days: [5], start: "00:00", end: "00:00" });
    expect(
      evaluateWindow(window, new Date("2026-11-13T18:00:00Z")).passed,
    ).toBe(true);
  });
  it.each([
    { days: [], start: "09:00", end: "17:00" },
    { days: [7], start: "09:00", end: "17:00" },
    { days: [1], start: "25:00", end: "17:00" },
    { days: [1], start: "9:00", end: "17:00" },
  ])("rejects invalid scheduling input", (window) => {
    expect(() => parseWindow(window)).toThrow();
  });
});
