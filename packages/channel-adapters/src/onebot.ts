import { segmentsToText, textToSegments } from "./segments.js";
import type {
  ChannelMessageRef,
  ChannelProtocol,
  NormalizedChannelMessage,
} from "./types.js";

const protocol: ChannelProtocol = "onebot11";
const messageIdPrefix = `ob11`;

function numberString(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Normalizes a OneBot 11 message event (array format). Resolves the scene from
 * `message_type`, derives a stable message id from the numeric `message_id`,
 * and reduces the message segments to plain text.
 */
export function normalizeOneBotMessage(
  raw: unknown,
): NormalizedChannelMessage | null {
  const event = objectValue(raw);
  if (event.post_type !== "message") return null;
  const messageType = event.message_type;
  const scene =
    messageType === "group"
      ? "group"
      : messageType === "private"
        ? "private"
        : null;
  if (!scene) return null;

  const messageId = numberString(event.message_id);
  const selfId = numberString(event.self_id);
  const senderId = numberString(event.user_id);
  const peerId = scene === "group" ? numberString(event.group_id) : senderId;
  if (
    messageId === null ||
    selfId === null ||
    senderId === null ||
    peerId === null
  )
    return null;

  const body = segmentsToText(
    Array.isArray(event.message) ? (event.message as unknown[]) : undefined,
  );
  if (body.length === 0) return null;

  return {
    protocol,
    scene,
    peerId: String(peerId),
    senderId: String(senderId),
    messageId: `${messageIdPrefix}:${senderId}:${messageId}`,
    body,
    selfId: String(selfId),
    time: numberString(event.time) ?? 0,
  };
}

export function oneBotMessageRef(input: {
  scene: "group" | "private";
  peerId: string;
  messageId?: unknown;
}): ChannelMessageRef {
  return {
    protocol,
    scene: input.scene,
    peerId: input.peerId,
    messageId: messageIdPrefix
      .concat(":reply:")
      .concat(input.messageId === undefined ? "" : String(input.messageId)),
  };
}

/**
 * Builds the OneBot 11 send payload for one of the send_*_msg APIs. `peerId`
 * is the group id when `scene` is group, else the friend uin.
 */
export function oneBotSendPayload(input: {
  scene: "group" | "private";
  peerId: string;
  text: string;
}): { action: string; params: Record<string, unknown> } {
  const message = textToSegments(input.text);
  if (input.scene === "group") {
    return {
      action: "send_group_msg",
      params: { group_id: Number(input.peerId), message },
    };
  }
  return {
    action: "send_private_msg",
    params: { user_id: Number(input.peerId), message },
  };
}
