import { milkyMessageRef, milkySendPayload } from "./milky.js";
import { oneBotMessageRef, oneBotSendPayload } from "./onebot.js";
import { satoriMessageRef, satoriSendPayload } from "./satori.js";
import type { ChannelMessageRef, ChannelProtocol } from "./types.js";

export type ChannelConnectorConfig = {
  /** Base HTTP URL that accepts the protocol's action calls. */
  baseUrl: string;
  /** Bearer access token; empty when the gateway needs none. */
  accessToken?: string;
  fetchImpl?: typeof fetch;
};

export class ChannelConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelConnectorError";
  }
}

export type SendInput = {
  protocol: ChannelProtocol;
  scene: "group" | "private";
  /** Group id (group) or friend uin (private), or Satori channel id. */
  peerId: string;
  text: string;
};

/**
 * Posts a message to the protocol gateway's HTTP API. OneBot 11 and Milky use
 * an action-per-path convention; Satori uses a single `/v1/message.create`.
 * The connector never decides retries or business policy.
 */
export async function sendChannelMessage(
  config: ChannelConnectorConfig,
  input: SendInput,
): Promise<ChannelMessageRef> {
  const fetchImpl = config.fetchImpl ?? fetch;

  if (input.protocol === "satori") {
    const payload = satoriSendPayload({
      channelId: input.peerId,
      text: input.text,
    });
    const response = await post(
      fetchImpl,
      `${stripSlash(config.baseUrl)}${payload.path}`,
      config.accessToken,
      payload.body,
    );
    const messageId = extractSatoriId(response);
    return satoriMessageRef({
      scene: input.scene,
      peerId: input.peerId,
      ...(messageId === undefined ? {} : { messageId }),
    });
  }

  const body =
    input.protocol === "milky"
      ? milkySendPayload({
          scene: input.scene,
          peerId: input.peerId,
          text: input.text,
        })
      : oneBotSendPayload({
          scene: input.scene,
          peerId: input.peerId,
          text: input.text,
        });
  const text = await post(
    fetchImpl,
    `${stripSlash(config.baseUrl)}/${body.action}`,
    config.accessToken,
    body.params,
  );
  return input.protocol === "milky"
    ? milkyMessageRef({
        scene: input.scene,
        peerId: input.peerId,
        messageSeq: extractOneBotId(text),
      })
    : oneBotMessageRef({
        scene: input.scene,
        peerId: input.peerId,
        messageId: extractOneBotId(text),
      });
}

function stripSlash(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

async function post(
  fetchImpl: typeof fetch,
  url: string,
  accessToken: string | undefined,
  body: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new ChannelConnectorError(
      error instanceof Error ? error.message : "channel request failed",
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new ChannelConnectorError(
      `channel responded with ${response.status}: ${text.slice(0, 200)}`,
    );
  }
  const result: unknown = await response.json().catch(() => ({}));
  if (typeof result === "object" && result !== null) {
    const { status, retcode } = result as {
      status?: unknown;
      retcode?: unknown;
    };
    // OneBot's retcode=1 with status=async means accepted, not failed.
    const acceptedAsync = status === "async" && retcode === 1;
    if (
      status === "failed" ||
      (typeof retcode === "number" && retcode !== 0 && !acceptedAsync)
    ) {
      throw new ChannelConnectorError(
        typeof retcode === "number"
          ? `channel action failed: retcode ${retcode}`
          : "channel action failed: status failed",
      );
    }
  }
  return result;
}

function extractOneBotId(response: unknown): number | null {
  const data = (response as { data?: { message_id?: unknown } })?.data;
  return typeof data?.message_id === "number" ? data.message_id : null;
}

function extractSatoriId(response: unknown): string | undefined {
  const message = (response as { message?: { id?: unknown } })?.message;
  return typeof message?.id === "string" ? message.id : undefined;
}
