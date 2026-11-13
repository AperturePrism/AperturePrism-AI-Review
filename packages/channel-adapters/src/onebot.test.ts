import { describe, expect, it } from "vitest";
import { normalizeOneBotMessage, oneBotSendPayload } from "./onebot.js";

describe("OneBot 11 adapter", () => {
  it("normalizes a group message and strips mentions", () => {
    const message = normalizeOneBotMessage({
      post_type: "message",
      message_type: "group",
      message_id: 123,
      group_id: 999,
      user_id: 42,
      self_id: 7,
      time: 1787013000,
      sender: { user_id: 42, card: "Alice" },
      message: [
        { type: "at", data: { qq: "7" } },
        {
          type: "text",
          data: { text: "/analyze https://github.com/o/r/issues/7" },
        },
      ],
    });

    expect(message).toEqual({
      protocol: "onebot11",
      scene: "group",
      peerId: "999",
      senderId: "42",
      messageId: "ob11:42:123",
      body: "/analyze https://github.com/o/r/issues/7",
      selfId: "7",
      time: 1787013000,
    });
  });

  it("normalizes a private message using the sender as the peer", () => {
    const message = normalizeOneBotMessage({
      post_type: "message",
      message_type: "private",
      sub_type: "friend",
      message_id: 55,
      user_id: 42,
      self_id: 7,
      time: 1,
      message: [{ type: "text", data: { text: "/help" } }],
    });
    expect(message?.scene).toBe("private");
    expect(message?.peerId).toBe("42");
    expect(message?.body).toBe("/help");
  });

  it("ignores non-message events and empty text", () => {
    expect(
      normalizeOneBotMessage({
        post_type: "notice",
        notice_type: "group_increase",
      }),
    ).toBeNull();
    expect(
      normalizeOneBotMessage({
        post_type: "message",
        message_type: "group",
        message_id: 1,
        group_id: 2,
        user_id: 3,
        self_id: 4,
        message: [{ type: "image", data: { file: "a.png" } }],
      }),
    ).toBeNull();
  });

  it("builds a group send payload with segments", () => {
    const payload = oneBotSendPayload({
      scene: "group",
      peerId: "999",
      text: "done",
    });
    expect(payload).toEqual({
      action: "send_group_msg",
      params: {
        group_id: 999,
        message: [{ type: "text", data: { text: "done" } }],
      },
    });
  });
});

describe("OneBot numeric event fields", () => {
  const event = {
    post_type: "message",
    message_type: "group",
    message_id: -123,
    group_id: 999,
    user_id: 42,
    self_id: 7,
    time: 1787013000,
    message: [{ type: "text", data: { text: "/status id" } }],
  };

  it.each(["message_id", "group_id", "user_id", "self_id"])(
    "rejects malformed %s instead of generating corrupt identities",
    (field) => {
      for (const value of [
        "",
        " ",
        "NaN",
        "Infinity",
        "0x10",
        "1e3",
        "12.5",
        1.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        "9007199254740993",
      ]) {
        expect(
          normalizeOneBotMessage({ ...event, [field]: value }),
          `${field}=${String(value)}`,
        ).toBeNull();
      }
    },
  );

  it("keeps decimal numeric strings and negative message ids", () => {
    expect(
      normalizeOneBotMessage({ ...event, message_id: "-123", user_id: "42" }),
    ).toMatchObject({
      senderId: "42",
      messageId: "ob11:42:-123",
    });
  });

  it("falls back to zero for a malformed optional timestamp", () => {
    expect(normalizeOneBotMessage({ ...event, time: "invalid" })?.time).toBe(0);
  });
});
