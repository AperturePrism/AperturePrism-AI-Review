import { describe, expect, it } from "vitest";
import {
  createOfficialQqTokenStore,
  normalizeOfficialQqMessage,
  officialQqAccessTokenRequest,
  officialQqSendMessageRequest,
  type OfficialQqDispatch,
} from "./officialqq.js";

describe("official QQ adapter", () => {
  it("normalizes a C2C dispatch to a private channel message", () => {
    const dispatch: OfficialQqDispatch = {
      op: 0,
      s: 42,
      t: "C2C_MESSAGE_CREATE",
      d: {
        id: "msg-1",
        content: "/analyze https://github.com/o/r/issues/7",
        timestamp: "2023-11-06T13:37:18+08:00",
        author: { user_openid: "U" },
      },
    };
    expect(normalizeOfficialQqMessage(dispatch)).toEqual({
      protocol: "officialqq",
      scene: "private",
      peerId: "U",
      senderId: "U",
      messageId: "oqq:msg-1",
      body: "/analyze https://github.com/o/r/issues/7",
      selfId: "42",
      time: Math.floor(Date.parse("2023-11-06T13:37:18+08:00") / 1000),
    });
  });

  it("normalizes a group @bot dispatch with a group peer", () => {
    const dispatch: OfficialQqDispatch = {
      op: 0,
      s: 7,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "msg-2",
        content: " /help",
        group_openid: "G",
        author: { member_openid: "M", member_role: "member" },
      },
    };
    const message = normalizeOfficialQqMessage(dispatch);
    expect(message?.scene).toBe("group");
    expect(message?.peerId).toBe("G");
    expect(message?.senderId).toBe("M");
    expect(message?.body).toBe("/help");
  });

  it("ignores non-dispatch payloads and empty content", () => {
    expect(normalizeOfficialQqMessage({ op: 1 })).toBeNull();
    expect(
      normalizeOfficialQqMessage({
        op: 0,
        t: "MESSAGE_CREATE",
        d: { id: "x", content: "" },
      }),
    ).toBeNull();
    expect(
      normalizeOfficialQqMessage({
        op: 0,
        t: "C2C_MESSAGE_CREATE",
        d: { content: "no id" },
      }),
    ).toBeNull();
  });

  it("builds the access token request", () => {
    expect(
      officialQqAccessTokenRequest({ appId: "A", clientSecret: "S" }),
    ).toEqual({
      url: "https://api.bot.qq.com/app/getAppAccessToken",
      body: { appId: "A", clientSecret: "S" },
    });
  });

  it("builds single and group message requests", () => {
    expect(
      officialQqSendMessageRequest({
        scene: "private",
        openid: "U",
        content: "hi",
      }),
    ).toEqual({
      url: "https://api.bot.qq.com/v2/users/U/messages",
      body: { content: "hi", msg_type: 0 },
    });
    expect(
      officialQqSendMessageRequest({
        scene: "group",
        openid: "G",
        content: "hi",
        msgId: "msg-1",
      }),
    ).toEqual({
      url: "https://api.bot.qq.com/v2/groups/G/messages",
      body: { content: "hi", msg_type: 0, msg_id: "msg-1" },
    });
  });
});

describe("official QQ access token store", () => {
  function storeWith(responses: Record<string, unknown>[]) {
    const calls: string[] = [];
    const tokenStore = createOfficialQqTokenStore({
      appId: "A",
      clientSecret: "S",
      now: () => 1_700_000_000_000,
      fetchImpl: (async (url) => {
        calls.push(String(url));
        const body = responses.shift() ?? {
          access_token: "t",
          expires_in: 7200,
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    return { tokenStore, calls };
  }

  it("caches the token until near expiry", async () => {
    const { tokenStore, calls } = storeWith([
      { access_token: "tok", expires_in: 7200 },
    ]);
    expect(await tokenStore.getToken()).toBe("tok");
    expect(await tokenStore.getToken()).toBe("tok");
    expect(calls).toHaveLength(1);
  });
});

describe("official QQ token refresh concurrency", () => {
  it("coalesces concurrent cold-cache and expired-cache refreshes", async () => {
    let calls = 0;
    let time = 1_700_000_000_000;
    const store = createOfficialQqTokenStore({
      appId: "A",
      clientSecret: "S",
      now: () => time,
      fetchImpl: (async () => {
        calls += 1;
        return new Response(
          JSON.stringify({ access_token: `token-${calls}`, expires_in: 7200 }),
        );
      }) as typeof fetch,
    });
    expect(
      await Promise.all(Array.from({ length: 10 }, () => store.getToken())),
    ).toEqual(Array(10).fill("token-1"));
    expect(calls).toBe(1);
    time += 7_200_000;
    expect(await Promise.all([store.getToken(), store.getToken()])).toEqual([
      "token-2",
      "token-2",
    ]);
    expect(calls).toBe(2);
  });

  it("shares refresh failures without preventing a later retry", async () => {
    let calls = 0;
    const store = createOfficialQqTokenStore({
      appId: "A",
      clientSecret: "S",
      fetchImpl: (async () => {
        calls += 1;
        return calls === 1
          ? new Response("unavailable", { status: 503 })
          : new Response(
              JSON.stringify({ access_token: "recovered", expires_in: 7200 }),
            );
      }) as typeof fetch,
    });
    const results = await Promise.allSettled([
      store.getToken(),
      store.getToken(),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(calls).toBe(1);
    expect(await store.getToken()).toBe("recovered");
    expect(calls).toBe(2);
  });
});
