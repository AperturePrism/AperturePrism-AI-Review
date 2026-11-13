import { describe, expect, it } from "vitest";
import { sendChannelMessage } from "./connector.js";

type Call = { url: string; init: RequestInit };

function connectorWith(
  responder: (call: Call) => Promise<Response> | Response,
) {
  const calls: Call[] = [];
  const base = {
    baseUrl: "http://127.0.0.1:3000",
    accessToken: "secret",
    fetchImpl: (async (url, init) => {
      const call = { url: String(url), init: init ?? {} };
      calls.push(call);
      return responder(call);
    }) as typeof fetch,
  };
  return { base, calls };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("channel connector send", () => {
  it("posts OneBot 11 group messages to the action path with Bearer auth", async () => {
    const { base, calls } = connectorWith(() =>
      jsonResponse({ status: "ok", data: { message_id: 99 } }),
    );
    const ref = await sendChannelMessage(base, {
      protocol: "onebot11",
      scene: "group",
      peerId: "999",
      text: "done",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:3000/send_group_msg");
    expect(
      (calls[0]?.init.headers as Record<string, string>).authorization,
    ).toBe("Bearer secret");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      group_id: 999,
      message: [{ type: "text", data: { text: "done" } }],
    });
    expect(ref).toEqual({
      protocol: "onebot11",
      scene: "group",
      peerId: "999",
      messageId: "ob11:reply:99",
    });
  });

  it("posts Milky private messages using its action semantics", async () => {
    const { base, calls } = connectorWith(() =>
      jsonResponse({ status: "ok", data: { message_id: 7 } }),
    );
    const ref = await sendChannelMessage(base, {
      protocol: "milky",
      scene: "private",
      peerId: "12345",
      text: "hi",
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:3000/send_private_msg");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      user_id: 12345,
      message: [{ type: "text", data: { text: "hi" } }],
    });
    expect(ref.messageId).toBe("milk:reply:7");
  });

  it("posts Satori messages to /v1/message.create", async () => {
    const { base, calls } = connectorWith(() =>
      jsonResponse({ message: { id: "mid-1" } }),
    );
    const ref = await sendChannelMessage(base, {
      protocol: "satori",
      scene: "group",
      peerId: "g999",
      text: "done",
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:3000/v1/message.create");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      channel_id: "g999",
      content: "done",
    });
    expect(ref.messageId).toBe("st:reply:mid-1");
  });

  it("surfaces a non-2xx gateway response as a connector error", async () => {
    const { base } = connectorWith(() => new Response("oops", { status: 500 }));
    await expect(
      sendChannelMessage(base, {
        protocol: "onebot11",
        scene: "group",
        peerId: "1",
        text: "x",
      }),
    ).rejects.toThrow(/500/);
  });
});

describe("channel action responses", () => {
  it.each([
    { status: "failed", retcode: 100, data: null },
    { status: "failed", data: null },
    { retcode: 1404, data: null },
  ])("rejects an HTTP 200 action failure: %j", async (result) => {
    const { base } = connectorWith(() => jsonResponse(result));
    await expect(
      sendChannelMessage(base, {
        protocol: "onebot11",
        scene: "group",
        peerId: "1",
        text: "done",
      }),
    ).rejects.toMatchObject({ name: "ChannelConnectorError" });
  });

  it("continues accepting asynchronous OneBot responses", async () => {
    const { base } = connectorWith(() =>
      jsonResponse({ status: "async", retcode: 1, data: null }),
    );
    await expect(
      sendChannelMessage(base, {
        protocol: "onebot11",
        scene: "group",
        peerId: "1",
        text: "done",
      }),
    ).resolves.toMatchObject({ protocol: "onebot11", peerId: "1" });
  });
});
