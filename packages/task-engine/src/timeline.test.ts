import { describe, expect, it } from "vitest";
import {
  inspectTaskTimeline,
  timelineCsv,
  type TaskTimelineEvent,
} from "./timeline.js";

const start = Date.parse("2026-11-13T12:00:00Z");
const event = (
  eventType: string,
  offset: number,
  data: unknown = {},
): TaskTimelineEvent => ({
  eventType,
  createdAt: new Date(start + offset),
  data,
});
const completed = [
  event("task.created", 0),
  event("task.leased", 1_000, { workerId: "worker-1", attemptNumber: 1 }),
  event("task.started", 1_100),
  event("task.analysis_usage", 2_000, {
    inputTokens: 100,
    outputTokens: 20,
    durationMs: 800,
    provider: "provider",
    model: "model",
  }),
  event("task.publishing", 2_100),
  event("task.completed", 2_400),
];

describe("task audit timeline", () => {
  it("derives queue, execution, publication and model usage independently", () => {
    const report = inspectTaskTimeline(completed);
    expect(report).toMatchObject({
      status: "completed",
      duration: {
        totalMs: 2_400,
        queueMs: 1_000,
        executionMs: 1_000,
        publishingMs: 300,
        retryWaitMs: 0,
      },
      usage: { inputTokens: 100, outputTokens: 20, modelDurationMs: 800 },
      warnings: [],
      reruns: 0,
    });
    expect(report.attempts[0]).toMatchObject({
      attemptNumber: 1,
      workerId: "worker-1",
      outcome: "completed",
      providers: ["provider"],
      models: ["model"],
    });
  });
  it("sorts out of order transport events without changing the input", () => {
    const events = [...completed].reverse();
    expect(inspectTaskTimeline(events)).toEqual(inspectTaskTimeline(completed));
    expect(events[0]?.eventType).toBe("task.completed");
  });
  it("tracks retry waits and distinct attempt records", () => {
    const report = inspectTaskTimeline([
      ...completed.slice(0, 3),
      event("task.retry_scheduled", 2_000, { errorCategory: "timeout" }),
      event("task.retry_ready", 5_000),
      event("task.leased", 5_500, { workerId: "worker-2", attemptNumber: 2 }),
      event("task.started", 5_600),
      event("task.publishing", 7_000),
      event("task.completed", 7_300),
    ]);
    expect(report.duration).toMatchObject({
      queueMs: 1_500,
      retryWaitMs: 3_000,
      executionMs: 2_300,
      publishingMs: 300,
    });
    expect(report.attempts.map((attempt) => attempt.outcome)).toEqual([
      "retry_wait",
      "completed",
    ]);
    expect(report.attempts[0]?.errorCategory).toBe("timeout");
  });
  it("recognizes manual reruns as a new execution budget", () => {
    const report = inspectTaskTimeline([
      ...completed.slice(0, 3),
      event("task.failed", 2_000),
      event("task.retry_ready", 3_000),
      event("task.leased", 3_100, { attemptNumber: 1 }),
      event("task.started", 3_200),
      event("task.publishing", 3_400),
      event("task.completed", 3_500),
    ]);
    expect(report.reruns).toBe(1);
    expect(report.attempts.map((attempt) => attempt.attemptNumber)).toEqual([
      1, 1,
    ]);
  });
  it("closes expired attempts and starts a fresh queue wait", () => {
    const report = inspectTaskTimeline(
      [...completed.slice(0, 3), event("task.lease_recovered", 2_000)],
      { now: new Date(start + 5_000) },
    );
    expect(report.status).toBe("queued");
    expect(report.attempts[0]?.outcome).toBe("lease_expired");
    expect(report.duration.queueMs).toBe(4_000);
  });
  it("deduplicates event IDs and preserves only the final usage snapshot per attempt", () => {
    const usage = { ...completed[3]!, id: "usage-1" };
    const report = inspectTaskTimeline([
      ...completed.slice(0, 3),
      usage,
      usage,
      event("task.analysis_usage", 2_050, {
        inputTokens: 150,
        outputTokens: 30,
        durationMs: 900,
      }),
      ...completed.slice(4),
    ]);
    expect(report.usage).toEqual({
      inputTokens: 150,
      outputTokens: 30,
      modelDurationMs: 900,
    });
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ code: "duplicate_event" }),
    );
  });
  it("flags malformed usage without adding negative or noninteger counts", () => {
    const report = inspectTaskTimeline([
      ...completed.slice(0, 3),
      event("task.analysis_usage", 2_000, {
        inputTokens: -1,
        outputTokens: 0.5,
        durationMs: 2,
      }),
      ...completed.slice(4),
    ]);
    expect(report.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      modelDurationMs: 0,
    });
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ code: "invalid_usage" }),
    );
  });
  it("retains evidence warnings for incomplete or invalid event streams", () => {
    const report = inspectTaskTimeline([
      event("task.completed", 2_000),
      { eventType: "task.created", createdAt: "bad", data: null },
    ]);
    expect(report.warnings.map((warning) => warning.code)).toEqual([
      "invalid_time",
      "unexpected_transition",
      "missing_lease",
    ]);
    expect(report.status).toBe("completed");
  });
  it("does not invent zero-duration evidence for an empty timeline", () => {
    expect(inspectTaskTimeline([])).toMatchObject({
      status: "unknown",
      firstEventAt: null,
      lastEventAt: null,
      duration: { totalMs: null, queueMs: null },
      attempts: [],
    });
  });
  it("measures an ongoing retry wait using the caller clock", () => {
    const report = inspectTaskTimeline(
      [...completed.slice(0, 3), event("task.retry_scheduled", 2_000)],
      { now: new Date(start + 8_000) },
    );
    expect(report.duration.retryWaitMs).toBe(6_000);
    expect(report.duration.totalMs).toBe(8_000);
  });
  it("exports properly escaped metadata CSV without raw event bodies", () => {
    const report = inspectTaskTimeline(completed);
    report.attempts[0]!.workerId = 'worker,"special"';
    const csv = timelineCsv(report);
    expect(csv).toContain('"worker,""special"""');
    expect(csv).toContain('"input_tokens","output_tokens"');
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv).not.toContain("task.analysis_usage");
  });
});
