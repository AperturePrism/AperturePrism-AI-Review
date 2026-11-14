import { describe, expect, it } from "vitest";
import { createExecutionQuota } from "./quota.js";

const policy = {
  maxConcurrent: 2,
  windowMs: 1_000,
  maxStarts: 3,
  maxUnits: 100,
};
function quota() {
  return createExecutionQuota(policy, { now: () => 10_000 });
}

describe("execution quota reservations", () => {
  it("reserves estimates and returns remaining integer units", () => {
    const subject = quota();
    expect(subject.reserve({ key: "a", units: 40 })).toMatchObject({
      allowed: true,
      duplicate: false,
    });
    expect(subject.snapshot()).toMatchObject({
      active: 1,
      starts: 1,
      reservedUnits: 40,
      usedUnits: 0,
      availableUnits: 60,
    });
    expect(subject.reserve({ key: "b", units: 70 })).toMatchObject({
      allowed: false,
      reason: "units",
      availableUnits: 60,
    });
  });
  it("prevents concurrent callers from oversubscribing the window", async () => {
    const subject = quota();
    const decisions = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        Promise.resolve().then(() =>
          subject.reserve({ key: `${index}`, units: 1 }),
        ),
      ),
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(2);
    expect(subject.active()).toHaveLength(2);
  });
  it("counts duplicate operation keys only once", () => {
    const subject = quota();
    const first = subject.reserve({ key: "a", units: 10 });
    const again = subject.reserve({ key: " a ", units: 10 });
    expect(again).toMatchObject({ allowed: true, duplicate: true });
    if (first.allowed && again.allowed)
      expect(first.reservation.id).toBe(again.reservation.id);
    expect(subject.snapshot().starts).toBe(1);
  });
  it("settles actual usage and releases only the reserved estimate", () => {
    const subject = quota();
    const ticket = subject.reserve({ key: "a", units: 70 });
    if (!ticket.allowed) throw new Error("expected reservation");
    expect(
      subject.finish(ticket.reservation.id, { units: 40, now: 10_010 }),
    ).toBe(true);
    expect(subject.snapshot(10_010)).toMatchObject({
      active: 0,
      usedUnits: 40,
      reservedUnits: 0,
      availableUnits: 60,
    });
    expect(subject.finish(ticket.reservation.id, { units: 0 })).toBe(false);
  });
  it("allows actual usage to exceed an estimate and blocks new work", () => {
    const subject = quota();
    const ticket = subject.reserve({ key: "a", units: 10 });
    if (!ticket.allowed) throw new Error("expected reservation");
    subject.finish(ticket.reservation.id, { units: 120 });
    expect(subject.reserve({ key: "b", units: 1 })).toMatchObject({
      allowed: false,
      reason: "units",
    });
    expect(subject.snapshot().availableUnits).toBe(0);
  });
  it("does not release an active long-running reservation when a time window expires", () => {
    const subject = quota();
    subject.reserve({ key: "a", units: 70 });
    expect(subject.snapshot(20_000)).toMatchObject({
      active: 1,
      starts: 0,
      reservedUnits: 70,
    });
    expect(subject.reserve({ key: "b", units: 40, now: 20_000 })).toMatchObject(
      { allowed: false, reason: "units" },
    );
  });
  it("expires finished usage and permits a business key in a new window", () => {
    const subject = quota();
    const ticket = subject.reserve({ key: "a", units: 70 });
    if (!ticket.allowed) throw new Error("expected reservation");
    subject.finish(ticket.reservation.id, { units: 70 });
    expect(subject.snapshot(11_000)).toMatchObject({
      starts: 0,
      usedUnits: 0,
      availableUnits: 100,
    });
    expect(subject.reserve({ key: "a", units: 70, now: 11_000 })).toMatchObject(
      { allowed: true, duplicate: false },
    );
  });
  it("retains canceled starts but refunds unused units", () => {
    const subject = quota();
    for (let index = 0; index < 3; index += 1) {
      const ticket = subject.reserve({ key: `a${index}`, units: 90 });
      if (!ticket.allowed) throw new Error("expected reservation");
      expect(subject.cancel(ticket.reservation.id)).toBe(true);
      expect(subject.cancel(ticket.reservation.id)).toBe(false);
    }
    expect(subject.reserve({ key: "fourth", units: 1 })).toMatchObject({
      allowed: false,
      reason: "starts",
      retryAt: 11_000,
    });
    expect(subject.snapshot()).toMatchObject({
      starts: 3,
      usedUnits: 0,
      availableUnits: 100,
    });
  });
  it("does not expose mutable reservation records", () => {
    const subject = quota();
    const ticket = subject.reserve({ key: "a", units: 50 });
    if (!ticket.allowed) throw new Error("expected reservation");
    ticket.reservation.units = 0;
    subject.active()[0]!.units = 0;
    expect(subject.snapshot().reservedUnits).toBe(50);
  });
  it("rejects time travel, fractional units and invalid budgets", () => {
    const subject = quota();
    expect(() => subject.reserve({ key: "", units: 1 })).toThrow();
    expect(() => subject.reserve({ key: "a", units: 0.1 })).toThrow();
    expect(() => subject.reserve({ key: "a", units: 1, now: NaN })).toThrow();
    expect(() => createExecutionQuota({ ...policy, maxStarts: 0 })).toThrow();
    const ticket = subject.reserve({ key: "a", units: 1 });
    if (!ticket.allowed) throw new Error("expected reservation");
    expect(() =>
      subject.finish(ticket.reservation.id, { units: 1, now: 1 }),
    ).toThrow();
  });
});
