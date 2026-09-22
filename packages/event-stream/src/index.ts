/**
 * Server-sent-event plumbing for the WebUI. This package owns the wire
 * envelope (`id`/`event`/`data`), the append-only task timeline model, and the
 * reducer that turns a stream of events into a live task snapshot with enough
 * information to replay from a gap after a reconnect.
 *
 * It is intentionally framework-free: a node `ServerResponse` only needs the
 * pure formatter here.
 */

export type SseEvent = {
  /** Monotonic, gap-detecting sequence number (1-based). */
  seq: number;
  /** Stable event type, e.g. `task.created`, `analysis.graded`. */
  type: string;
  data: unknown;
};

/** Formats a single SSE payload including the mandatory `id`. */
export function serializeSseEvent(event: SseEvent): string {
  const data = JSON.stringify(event.data);
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${data}\n\n`;
}

/** SSE stream headers plus the initial comment so middleware won't buffer. */
export const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "x-accel-buffering": "no",
} as const;

export type TaskEventRecord = {
  seq: number;
  type: string;
  at: string;
  taskId: string;
  payload: unknown;
};

export type TaskSnapshot = {
  taskId: string;
  status: string;
  updatedAt: string;
  /** Number of events folded into this snapshot. */
  eventCount: number;
  /** Highest sequence seen, so a reconnect can resume from the next one. */
  maxSeq: number;
};

/**
 * A single fold operation on a task timeline. Kept as a pure function so the
 * same reducer powers both live updates and a from-sequence replay.
 */
export function reduceTaskEvent(
  snapshot: TaskSnapshot | null,
  event: TaskEventRecord,
): TaskSnapshot {
  return {
    taskId: event.taskId,
    status: statusFromEventType(event.type) ?? snapshot?.status ?? "queued",
    updatedAt: event.at,
    eventCount: (snapshot?.eventCount ?? 0) + 1,
    maxSeq: Math.max(event.seq, snapshot?.maxSeq ?? 0),
  };
}

function statusFromEventType(type: string): string | null {
  if (type === "task.created") return "queued";
  if (type === "task.leased" || type === "task.started") return "running";
  if (type === "task.publishing") return "publishing";
  if (type === "task.completed") return "completed";
  if (type === "task.failed") return "failed";
  if (type === "task.retry_wait" || type === "task.retry_scheduled")
    return "retry_wait";
  // A task becomes claimable again when a retry delay expires (task.retry_ready)
  // or when an expired lease is recovered back into the queue.
  if (type === "task.retry_ready" || type === "task.lease_recovered")
    return "queued";
  if (type === "task.canceled") return "canceled";
  return null;
}

/** Server-sent heartbeat event used to keep connections alive and as a liveness probe. */
export function heartbeatEvent(seq: number): SseEvent {
  return { seq, type: "heartbeat", data: { at: new Date().toISOString() } };
}