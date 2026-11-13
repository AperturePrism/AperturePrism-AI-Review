import { describe, expect, it } from "vitest";
import type { NormalizedChannelMessage } from "../../../packages/channel-adapters/src/index.js";
import {
  dispatchBotTurn,
  firstGitHubUrl,
  parseGitHubUrl,
} from "./dispatch.js";

function message(body: string): NormalizedChannelMessage {
  return {
    protocol: "onebot11",
    scene: "group",
    peerId: "999",
    senderId: "42",
    messageId: "m1",
    body,
    selfId: "7",
    time: 1,
  };
}

describe("QQ bot dispatch", () => {
  it("stays silent when the message is not a command", async () => {
    expect(await dispatchBotTurn(message("just chatting"), null)).toBeNull();
    expect(
      await dispatchBotTurn(message("just chatting"), null, () => "should not fire"),
    ).toBeNull();
  });

  it("returns the interactive help list", async () => {
    const reply = await dispatchBotTurn(message("x"), { kind: "help", raw: "" });
    expect(reply).toContain("/analyze");
    expect(reply).toContain("/status");
    expect(reply).toContain("/prism help");
    expect(reply).toContain("/repos");
    expect(reply).toContain("/logs");
    expect(reply).toContain("/settings");
  });

  it("acknowledges an analyze command with a GitHub link", async () => {
    const reply = await dispatchBotTurn(
      message("/analyze https://github.com/o/r/issues/7"),
      { kind: "analyze", raw: "https://github.com/o/r/issues/7" },
    );
    expect(reply).toContain("https://github.com/o/r/issues/7");
    expect(reply).toContain("尚未接入");
  });

  it("asks for a link or task id when none is provided", async () => {
    const review = await dispatchBotTurn(message("/review"), {
      kind: "review",
      raw: "",
    });
    expect(review).toContain("/review https://github.com/owner/repo/pull/123");

    const retried = await dispatchBotTurn(message("/retry"), {
      kind: "retry",
      raw: "",
    });
    expect(retried).toContain("/retry <任务ID>");

    const status = await dispatchBotTurn(message("/status"), {
      kind: "status",
      raw: "",
    });
    expect(status).toContain("/status <任务ID>");
  });

  it("lets an injected action override the default response", async () => {
    const reply = await dispatchBotTurn(
      message("/analyze https://github.com/o/r/issues/7"),
      { kind: "analyze", raw: "https://github.com/o/r/issues/7" },
      (_msg, command) => `wired:${command.raw}`,
    );
    expect(reply).toBe("wired:https://github.com/o/r/issues/7");
  });

  it("extracts the first GitHub url from arguments", () => {
    expect(firstGitHubUrl("see https://github.com/o/r/issues/7 now")).toBe(
      "https://github.com/o/r/issues/7",
    );
    expect(firstGitHubUrl("no link")).toBeNull();
  });

  it("parses GitHub issue/PR urls into owner / repo / number", () => {
    expect(parseGitHubUrl("https://github.com/Some/Repo/issues/123")).toEqual({
      owner: "Some",
      name: "Repo",
      number: 123,
    });
    expect(parseGitHubUrl("https://github.com/o/r/pull/99#discussion_r1")).toEqual({
      owner: "o",
      name: "r",
      number: 99,
    });
    expect(parseGitHubUrl("https://github.com/o/r")).toBeNull();
    expect(parseGitHubUrl("https://example.com/o/r/issues/1")).toBeNull();
  });
});
