import { describe, expect, it } from "vitest";
import { parseBotCommand } from "./command.js";

describe("bot command parser", () => {
  it("parses each supported command from the first non-empty line", () => {
    expect(parseBotCommand("/analyze https://github.com/o/r/issues/7")).toEqual(
      {
        kind: "analyze",
        raw: "https://github.com/o/r/issues/7",
      },
    );
    expect(parseBotCommand("/review https://github.com/o/r/pull/8")).toEqual({
      kind: "review",
      raw: "https://github.com/o/r/pull/8",
    });
    expect(parseBotCommand("/retry https://github.com/o/r/issues/7")).toEqual({
      kind: "retry",
      raw: "https://github.com/o/r/issues/7",
    });
    expect(
      parseBotCommand("/status 123e4567-e89b-12d3-a456-426614174000"),
    ).toEqual({
      kind: "status",
      raw: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(parseBotCommand("/prism help")).toEqual({ kind: "help", raw: "" });
    expect(parseBotCommand("/prism")).toEqual({ kind: "help", raw: "" });
    expect(parseBotCommand("/repos")).toEqual({ kind: "repos", raw: "" });
    expect(parseBotCommand("/repo owner/name")).toEqual({
      kind: "repo",
      raw: "owner/name",
    });
    expect(parseBotCommand("/logs 20")).toEqual({ kind: "logs", raw: "20" });
    expect(parseBotCommand("/scan")).toEqual({ kind: "scan", raw: "" });
    expect(parseBotCommand("/settings owner/name")).toEqual({
      kind: "settings",
      raw: "owner/name",
    });
  });

  it("ignores leading blank lines and requires the command on the first content line", () => {
    expect(parseBotCommand("\n\n/analyze x")).toEqual({
      kind: "analyze",
      raw: "x",
    });
    expect(parseBotCommand("hello\n/analyze x")).toBeNull();
  });

  it("ignores commands inside code fences", () => {
    const text = "```\n/analyze https://github.com/o/r/issues/7\n```";
    expect(parseBotCommand(text)).toBeNull();
  });

  it("ignores commands inside blockquotes", () => {
    expect(
      parseBotCommand("> /analyze https://github.com/o/r/issues/7\n"),
    ).toBeNull();
  });

  it("returns null for non-commands and unknown slash commands", () => {
    expect(parseBotCommand("just a message")).toBeNull();
    expect(parseBotCommand("/unknown")).toBeNull();
    expect(parseBotCommand("")).toBeNull();
  });
});

describe("bot command registry boundaries", () => {
  it.each(["/constructor", "/__proto__", "/toString", "/valueOf"])(
    "ignores inherited object property %s",
    (text) => {
      expect(parseBotCommand(text)).toBeNull();
    },
  );
});
