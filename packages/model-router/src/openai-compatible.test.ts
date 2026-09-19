import { describe, expect, it } from "vitest";
import {
  ModelInvocationError,
  type ModelCandidate,
  type ModelInvocationRequest,
} from "../../../packages/domain/src/index.js";
import { createOpenAICompatibleAdapter } from "./openai-compatible.js";

const candidate: ModelCandidate = {
  provider: "openai-compatible",
  model: "test-model",
  accountName: "account-a",
};

const request: ModelInvocationRequest = {
  messages: [{ role: "user", content: "analyze" }],
  responseFormat: "json",
};

type FetchCall = { url: string; init: RequestInit };

function adapterWith(
  responder: (call: FetchCall) => Promise<Response> | Response,
) {
  const calls: FetchCall[] = [];
  const adapter = createOpenAICompatibleAdapter({
    provider: "openai-compatible",
    baseUrl: "https://models.example/v1/",
    resolveApiKey: async () => "secret-api-key",
    fetchImpl: (async (url, init) => {
      const call = { url: String(url), init: init ?? {} };
      calls.push(call);
      return responder(call);
    }) as typeof fetch,
  });
  return { adapter, calls };
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function completion(content: string) {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 12, completion_tokens: 7 },
  };
}

async function categoryOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ModelInvocationError);
    return (error as ModelInvocationError).category;
  }
  throw new Error("expected the invocation to fail");
}

describe("OpenAI-compatible adapter requests", () => {
  it("posts to the chat completions endpoint with the resolved key", async () => {
    const { adapter, calls } = adapterWith(() =>
      jsonResponse(completion("{}")),
    );
    const result = await adapter.invoke(
      candidate,
      request,
      new AbortController().signal,
    );

    expect(calls[0]?.url).toBe("https://models.example/v1/chat/completions");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret-api-key");
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<
      string,
      unknown
    >;
    expect(body.model).toBe("test-model");
    // response_format is never sent: the newapi gateway chokes on
    // `json_object` while the same prompt returns clean JSON without it.
    expect(body).not.toHaveProperty("response_format");
    expect(result).toEqual({
      content: "{}",
      usage: { inputTokens: 12, outputTokens: 7 },
    });
  });

  it("omits optional tuning fields when the caller does not set them", async () => {
    const { adapter, calls } = adapterWith(() =>
      jsonResponse(completion("ok")),
    );
    await adapter.invoke(
      candidate,
      { messages: request.messages },
      new AbortController().signal,
    );
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<
      string,
      unknown
    >;
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("response_format");
  });
});

