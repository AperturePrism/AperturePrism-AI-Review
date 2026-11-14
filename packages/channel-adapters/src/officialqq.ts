import type { NormalizedChannelMessage } from "./types.js";

const protocol = "officialqq" as const;
const messageIdPrefix = `oqq`;

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

export type OfficialQqDispatch = {
  /** opcode: 0 = Dispatch (event), 1 = Heartbeat, 2 = Identify, etc. */
  op: number;
  /** Sequence number, echoed in heartbeats. */
  s?: number;
  /** Event name (e.g. C2C_MESSAGE_CREATE) when op is 0. */
  t?: string;
  /** Event payload when op is 0. */
  d?: unknown;
};

export type OfficialQqMessage = {
  id: string;
  content: string;
  authorOpenid: string;
  /** user_openid for single chat, member_openid for group. */
  scenePeerOpenid: string;
  timestamp?: string;
};

/**
 * Extracts a message event from an official QQ WebSocket dispatch payload
 * (op === 0). Both single chat (C2C_MESSAGE_CREATE) and group @bot
 * (GROUP_AT_MESSAGE_CREATE) share the same shape.
 */
export function officialQqMessageFromDispatch(
  eventType: string | undefined,
  d: unknown,
): OfficialQqMessage | null {
  const event = objectValue(d);
  const id = event.id;
  const content = event.content;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof content !== "string") return null;
  const author = objectValue(event.author);
  const authorOpenid =
    typeof author.user_openid === "string"
      ? author.user_openid
      : typeof author.member_openid === "string"
        ? author.member_openid
        : "";
  if (authorOpenid.length === 0) return null;
  const scenePeerOpenid =
    eventType === "C2C_MESSAGE_CREATE"
      ? authorOpenid
      : typeof event.group_openid === "string"
        ? event.group_openid
        : authorOpenid;
  return {
    id,
    content,
    authorOpenid,
    scenePeerOpenid,
    ...(typeof event.timestamp === "string"
      ? { timestamp: event.timestamp }
      : {}),
  };
}

/**
 * Normalizes an official QQ dispatch to the common channel message. The bot
 * is the peer in single chat (user_openid) and the group in group chats
 * (group_openid). Content is trimmed; raw mentions are part of the text in
 * group @ only, which is the group event we receive.
 */
export function normalizeOfficialQqMessage(
  dispatch: OfficialQqDispatch,
): NormalizedChannelMessage | null {
  if (
    dispatch.op !== 0 ||
    (dispatch.t !== "C2C_MESSAGE_CREATE" &&
      dispatch.t !== "GROUP_AT_MESSAGE_CREATE")
  )
    return null;
  const message = officialQqMessageFromDispatch(dispatch.t, dispatch.d);
  if (!message) return null;
  const body = message.content.trim().replace(/^\s*@/u, "");
  if (body.length === 0) return null;
  const scene = dispatch.t === "C2C_MESSAGE_CREATE" ? "private" : "group";
  return {
    protocol,
    scene,
    peerId: message.scenePeerOpenid,
    senderId: message.authorOpenid,
    messageId: `${messageIdPrefix}:${message.id}`,
    body,
    selfId: String(dispatch.s ?? 0),
    time: message.timestamp
      ? Math.floor(Date.parse(message.timestamp) / 1000)
      : 0,
  };
}

export type OfficialQqAccessTokenResponse = {
  access_token: string;
  expires_in: number;
};

export function officialQqAccessTokenRequest(input: {
  appId: string;
  clientSecret: string;
}): { url: string; body: { appId: string; clientSecret: string } } {
  return {
    url: "https://api.bot.qq.com/app/getAppAccessToken",
    body: { appId: input.appId, clientSecret: input.clientSecret },
  };
}

export type OfficialQqSendMessageInput = {
  scene: "group" | "private";
  /** group_openid for group, user_openid for single chat. */
  openid: string;
  /** Plain text reply; the bot may only use features it is granted. */
  content: string;
  /** Optional source message id to reply within the passive-message window. */
  msgId?: string;
};

export function officialQqSendMessageRequest(
  input: OfficialQqSendMessageInput,
): {
  url: string;
  body: Record<string, unknown>;
} {
  const path =
    input.scene === "group"
      ? `/v2/groups/${encodeURIComponent(input.openid)}/messages`
      : `/v2/users/${encodeURIComponent(input.openid)}/messages`;
  const body: Record<string, unknown> = {
    content: input.content,
    msg_type: 0,
  };
  return {
    url: `https://api.bot.qq.com${path}`,
    body: input.msgId === undefined ? body : { ...body, msg_id: input.msgId },
  };
}

export type OfficialQqTokenStore = {
  /** Resolves a valid access token, refreshing and caching with expiry. */
  getToken: () => Promise<string>;
};

export function createOfficialQqTokenStore(input: {
  appId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): OfficialQqTokenStore {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => Date.now());
  let cached: { token: string; expiresAt: number } | null = null;
  let refreshing: Promise<string> | null = null;

  const fetchToken = async (): Promise<{
    token: string;
    expiresAt: number;
  }> => {
    const request = officialQqAccessTokenRequest({
      appId: input.appId,
      clientSecret: input.clientSecret,
    });
    const response = await fetchImpl(request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.body),
    });
    if (!response.ok)
      throw new Error(`QQ access token failed: ${response.status}`);
    const body = (await response.json()) as OfficialQqAccessTokenResponse;
    if (!body.access_token)
      throw new Error("QQ access token response missing token");
    const ttlMs = (body.expires_in ?? 7200) * 1000;
    return { token: body.access_token, expiresAt: now() + ttlMs };
  };

  return {
    getToken: async () => {
      if (cached && cached.expiresAt - now() > 60_000) return cached.token;
      refreshing ??= fetchToken()
        .then((next) => {
          cached = next;
          return next.token;
        })
        .finally(() => {
          refreshing = null;
        });
      return refreshing;
    },
  };
}
