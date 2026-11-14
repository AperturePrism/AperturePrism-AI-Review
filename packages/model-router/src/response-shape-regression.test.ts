import { describe, expect, it } from "vitest";
import { createOpenAICompatibleAdapter } from "./openai-compatible.js";

const candidate = { provider: "test", model: "model", accountName: "account" };
const validCall = {
  id: "call_1",
  type: "function",
  function: { name: "read_file", arguments: "{}" },
};
function invoke(body: unknown) {
  return createOpenAICompatibleAdapter({
    provider: "test",
    baseUrl: "https://example.com/v1",
    resolveApiKey: async () => "test",
    fetchImpl: (async () => new Response(JSON.stringify(body))) as typeof fetch,
  }).invoke(candidate, { messages: [] }, new AbortController().signal);
}

describe("provider response shape", () => {
  it.each([null, [], 3, "string"])(
    "classifies invalid root %j as invalid_output",
    async (body) => {
      await expect(invoke(body)).rejects.toMatchObject({
        name: "ModelInvocationError",
        category: "invalid_output",
      });
    },
  );

  it.each([
    null,
    { ...validCall, id: "" },
    { function: { name: "read_file", arguments: "{}" } },
    { ...validCall, function: null },
    { ...validCall, function: { name: "read_file", arguments: 123 } },
  ])("rejects malformed tool call %j even alongside text", async (call) => {
    await expect(
      invoke({
        choices: [{ message: { content: "partial", tool_calls: [call] } }],
      }),
    ).rejects.toMatchObject({
      name: "ModelInvocationError",
      category: "invalid_output",
    });
  });

  it("preserves valid tool-only completions", async () => {
    const result = await invoke({
      choices: [{ message: { content: null, tool_calls: [validCall] } }],
    });
    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "read_file", arguments: "{}" },
    ]);
  });
});
