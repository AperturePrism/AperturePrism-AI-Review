/** 金额、并发预留与失败回滚的业务回归；不调用真实供应商。 */
import { describe, expect, it } from "vitest";
import {
  ModelBudget,
  estimateCostMicros,
  formatCostMicros,
  type ModelPrice,
} from "./budget.js";

const price: ModelPrice = {
  currency: "USD",
  inputMicrosPerMillion: 1_000_000,
  outputMicrosPerMillion: 2_000_000,
};

describe("model price arithmetic", () => {
  it("calculates in integer micros without accumulating decimal drift", () => {
    expect(estimateCostMicros({ inputTokens: 3, outputTokens: 4 }, price)).toBe(
      11,
    );
    expect(formatCostMicros(11)).toBe("0.000011");
    expect(formatCostMicros(2_100_001)).toBe("2.100001");
  });

  it("rounds after adding input and output fractions", () => {
    const tiny = {
      ...price,
      inputMicrosPerMillion: 1,
      outputMicrosPerMillion: 1,
    };
    expect(estimateCostMicros({ inputTokens: 1, outputTokens: 1 }, tiny)).toBe(
      1,
    );
    expect(estimateCostMicros({ inputTokens: 0, outputTokens: 0 }, tiny)).toBe(
      0,
    );
    expect(
      estimateCostMicros({ inputTokens: 500_000, outputTokens: 500_000 }, tiny),
    ).toBe(1);
  });

  it("uses bigint for products above the floating point safe range", () => {
    const high = { ...price, inputMicrosPerMillion: 3_000_001 };
    const amount = 4_000_000_001;
    const expected = Number(
      (BigInt(amount) * 3_000_001n + 999_999n) / 1_000_000n,
    );
    expect(
      estimateCostMicros({ inputTokens: amount, outputTokens: 0 }, high),
    ).toBe(expected);
  });

  it("rejects unsafe, negative and fractional billing inputs", () => {
    for (const bad of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        estimateCostMicros({ inputTokens: bad, outputTokens: 1 }, price),
      ).toThrow();
      expect(() =>
        estimateCostMicros(
          { inputTokens: 1, outputTokens: 1 },
          { ...price, outputMicrosPerMillion: bad },
        ),
      ).toThrow();
      expect(() => formatCostMicros(bad)).toThrow();
    }
    expect(() =>
      estimateCostMicros(
        { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 },
        { ...price, inputMicrosPerMillion: Number.MAX_SAFE_INTEGER },
      ),
    ).toThrow("safe integer");
    expect(() =>
      estimateCostMicros(
        { inputTokens: 1, outputTokens: 1 },
        { ...price, currency: "usd" },
      ),
    ).toThrow("currency");
  });
});

