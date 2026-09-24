import { useCallback, useEffect, useRef, useState } from "react";

export type SseStatus = "connecting" | "online" | "offline";

export type StreamedEvent = {
  seq: number;
  type: string;
  data: unknown;
};

export type SseState = {
  status: SseStatus;
  /** Highest sequence seen, for reconnect gap detection. */
  lastSeq: number;
  events: StreamedEvent[];
  /** True when a gap was detected in the `id` sequence. */
  hasGap: boolean;
};

const MAX_EVENTS = 50;

/**
 * Connects to the API `/events` SSE stream. Auto-reconnects with a short
 * backoff, resumes from the last seen event (`?since=`) so missed events are
 * replayed by the server, dedupes replay/live overlap, and tracks
 * connecting/online/offline so the UI never silently stalls.
 */
export function useSse(url: string): SseState {
  const [status, setStatus] = useState<SseStatus>("connecting");
  const [lastSeq, setLastSeq] = useState(0);
  const [events, setEvents] = useState<StreamedEvent[]>([]);
  const [hasGap, setHasGap] = useState(false);
  const expectedRef = useRef(0);
  const lastSeenAtRef = useRef<string | null>(null);
  const seenKeysRef = useRef<Set<string>>(new Set());

  const pushEvent = useCallback(
    (type: string, seq: number, data: unknown, options?: { buffer?: boolean }) => {
      // 序号游标只在有数字 id 时推进（seq<=0 表示无 id，不参与缺口检测）。
      if (seq > 0) {
        if (expectedRef.current !== 0 && seq !== expectedRef.current)
          setHasGap(true);
        expectedRef.current = seq + 1;
        setLastSeq(seq);
      }
      // 心跳是保活信号，不进事件环形缓冲，避免挤占 MAX_EVENTS 把任务事件挤出。
      if (options?.buffer === false) return;
      setEvents((prev) => [
        ...prev.slice(-(MAX_EVENTS - 1)),
        { seq, type, data },
      ]);
    },
    [],
  );

  useEffect(() => {
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let es: EventSource | null = null;

    const connect = () => {
      if (disposed) return;
      setStatus("connecting");
      const since = lastSeenAtRef.current;
      const target = since
        ? `${url}${url.includes("?") ? "&" : "?"}since=${encodeURIComponent(since)}`
        : url;
      es = new EventSource(target);
      es.onopen = () => {
        if (!disposed) setStatus("online");
      };
      es.onerror = () => {
        if (disposed) return;
        setStatus("offline");
        es?.close();
        retryTimer = setTimeout(connect, 3_000);
      };
      // The server sends named events: `event: heartbeat` and `event: task`
      // (see serializeSseEvent in packages/event-stream). Named events do NOT
      // fire `onmessage`, so task events must be subscribed explicitly —
      // otherwise the live stream silently drops every task event.
      const ingestFrame = (data: unknown, seq: number) => {
        const isTaskFrame =
          data &&
          typeof data === "object" &&
          "taskId" in data &&
          "eventType" in data;
        if (isTaskFrame) {
          // Replay/live overlap can deliver the same row twice; dedupe task
          // events by their stable identity so the UI never double-counts.
          const record = data as {
            taskId: string;
            eventType: string;
            createdAt?: string;
          };
          const key = `${record.taskId}:${record.eventType}:${record.createdAt ?? ""}`;
          if (seenKeysRef.current.has(key)) return;
          seenKeysRef.current.add(key);
          if (seenKeysRef.current.size > 2000) seenKeysRef.current.clear();
          if (record.createdAt) lastSeenAtRef.current = record.createdAt;
          pushEvent("task", seq, data);
        } else {
          pushEvent("message", seq, data);
        }
      };
      es.addEventListener("heartbeat", (raw) => {
        const message = raw as MessageEvent<string>;
        // 心跳只推进序号游标（服务端心跳与任务共享同一递增序号），不写入事件缓冲。
        pushEvent("heartbeat", seqOf(message), safeParse(message.data), {
          buffer: false,
        });
      });
      es.addEventListener("task", (raw) => {
        const message = raw as MessageEvent<string>;
        ingestFrame(safeParse(message.data), seqOf(message));
      });
      // 兜底：协议保证帧都带 event（task / heartbeat），此路径仅为防御；
      // 若收到 task 形态的默认帧，走与命名 task 事件相同的去重/游标逻辑。
      es.onmessage = (raw) => {
        const message = raw as MessageEvent<string>;
        ingestFrame(safeParse(message.data), seqOf(message));
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
    };
  }, [url, pushEvent]);

  return { status, lastSeq, events, hasGap };
}

function seqOf(message: MessageEvent<string>): number {
  const parsed = Number(message.lastEventId);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeParse(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
