/** SSE 协议边界测试：每个字节都可成为一次网络分片。 */
import { describe, expect, it } from "vitest";
import { ServerSentEventReader, readOpenAIStream } from "./stream.js";

const encoder = new TextEncoder();
function event(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}
function delta(content: unknown) {
  return { choices: [{ index: 0, delta: { content } }] };
}
function responseFrom(bytes: Uint8Array[], onCancel?: () => void): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of bytes) controller.enqueue(chunk);
        controller.close();
      },
      cancel() {
        onCancel?.();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
function responseText(text: string) {
  return responseFrom([encoder.encode(text)]);
}

describe("SSE line boundaries", () => {
  it("joins multiline data and persists id while resetting event type", () => {
    const parser = new ServerSentEventReader();
    expect(
      parser.push(
        ": keepalive\r\nid: 7\r\nevent: chunk\r\ndata: one\r\ndata: two\r\n\r\ndata: three\n\n",
      ),
    ).toEqual([
      { id: "7", event: "chunk", data: "one\ntwo" },
      { id: "7", event: "message", data: "three" },
    ]);
  });

  it("accepts bare CR and CRLF split across chunks without inserting empty events", () => {
    const parser = new ServerSentEventReader();
    expect(parser.push("data: one\r")).toEqual([]);
    expect(parser.push("\n\r")).toEqual([]);
    expect(parser.push("\ndata: two\r\r")).toEqual([
      { event: "message", data: "one", id: null },
    ]);
    expect(parser.finish()).toEqual([
      { event: "message", data: "two", id: null },
    ]);
  });

  it("ignores invalid id values and unsupported fields", () => {
    const parser = new ServerSentEventReader();
    expect(
      parser.push("id: bad\0id\nretry: 1000\nunknown: ignored\ndata: ok\n\n"),
    ).toEqual([{ event: "message", data: "ok", id: null }]);
  });

  it("enforces limits both for accumulated lines and an unfinished long line", () => {
    expect(() =>
      new ServerSentEventReader(10).push("data: a really long line"),
    ).toThrow("byte limit");
    const parser = new ServerSentEventReader(20);
    parser.push("data: one\n");
    expect(() => parser.push("data: two\ndata: three\n")).toThrow("byte limit");
  });
});

describe("OpenAI streamed completion", () => {
  it("decodes Chinese and emoji correctly for every possible two-part byte split", async () => {
    const source = encoder.encode(
      event(delta("你好🐾")) +
        event({
          choices: [],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        }) +
        "data: [DONE]\n\n",
    );
    for (let split = 1; split < source.length; split += 1) {
      const result = await readOpenAIStream(
        responseFrom([source.slice(0, split), source.slice(split)]),
      );
      expect(result).toEqual({
        content: "你好🐾",
        usage: { inputTokens: 12, outputTokens: 3 },
      });
    }
  });

  it("also works when every byte arrives separately and publishes only content deltas", async () => {
    const source = encoder.encode(
      event(delta("你")) + event(delta("好")) + "data: [DONE]\n\n",
    );
    const parts: string[] = [];
    const result = await readOpenAIStream(
      responseFrom([...source].map((byte) => new Uint8Array([byte]))),
      { onText: (part) => parts.push(part) },
    );
    expect(parts).toEqual(["你", "好"]);
    expect(result.content).toBe("你好");
  });

  it("merges fragmented and interleaved tool calls in index order", async () => {
    const source =
      event({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: "call_b",
                  function: { name: "search", arguments: '{"q":' },
                },
                {
                  index: 0,
                  id: "call_a",
                  function: { name: "read", arguments: '{"path":' },
                },
              ],
            },
          },
        ],
      }) +
      event({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '"a.ts"}' } },
                { index: 1, function: { arguments: '"bug"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }) +
      "data: [DONE]\n\n";
    expect((await readOpenAIStream(responseText(source))).toolCalls).toEqual([
      { id: "call_a", name: "read", arguments: '{"path":"a.ts"}' },
      { id: "call_b", name: "search", arguments: '{"q":"bug"}' },
    ]);
  });

  it("uses reasoning only when no final content or tool call was supplied", async () => {
    const reasoning = event({
      choices: [{ delta: { reasoning_content: "fallback" } }],
    });
    expect(
      (await readOpenAIStream(responseText(reasoning + "data: [DONE]\n\n")))
        .content,
    ).toBe("fallback");
    expect(
      (
        await readOpenAIStream(
          responseText(reasoning + event(delta("final")) + "data: [DONE]\n\n"),
        )
      ).content,
    ).toBe("final");
  });

  it("requires DONE and does not publish a silently truncated response", async () => {
    await expect(
      readOpenAIStream(responseText(event(delta("partial")))),
    ).rejects.toMatchObject({ category: "invalid_output" });
    expect(
      (
        await readOpenAIStream(responseText(event(delta("partial"))), {
          requireDone: false,
        })
      ).content,
    ).toBe("partial");
  });

  it("does not accept data arriving after DONE", async () => {
    const source =
      event(delta("complete")) +
      "data: [DONE]\n\n" +
      event(delta("malicious trailing text"));
    expect((await readOpenAIStream(responseText(source))).content).toBe(
      "complete",
    );
  });

  it("rejects malformed JSON, invalid UTF-8 and oversize content", async () => {
    await expect(
      readOpenAIStream(responseText("data: {broken}\n\n")),
    ).rejects.toMatchObject({ category: "invalid_output" });
    await expect(
      readOpenAIStream(responseFrom([new Uint8Array([0xff, 0xfe])])),
    ).rejects.toMatchObject({ category: "invalid_output" });
    await expect(
      readOpenAIStream(responseText(event(delta("too long"))), { maxBytes: 8 }),
    ).rejects.toMatchObject({ category: "invalid_output" });
  });

  it("rejects upstream error events without copying their sensitive body", async () => {
    try {
      await readOpenAIStream(
        responseText(event({ error: { message: "secret source code" } })),
      );
      throw new Error("expected stream failure");
    } catch (error) {
      expect(error).toMatchObject({ category: "server_error" });
      expect(String(error)).not.toContain("secret source");
    }
  });

  it("rejects incomplete tool identities, absurd tool indexes and token truncation", async () => {
    for (const source of [
      event({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { name: "read" } }] } },
        ],
      }) + "data: [DONE]\n\n",
      event({
        choices: [{ delta: { tool_calls: [{ index: 1_000, id: "a" }] } }],
      }) + "data: [DONE]\n\n",
      event({
        choices: [{ delta: { content: "partial" }, finish_reason: "length" }],
      }) + "data: [DONE]\n\n",
    ])
      await expect(
        readOpenAIStream(responseText(source)),
      ).rejects.toMatchObject({ category: "invalid_output" });
  });

  it("cancels a waiting reader immediately when the caller aborts", async () => {
    let canceled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          canceled = true;
        },
      }),
    );
    const controller = new AbortController();
    const reading = readOpenAIStream(response, { signal: controller.signal });
    const rejected = expect(reading).rejects.toMatchObject({
      category: "canceled",
    });
    controller.abort();
    await rejected;
    expect(canceled).toBe(true);
  });

  it("reads usage from the final empty-choices chunk and ignores negative counters", async () => {
    const source =
      event(delta("ok")) +
      event({
        choices: [],
        usage: { prompt_tokens: -1, completion_tokens: 8 },
      }) +
      "data: [DONE]\n\n";
    expect((await readOpenAIStream(responseText(source))).usage).toEqual({
      inputTokens: 0,
      outputTokens: 8,
    });
  });
});
