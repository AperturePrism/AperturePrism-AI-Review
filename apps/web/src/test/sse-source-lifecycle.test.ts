import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSse } from "../hooks/useSse";

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
  }
  close(): void { this.closed = true; }
  frame(type: string, seq: number, data: unknown): void {
    this.dispatchEvent(new MessageEvent(type, {
      data: JSON.stringify(data), lastEventId: String(seq),
    }));
  }
}
const task = { taskId: "task-a", eventType: "completed", createdAt: "2026-11-13T10:00:00.000Z" };
const source = () => FakeEventSource.instances.at(-1)!;

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SSE source lifecycle", () => {
  it("resets replay cursor, buffered events, sequence and dedupe on URL change", () => {
    const { result, rerender } = renderHook(({ url }) => useSse(url), {
      initialProps: { url: "/events?token=alice" },
    });
    act(() => {
      source().frame("task", 5, task);
      source().frame("heartbeat", 8, {});
    });
    expect(result.current.hasGap).toBe(true);
    const old = source();
    rerender({ url: "/events?token=bob" });
    expect(old.closed).toBe(true);
    expect(source().url).toBe("/events?token=bob");
    expect(result.current).toMatchObject({ lastSeq: 0, events: [], hasGap: false });
    act(() => source().frame("task", 1, task));
    expect(result.current.events).toHaveLength(1);
    expect(result.current.hasGap).toBe(false);
  });

  it("ignores delayed task and heartbeat callbacks from a disposed URL", () => {
    const { result, rerender } = renderHook(({ url }) => useSse(url), {
      initialProps: { url: "/events?token=alice" },
    });
    const old = source();
    rerender({ url: "/events?token=bob" });
    act(() => {
      old.frame("task", 20, task);
      old.frame("heartbeat", 21, {});
      old.onmessage?.(new MessageEvent("message", { data: JSON.stringify(task), lastEventId: "22" }));
    });
    expect(result.current.events).toEqual([]);
    expect(result.current.lastSeq).toBe(0);
  });

  it("retains the cursor on retry of the same URL and ignores the old connection", () => {
    const { result } = renderHook(() => useSse("/events?token=alice"));
    const old = source();
    act(() => old.frame("task", 1, task));
    act(() => old.onerror?.());
    act(() => vi.advanceTimersByTime(3_000));
    expect(source().url).toContain(`&since=${encodeURIComponent(task.createdAt)}`);
    act(() => source().onopen?.());
    act(() => {
      old.onerror?.();
      old.frame("task", 99, { ...task, taskId: "stale" });
    });
    expect(result.current.status).toBe("online");
    expect(result.current.events).toHaveLength(1);
    expect(result.current.lastSeq).toBe(1);
    act(() => vi.advanceTimersByTime(3_000));
    expect(FakeEventSource.instances).toHaveLength(2);
  });
});
