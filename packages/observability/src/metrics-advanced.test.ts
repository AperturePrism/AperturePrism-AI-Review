/** Prometheus 桶语义、有限分位数样本及错误输入验证。 */
import { describe, expect, it } from "vitest";
import { MetricsRegistry } from "./metrics.js";

describe("bounded operational metrics", () => {
  it("exports cumulative duration buckets in seconds", () => {
    const metrics = new MetricsRegistry({ histogramBoundsMs: [100, 500] });
    metrics.increment("http.requests", 3);
    metrics.setGauge("queue.depth", 2);
    for (const value of [50, 250, 700])
      metrics.recordDuration("http.request_ms", value);
    const output = metrics.prometheus();
    expect(output).toContain(
      "# TYPE apertureprism_http_requests_total counter",
    );
    expect(output).toContain("apertureprism_http_requests_total 3");
    expect(output).toContain(
      'apertureprism_http_request_seconds_bucket{le="0.1"} 1',
    );
    expect(output).toContain(
      'apertureprism_http_request_seconds_bucket{le="0.5"} 2',
    );
    expect(output).toContain(
      'apertureprism_http_request_seconds_bucket{le="+Inf"} 3',
    );
    expect(output).toContain("apertureprism_http_request_seconds_sum 1");
    expect(output).toContain("apertureprism_http_request_seconds_count 3");
    expect(output.endsWith("\n")).toBe(true);
  });

  it("keeps lifetime totals but limits percentile samples to recent values", () => {
    const metrics = new MetricsRegistry({ durationSamples: 3 });
    for (const value of [1, 10, 20, 30, 40])
      metrics.recordDuration("model", value);
    expect(metrics.durationSummary("model")).toEqual({
      count: 5,
      totalMs: 101,
      minMs: 1,
      maxMs: 40,
      p50Ms: 30,
      p95Ms: 40,
      p99Ms: 40,
      sampled: 3,
    });
    expect(metrics.durationSummary("missing")).toBeNull();
  });

  it("does not permit one metric to silently change type or exceed cardinality", () => {
    const metrics = new MetricsRegistry({ maxNames: 1 });
    metrics.increment("requests");
    expect(() => metrics.setGauge("requests", 3)).toThrow("type counter");
    expect(() => metrics.increment("new-name")).toThrow("capacity");
    metrics.increment("requests");
    expect(metrics.snapshot().counters.requests).toBe(2);
  });

  it("rejects invalid measurements before publishing corrupt telemetry", () => {
    const metrics = new MetricsRegistry();
    for (const value of [NaN, Infinity, -1]) {
      expect(() => metrics.increment("counter", value)).toThrow();
      expect(() => metrics.recordDuration("duration", value)).toThrow();
    }
    expect(() => metrics.setGauge("gauge", Infinity)).toThrow();
    expect(() => metrics.increment(" ")).toThrow();
    expect(() => new MetricsRegistry({ histogramBoundsMs: [10, 5] })).toThrow();
    expect(() => new MetricsRegistry({ durationSamples: 0 })).toThrow();
  });

  it("detects name collisions after Prometheus normalization", () => {
    const metrics = new MetricsRegistry();
    metrics.increment("a.b");
    metrics.increment("a_b");
    expect(() => metrics.prometheus()).toThrow("collide");
  });

  it("resets all histories and stamps the new collection period", () => {
    let date = new Date(0);
    const metrics = new MetricsRegistry({ now: () => date });
    metrics.increment("a");
    metrics.recordDuration("duration", 1);
    metrics.setGauge("gauge", 2);
    date = new Date(1_000);
    metrics.reset();
    expect(metrics.snapshot()).toEqual({
      counters: {},
      durations: {},
      gauges: {},
      since: date.toISOString(),
    });
    expect(metrics.durationSummary("duration")).toBeNull();
    expect(metrics.prometheus()).toBe("");
  });
});
