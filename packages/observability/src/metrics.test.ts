import { describe, expect, it } from "vitest";
import { MetricsRegistry } from "./metrics.js";

describe("MetricsRegistry", () => {
  it("accumulates counters and supports batching", () => {
    const m = new MetricsRegistry();
    m.increment("a");
    m.increment("a", 3);
    m.bumpCounters([
      ["a", 1],
      ["b", 2],
    ]);
    const snap = m.snapshot();
    expect(snap.counters.a).toBe(5);
    expect(snap.counters.b).toBe(2);
  });

  it("records durations and computes averages", () => {
    const m = new MetricsRegistry();
    m.recordDuration("http.request_ms", 100);
    m.recordDuration("http.request_ms", 300);
    const snap = m.snapshot();
    expect(snap.durations["http.request_ms"]).toEqual({
      count: 2,
      totalMs: 400,
    });
  });

  it("tracks gauges and stamps a start time", () => {
    const m = new MetricsRegistry();
    m.setGauge("queue.depth", 7);
    const snap = m.snapshot();
    expect(snap.gauges["queue.depth"]).toBe(7);
    expect(Date.parse(snap.since)).not.toBeNaN();
  });
});

describe("metrics snapshot isolation", () => {
  it("does not expose mutable duration buckets from the registry", () => {
    const registry = new MetricsRegistry();
    registry.recordDuration("model.invoke", 100);
    const snapshot = registry.snapshot();
    snapshot.durations["model.invoke"]!.count = 50;
    snapshot.durations["model.invoke"]!.totalMs = 9_999;

    expect(registry.snapshot().durations["model.invoke"]).toEqual({
      count: 1,
      totalMs: 100,
    });
    registry.recordDuration("model.invoke", 25);
    expect(registry.snapshot().durations["model.invoke"]).toEqual({
      count: 2,
      totalMs: 125,
    });
  });

  it("returns independently mutable duration buckets for every snapshot", () => {
    const registry = new MetricsRegistry();
    registry.recordDuration("model.invoke", 100);
    const first = registry.snapshot();
    const second = registry.snapshot();
    first.durations["model.invoke"]!.totalMs = 0;
    expect(second.durations["model.invoke"]!.totalMs).toBe(100);
  });
});
