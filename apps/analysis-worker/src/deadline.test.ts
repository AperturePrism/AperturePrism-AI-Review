import { describe, expect, it } from "vitest";
import { remainingDeadlineMs } from "./deadline.js";

describe("remainingDeadlineMs", () => {
  it("returns only the unused portion of a shared deadline", () => {
    expect(remainingDeadlineMs(20_000, 7_500)).toBe(12_500);
  });

  it("returns zero after the shared deadline expires", () => {
    expect(remainingDeadlineMs(20_000, 20_001)).toBe(0);
  });
});
