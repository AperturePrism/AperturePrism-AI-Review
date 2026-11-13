import { describe, expect, it } from "vitest";
import { rateLimited } from "./rate-limit.js";

describe("bounded named request windows", () => {
  it("allows exactly the configured count per window", () => {
    const key = "counted-window";
    expect(rateLimited(key, 2, 1000)).toBe(false);
    expect(rateLimited(key, 2, 1001)).toBe(false);
    expect(rateLimited(key, 2, 1002)).toBe(true);
  });

  it("starts a fresh budget at the exact window boundary", () => {
    expect(rateLimited("boundary", 1, 1000)).toBe(false);
    expect(rateLimited("boundary", 1, 60_999)).toBe(true);
    expect(rateLimited("boundary", 1, 61_000)).toBe(false);
  });

  it("keeps webhook and API budgets independent for the same client", () => {
    expect(rateLimited("api:same-ip", 1, 1000)).toBe(false);
    expect(rateLimited("api:same-ip", 1, 1000)).toBe(true);
    expect(rateLimited("webhook:same-ip", 1, 1000)).toBe(false);
  });

  it("treats a zero or negative limit as disabled", () => {
    expect(rateLimited("disabled", 0, 1000)).toBe(false);
    expect(rateLimited("disabled", -1, 1000)).toBe(false);
  });

  it("does not evict active windows when many new sources arrive", () => {
    const now = 1_000_000;
    expect(rateLimited("existing-client", 1, now)).toBe(false);
    for (let source = 0; source < 10_100; source += 1)
      rateLimited(`source-${source}`, 1, now);
    expect(rateLimited("existing-client", 1, now + 1)).toBe(true);
    expect(rateLimited("new-source-over-capacity", 1, now + 1)).toBe(true);
    expect(rateLimited("new-source-over-capacity", 1, now + 60_000)).toBe(
      false,
    );
  });
});