describe("OpenAI-compatible adapter error mapping", () => {
  it("maps HTTP statuses to standard categories", async () => {
    const cases: [number, string][] = [
      [401, "authentication_failed"],
      [403, "authentication_failed"],
      [404, "model_not_found"],
      [408, "timeout"],
      [429, "rate_limited"],
      [500, "server_error"],
      [503, "server_error"],
      [418, "unknown"],
    ];

    for (const [status, expected] of cases) {
      const { adapter } = adapterWith(
        () => new Response("failure", { status }),
      );
      expect(
        await categoryOf(
          adapter.invoke(candidate, request, new AbortController().signal),
        ),
      ).toBe(expected);
    }
  });

  it("extracts Retry-After as milliseconds", async () => {
    const { adapter } = adapterWith(
      () =>
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "3" },
        }),
    );
    try {
      await adapter.invoke(candidate, request, new AbortController().signal);
      throw new Error("expected a rate limit failure");
    } catch (error) {
      expect((error as ModelInvocationError).retryAfterMs).toBe(3_000);
    }
  });

  it("distinguishes context overflow from other bad requests", async () => {
    const overflow = adapterWith(
      () =>
        new Response(
          JSON.stringify({
            error: { message: "This model's maximum context length is 8192" },
          }),
          { status: 400 },
        ),
    );
    const other = adapterWith(
      () =>
        new Response(JSON.stringify({ error: "bad field" }), { status: 400 }),
    );

    expect(
      await categoryOf(
        overflow.adapter.invoke(
          candidate,
          request,
          new AbortController().signal,
        ),
      ),
    ).toBe("context_overflow");
    expect(
      await categoryOf(
        other.adapter.invoke(candidate, request, new AbortController().signal),
      ),
    ).toBe("unknown");
  });

  it("reports transport failures and cancellation distinctly", async () => {
    const broken = adapterWith(() => {
      throw new Error("ECONNRESET");
    });
    expect(
      await categoryOf(
        broken.adapter.invoke(candidate, request, new AbortController().signal),
      ),
    ).toBe("connection_failed");

    const controller = new AbortController();
    const canceled = adapterWith(() => {
      controller.abort();
      throw new Error("aborted");
    });
    expect(
      await categoryOf(
        canceled.adapter.invoke(candidate, request, controller.signal),
      ),
    ).toBe("canceled");
  });

  it("rejects malformed and empty completions as invalid output", async () => {
    const notJson = adapterWith(() => new Response("<html>", { status: 200 }));
    const noContent = adapterWith(() => jsonResponse({ choices: [] }));
    const emptyContent = adapterWith(() => jsonResponse(completion("")));

    for (const { adapter } of [notJson, noContent, emptyContent]) {
      expect(
        await categoryOf(
          adapter.invoke(candidate, request, new AbortController().signal),
        ),
      ).toBe("invalid_output");
    }
  });

  it("defaults missing usage counters to zero", async () => {
    const { adapter } = adapterWith(() =>
      jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    );
    const result = await adapter.invoke(
      candidate,
      request,
      new AbortController().signal,
    );
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("OpenAI-compatible adapter tool calling", () => {
  it("forwards tools in the request body", async () => {
    const { adapter, calls } = adapterWith(() =>
      jsonResponse(completion("done")),
    );
    const toolRequest: ModelInvocationRequest = {
      messages: [{ role: "user", content: "use a tool" }],
      tools: [
        {
          name: "read_file",
          description: "read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
    };
    await adapter.invoke(candidate, toolRequest, new AbortController().signal);
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<
      string,
      unknown
    >;
    expect(Array.isArray(body.tools)).toBe(true);
    expect((body.tools as { name: string }[])[0]?.name).toBe("read_file");
    // MiniMax 网关要求带 tools 时必须同时带 tool_choice（issue #71/#73）。
    expect(body.tool_choice).toBe("auto");
  });

  it("honors an explicit toolChoice instead of the auto default", async () => {
    const { adapter, calls } = adapterWith(() =>
      jsonResponse(completion("done")),
    );
    const toolRequest: ModelInvocationRequest = {
      messages: [{ role: "user", content: "use a tool" }],
      tools: [{ name: "read_file", description: "read a file" }],
      toolChoice: "required",
    };
    await adapter.invoke(candidate, toolRequest, new AbortController().signal);
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<
      string,
      unknown
    >;
    expect(body.tool_choice).toBe("required");
  });

  it("omits tools when the request has none", async () => {
    const { adapter, calls } = adapterWith(() =>
      jsonResponse(completion("done")),
    );
    await adapter.invoke(candidate, request, new AbortController().signal);
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<
      string,
      unknown
    >;
    expect(body).not.toHaveProperty("tools");
  });

  it("serializes toolCalls/toolCallId into the OpenAI snake_case wire format", async () => {
    // 回归（#30）：此前直接透传驼峰字段（toolCalls / toolCallId），工具循环的
    // 第二轮起网关不识别这些字段名返回 5xx，deep 分析（读源码）恒失败。
    const { adapter, calls } = adapterWith(() =>
      jsonResponse(completion("final")),
    );
    const toolLoopRequest: ModelInvocationRequest = {
      messages: [
        { role: "user", content: "look" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' },
          ],
        },
        {
          role: "tool",
          content: "file contents",
          toolCallId: "call_1",
        },
      ],
      tools: [
        {
          name: "read_file",
          description: "read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
    };
    await adapter.invoke(
      candidate,
      toolLoopRequest,
      new AbortController().signal,
    );
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      messages: Record<string, unknown>[];
    };
    const assistant = body.messages[1];
    expect(assistant).toBeDefined();
    const tool = body.messages[2];
    expect(tool).toBeDefined();
    if (!assistant || !tool) return;
    expect(assistant.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"a.ts"}' },
      },
    ]);
    // 内部驼峰字段绝不能再出现在请求体里。
    expect(assistant).not.toHaveProperty("toolCalls");
    expect(tool.tool_call_id).toBe("call_1");
    expect(tool).not.toHaveProperty("toolCallId");
  });

  it("parses tool_calls when content is null", async () => {
    const { adapter } = adapterWith(() =>
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "read_file", arguments: '{"path":"a.ts"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
    );
    const result = await adapter.invoke(
      candidate,
      request,
      new AbortController().signal,
    );
    expect(result.content).toBe("");
    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' },
    ]);
  });

  it("joins array content into text", async () => {
    const { adapter } = adapterWith(() =>
      jsonResponse({
        choices: [
          {
            message: {
              content: [
                { type: "text", text: "part-a" },
                { type: "text", text: "part-b" },
              ],
            },
          },
        ],
        usage: {},
      }),
    );
    const result = await adapter.invoke(
      candidate,
      request,
      new AbortController().signal,
    );
    expect(result.content).toBe("part-apart-b");
  });
});
