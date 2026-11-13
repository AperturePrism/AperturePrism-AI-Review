import { describe, expect, it, vi } from "vitest";
vi.mock("./runtime.js", () => ({
  database: { db: {} },
  redis: {},
  logger: { warn: vi.fn() },
  config: {},
}));
import { canReceiveEvent, parseEventFrame, type EventFrame } from "./events.js";
const REPO = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-0000-0000-000000000002";
const frame: EventFrame = {
  seq: 1,
  type: "task",
  repositoryId: REPO,
  data: { taskId: "task-1" },
};

describe("SSE repository visibility", () => {
  it("sends authorized task events to a repository-scoped client", () => {
    expect(canReceiveEvent(new Set([REPO]), frame)).toBe(true);
  });
  it("does not send another repository's task events", () => {
    expect(canReceiveEvent(new Set([OTHER]), frame)).toBe(false);
  });
  it("does not leak task data to an account with no grants", () => {
    expect(canReceiveEvent(new Set(), frame)).toBe(false);
  });
  it("lets an administrator see all repository task events", () => {
    expect(canReceiveEvent(null, frame)).toBe(true);
  });
  it("hides old broker frames with no repository metadata from scoped users", () => {
    const old: EventFrame = { seq: 1, type: "task", data: {} };
    expect(canReceiveEvent(new Set([REPO]), old)).toBe(false);
    expect(canReceiveEvent(null, old)).toBe(true);
  });
  it("sends non-sensitive heartbeats even when no repository is visible", () => {
    expect(
      canReceiveEvent(new Set(), {
        seq: 1,
        type: "heartbeat",
        data: { at: "2026-11-13" },
      }),
    ).toBe(true);
  });
});

describe("Redis event input boundary", () => {
  it("preserves valid event data and the repository used for authorization", () => {
    expect(parseEventFrame(JSON.stringify(frame))).toEqual(frame);
  });
  it.each([
    "null",
    "[]",
    '"message"',
    "not-json",
    '{"seq":1,"type":"unknown"}',
    '{"seq":-1,"type":"task"}',
    '{"seq":1.5,"type":"task"}',
    '{"seq":1,"type":"task","repositoryId":"not-uuid"}',
  ])("rejects malformed broker input %s", (text) => {
    expect(parseEventFrame(text)).toBeNull();
  });
});