describe("model budget reservations", () => {
  it("counts pending calls before admitting the next concurrent request", () => {
    const budget = new ModelBudget({ maxCostMicros: 100 });
    const first = budget.reserve(
      "a",
      { inputTokens: 10, outputTokens: 20 },
      price,
    );
    expect(first.costMicros).toBe(50);
    budget.reserve("b", { inputTokens: 10, outputTokens: 20 }, price);
    expect(() =>
      budget.reserve("c", { inputTokens: 1, outputTokens: 0 }, price),
    ).toThrow("exhausted");
    expect(budget.snapshot().reserved.costMicros).toBe(100);
    expect(budget.snapshot().available.maxCostMicros).toBe(0);
  });

  it("settles actual usage and releases the unused estimate", () => {
    const budget = new ModelBudget({ maxCostMicros: 100 }, { now: () => 42 });
    const hold = budget.reserve(
      "a",
      { inputTokens: 10, outputTokens: 20 },
      price,
    );
    const receipt = budget.settle(hold.id, { inputTokens: 5, outputTokens: 2 });
    expect(receipt).toMatchObject({
      requestId: "a",
      currency: "USD",
      costMicros: 9,
      settledAt: 42,
    });
    expect(budget.snapshot()).toMatchObject({
      spent: { costMicros: 9, requests: 1 },
      reserved: { costMicros: 0, requests: 0 },
      reservations: 0,
    });
    expect(budget.snapshot().available.maxCostMicros).toBe(91);
  });

  it("records underestimated actual bills instead of silently discarding excess", () => {
    const budget = new ModelBudget({ maxCostMicros: 10 });
    const hold = budget.reserve(
      "a",
      { inputTokens: 1, outputTokens: 1 },
      price,
    );
    budget.settle(hold.id, { inputTokens: 20, outputTokens: 1 });
    expect(budget.snapshot().exceeded).toBe(true);
    expect(budget.snapshot().spent.costMicros).toBe(22);
    expect(() =>
      budget.reserve("b", { inputTokens: 1, outputTokens: 0 }, price),
    ).toThrow("exhausted");
  });

  it("does not double charge duplicate completion callbacks", () => {
    const budget = new ModelBudget();
    const hold = budget.reserve(
      "a",
      { inputTokens: 10, outputTokens: 20 },
      price,
    );
    const first = budget.settle(hold.id, { inputTokens: 2, outputTokens: 1 });
    expect(
      budget.settle(hold.id, { inputTokens: 999, outputTokens: 999 }),
    ).toEqual(first);
    expect(budget.snapshot().spent.requests).toBe(1);
    expect(budget.release(hold.id)).toBe(false);
  });

  it("releases failed sends exactly once without counting fake completed usage", () => {
    const budget = new ModelBudget();
    const hold = budget.reserve(
      "a",
      { inputTokens: 10, outputTokens: 20 },
      price,
    );
    expect(budget.release(hold.id)).toBe(true);
    expect(budget.release(hold.id)).toBe(false);
    expect(budget.snapshot().spent.requests).toBe(0);
    expect(budget.snapshot().reserved.requests).toBe(0);
    expect(() =>
      budget.settle(hold.id, { inputTokens: 0, outputTokens: 0 }),
    ).toThrow("does not exist");
  });

  it("checks input, output and request caps independently", () => {
    const usage = { inputTokens: 2, outputTokens: 3 };
    for (const limits of [
      { maxInputTokens: 1 },
      { maxOutputTokens: 2 },
      { maxRequests: 0 },
    ]) {
      const budget = new ModelBudget(limits);
      expect(() => budget.reserve("a", usage, price)).toThrow("exhausted");
      expect(budget.snapshot().reservations).toBe(0);
    }
  });

  it("prevents currency mixing and mutable external objects from changing bills", () => {
    const budget = new ModelBudget();
    const mutablePrice = { ...price };
    const usage = { inputTokens: 2, outputTokens: 3 };
    const hold = budget.reserve("a", usage, mutablePrice);
    mutablePrice.outputMicrosPerMillion = 999;
    usage.inputTokens = 500;
    hold.estimated.outputTokens = 9_999;
    hold.price.inputMicrosPerMillion = 1;
    expect(
      budget.settle(hold.id, { inputTokens: 2, outputTokens: 3 }).costMicros,
    ).toBe(8);
    expect(() =>
      budget.reserve(
        "b",
        { inputTokens: 1, outputTokens: 1 },
        { ...price, currency: "CNY" },
      ),
    ).toThrow("mix currencies");
  });

  it("requires pending work to finish before starting a new billing period", () => {
    const budget = new ModelBudget({ maxRequests: 1 });
    const hold = budget.reserve(
      "a",
      { inputTokens: 1, outputTokens: 1 },
      price,
    );
    expect(() => budget.reset()).toThrow("pending");
    budget.settle(hold.id, { inputTokens: 1, outputTokens: 1 });
    budget.reset();
    expect(budget.snapshot().spent.requests).toBe(0);
    expect(budget.snapshot().currency).toBeNull();
  });

  it("bounds receipt history and copies exported history", () => {
    const budget = new ModelBudget({}, { receiptLimit: 2 });
    for (const id of ["a", "b", "c"]) {
      const hold = budget.reserve(
        id,
        { inputTokens: 1, outputTokens: 0 },
        price,
      );
      budget.settle(hold.id, { inputTokens: 1, outputTokens: 0 });
    }
    expect(budget.history().map((item) => item.requestId)).toEqual(["b", "c"]);
    budget.history()[0]!.usage.inputTokens = 999;
    expect(budget.history()[0]!.usage.inputTokens).toBe(1);
    expect(budget.snapshot().spent.requests).toBe(3);
  });

  it("applies revised caps without clearing already spent or pending tokens", () => {
    const budget = new ModelBudget({ maxRequests: 10 });
    const hold = budget.reserve(
      "a",
      { inputTokens: 1, outputTokens: 0 },
      price,
    );
    budget.setLimits({ maxRequests: 0 });
    expect(budget.snapshot().exceeded).toBe(true);
    budget.settle(hold.id, { inputTokens: 1, outputTokens: 0 });
    expect(budget.snapshot().spent.requests).toBe(1);
    expect(() =>
      budget.reserve("b", { inputTokens: 1, outputTokens: 0 }, price),
    ).toThrow();
  });

  it("rejects duplicate pending request ids and malformed limits", () => {
    const budget = new ModelBudget();
    budget.reserve("a", { inputTokens: 1, outputTokens: 0 }, price);
    expect(() =>
      budget.reserve("a", { inputTokens: 1, outputTokens: 0 }, price),
    ).toThrow("already");
    expect(() =>
      budget.reserve(" ", { inputTokens: 1, outputTokens: 0 }, price),
    ).toThrow("requestId");
    expect(() => new ModelBudget({ maxCostMicros: -1 })).toThrow();
    expect(() => budget.setLimits({ maxRequests: 0.5 })).toThrow();
  });
});
