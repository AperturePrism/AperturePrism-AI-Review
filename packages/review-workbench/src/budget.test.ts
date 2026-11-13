import { describe, expect, it } from "vitest";
import type { Budget, Reservation } from "./types.js";
import { estimateCostMicros } from "./budget.js";
import { budgetLimits, budgetPeriod, makeHarness } from "./test-fixture.js";

describe("精确预算与预留", () => {
  it("以整数微美元向上取整，不丢小额费用", () => {
    expect(estimateCostMicros(1, 0, 1, 0)).toBe(1);
    expect(estimateCostMicros(1_000_000, 500_000, 200_000, 600_000)).toBe(
      500_000,
    );
    expect(() => estimateCostMicros(-1, 0, 1, 0)).toThrow();
    expect(() => estimateCostMicros(1.5, 0, 1, 0)).toThrow();
  });

  it("预留占用预算，结算只增加实际用量，释放返还预留", async () => {
    const { call } = await makeHarness();
    const budget = await call<Budget>("budgets.create", {
      name: "十一月",
      ...budgetPeriod,
      limits: budgetLimits,
    });
    const reservation = await call<Reservation>("budgets.reserve", {
      id: budget.id,
      key: "task-1",
      estimate: { amountMicros: 800_000, requests: 1 },
    });
    expect(await call("budgets.availability", { id: budget.id })).toMatchObject(
      {
        occupied: { amountMicros: 800_000 },
        remaining: { amountMicros: 200_000 },
      },
    );
    await call("budgets.settle", {
      reservationId: reservation.id,
      actual: { amountMicros: 500_000, requests: 1 },
    });
    expect(await call("budgets.availability", { id: budget.id })).toMatchObject(
      {
        budget: { usage: { amountMicros: 500_000 } },
        remaining: { amountMicros: 500_000 },
      },
    );
    const second = await call<Reservation>("budgets.reserve", {
      id: budget.id,
      key: "task-2",
      estimate: { amountMicros: 400_000 },
    });
    await call("budgets.release", { reservationId: second.id });
    expect(await call("budgets.availability", { id: budget.id })).toMatchObject(
      { remaining: { amountMicros: 500_000 } },
    );
  });

  it("并发预留不会超卖同一额度", async () => {
    const { call } = await makeHarness();
    const budget = await call<Budget>("budgets.create", {
      name: "限额",
      ...budgetPeriod,
      limits: budgetLimits,
    });
    const results = await Promise.allSettled([
      call("budgets.reserve", {
        id: budget.id,
        key: "one",
        estimate: { amountMicros: 700_000 },
      }),
      call("budgets.reserve", {
        id: budget.id,
        key: "two",
        estimate: { amountMicros: 700_000 },
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(await call("budgets.availability", { id: budget.id })).toMatchObject(
      { occupied: { amountMicros: 700_000 } },
    );
  });

  it("同一key和相同结算可重放，不重复计费", async () => {
    const { call } = await makeHarness();
    const budget = await call<Budget>("budgets.create", {
      name: "幂等",
      ...budgetPeriod,
      limits: budgetLimits,
    });
    const first = await call<Reservation>("budgets.reserve", {
      id: budget.id,
      key: "task",
      estimate: { amountMicros: 10 },
    });
    const second = await call<Reservation>("budgets.reserve", {
      id: budget.id,
      key: "task",
      estimate: { amountMicros: 10 },
    });
    expect(second.id).toBe(first.id);
    await expect(
      call("budgets.reserve", {
        id: budget.id,
        key: "task",
        estimate: { amountMicros: 11 },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await call("budgets.settle", {
      reservationId: first.id,
      actual: { amountMicros: 7 },
    });
    await call("budgets.settle", {
      reservationId: first.id,
      actual: { amountMicros: 7 },
    });
    expect(await call("budgets.get", { id: budget.id })).toMatchObject({
      usage: { amountMicros: 7 },
    });
    await expect(
      call("budgets.settle", {
        reservationId: first.id,
        actual: { amountMicros: 8 },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("过期预留不占额度，但迟到结算必须被拒绝", async () => {
    const { call, setTime } = await makeHarness();
    const budget = await call<Budget>("budgets.create", {
      name: "期限",
      ...budgetPeriod,
      limits: budgetLimits,
    });
    const reservation = await call<Reservation>("budgets.reserve", {
      id: budget.id,
      key: "task",
      estimate: { amountMicros: 900_000 },
      expiresMs: 1000,
    });
    setTime("2026-11-13T00:00:02Z");
    expect(await call("budgets.availability", { id: budget.id })).toMatchObject(
      { remaining: { amountMicros: 1_000_000 } },
    );
    await expect(
      call("budgets.settle", {
        reservationId: reservation.id,
        actual: { amountMicros: 1 },
      }),
    ).rejects.toMatchObject({ code: "reservation_expired" });
    expect(await call("budgets.expire")).toEqual({ released: 1 });
    expect(await call("budgets.expire")).toEqual({ released: 0 });
  });

  it("停用阻止新预留，仍允许已有预留结算", async () => {
    const { call } = await makeHarness();
    const budget = await call<Budget>("budgets.create", {
      name: "停用",
      ...budgetPeriod,
      limits: budgetLimits,
    });
    const reservation = await call<Reservation>("budgets.reserve", {
      id: budget.id,
      key: "one",
      estimate: { amountMicros: 10 },
    });
    await call("budgets.toggle", { id: budget.id, enabled: false });
    await expect(
      call("budgets.reserve", {
        id: budget.id,
        key: "two",
        estimate: { amountMicros: 1 },
      }),
    ).rejects.toMatchObject({ code: "budget_disabled" });
    await call("budgets.settle", {
      reservationId: reservation.id,
      actual: { amountMicros: 8 },
    });
    expect(await call("budgets.get", { id: budget.id })).toMatchObject({
      usage: { amountMicros: 8 },
    });
  });

  it("token和次数限制与金额同样强制，零额度不是无限额", async () => {
    const { call } = await makeHarness();
    const budget = await call<Budget>("budgets.create", {
      name: "token",
      ...budgetPeriod,
      limits: {
        amountMicros: 100,
        inputTokens: 10,
        outputTokens: 0,
        requests: 1,
      },
    });
    await expect(
      call("budgets.reserve", {
        id: budget.id,
        key: "input",
        estimate: { inputTokens: 11 },
      }),
    ).rejects.toMatchObject({ code: "budget_exceeded" });
    await expect(
      call("budgets.reserve", {
        id: budget.id,
        key: "output",
        estimate: { outputTokens: 1 },
      }),
    ).rejects.toMatchObject({ code: "budget_exceeded" });
  });

  it("更新额度不能低于使用和预留总量", async () => {
    const { call } = await makeHarness();
    const budget = await call<Budget>("budgets.create", {
      name: "调整",
      ...budgetPeriod,
      limits: budgetLimits,
    });
    await call("budgets.reserve", {
      id: budget.id,
      key: "one",
      estimate: { amountMicros: 500_000 },
    });
    await expect(
      call("budgets.limits", {
        id: budget.id,
        limits: { ...budgetLimits, amountMicros: 100 },
      }),
    ).rejects.toMatchObject({ code: "budget_in_use" });
    expect(await call("budgets.get", { id: budget.id })).toMatchObject({
      limits: { amountMicros: 1_000_000 },
    });
  });

  it("无效日期、周期和小数预算在保存前拒绝", async () => {
    const { call } = await makeHarness();
    await expect(
      call("budgets.create", {
        name: "日期",
        periodStart: "2026-02-30T00:00:00Z",
        periodEnd: "2026-12-01T00:00:00Z",
        limits: budgetLimits,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      call("budgets.create", {
        name: "周期",
        periodStart: budgetPeriod.periodEnd,
        periodEnd: budgetPeriod.periodStart,
        limits: budgetLimits,
      }),
    ).rejects.toMatchObject({ code: "invalid_period" });
    await expect(
      call("budgets.create", {
        name: "小数",
        ...budgetPeriod,
        limits: { ...budgetLimits, amountMicros: 0.1 },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("跨预算汇总超过安全整数范围时明确拒绝，不返回失真的金额", async () => {
    const { call } = await makeHarness();
    const amountMicros = Math.floor(Number.MAX_SAFE_INTEGER / 4);
    for (let index = 0; index < 5; index += 1) {
      await call("budgets.create", {
        name: `极大预算-${index}`,
        ...budgetPeriod,
        limits: { amountMicros },
      });
    }
    await expect(call("summary")).rejects.toMatchObject({
      code: "summary_overflow",
    });
    expect(await call("budgets.list")).toMatchObject({ total: 5 });
  });
});
