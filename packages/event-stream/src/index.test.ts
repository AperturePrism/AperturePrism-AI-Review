import { describe, expect, it } from "vitest";
import {
  heartbeatEvent,
  reduceTaskEvent,
  serializeSseEvent,
  SSE_HEADERS,
  type TaskEventRecord,
} from "./index.js";

describe("serializeSseEvent", () => {
  it("formats a complete SSE payload with id and event", () => {
    const out = serializeSseEvent({ seq: 3, type: "task.created", data: { a: 1 } });
    expect(out).toBe(`id: 3\nevent: task.created\ndata: {"a":1}\n\n`);
  });

  it("exposes stream headers", () => {
    expect(SSE_HEADERS["content-type"]).toBe("text/event-stream");
  });
});

describe("reduceTaskEvent", () => {
  function event(seq: number, type: string, at = "t"): TaskEventRecord {
    return { seq, type, at, taskId: "task-1", payload: {} };
  }

  it("advances status and tracks the max sequence", () => {
    const created = reduceTaskEvent(null, event(1, "task.created"));
    expect(created.status).toBe("queued");
    const running = reduceTaskEvent(created, event(2, "task.started"));
    expect(running.status).toBe("running");
    const done = reduceTaskEvent(running, event(3, "task.completed"));
    expect(done.status).toBe("completed");
    expect(done.eventCount).toBe(3);
    expect(done.maxSeq).toBe(3);
  });

  it("ignores unknown event types without losing prior status", () => {
    const a = reduceTaskEvent(null, event(1, "task.created"));
    const b = reduceTaskEvent(a, event(2, "analysis.graded"));
    expect(b.status).toBe("queued");
    expect(b.eventCount).toBe(2);
  });

  it("maps publishing, retry-ready and lease-recovered events to their statuses", () => {
    const running = reduceTaskEvent(null, event(1, "task.started"));
    const publishing = reduceTaskEvent(running, event(2, "task.publishing"));
    expect(publishing.status).toBe("publishing");

    const retryReady = reduceTaskEvent(null, event(3, "task.retry_ready"));
    expect(retryReady.status).toBe("queued");

    const recovered = reduceTaskEvent(null, event(4, "task.lease_recovered"));
    expect(recovered.status).toBe("queued");
  });
});

describe("heartbeatEvent", () => {
  it("carries a sequence and a timestamp payload", () => {
    const beat = heartbeatEvent(9);
    expect(beat.type).toBe("heartbeat");
    expect(beat.seq).toBe(9);
    expect(typeof beat.data).toBe("object");
  });
});