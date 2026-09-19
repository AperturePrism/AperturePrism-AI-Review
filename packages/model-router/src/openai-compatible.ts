import {
  ModelInvocationError,
  type ModelCandidate,
  type ModelErrorCategory,
  type ModelInvocationRequest,
  type ModelInvocationResponse,
  type ModelMessage,
  type ModelProviderAdapter,
  type ModelToolSpec,
} from "../../../packages/domain/src/index.js";

export type OpenAICompatibleOptions = {
  provider: string;
  baseUrl: string;
  /** Resolves the decrypted API key for an account, kept out of this module. */
  resolveApiKey: (accountName: string) => Promise<string>;
  fetchImpl?: typeof fetch;
};

/**
 * 把内部 Message（驼峰 toolCalls/toolCallId）转换成 OpenAI 协议字段
 * （蛇形 tool_calls / tool_call_id）。此前直接透传，导致工具循环的第二轮起
 * （assistant 携带 tool_calls、tool 消息携带 tool_call_id）字段名不被网关识别，
 * 网关返回 5xx → deep 分析（读源码）恒失败（issue #30 的拦路石）。
 */
function toWireContent(message: ModelMessage): unknown {
  // 多模态：有图片块时把纯文本 content 与图片拼成 OpenAI content 数组。
  // 无图片时维持纯字符串，避免改变既有文本请求的报文结构。
  if (message.imageParts && message.imageParts.length > 0) {
    return [
      { type: "text", text: message.content },
      ...message.imageParts.map((part) => ({
        type: "image_url",
        image_url: { url: part.image_url.url },
      })),
    ];
  }
  return message.content;
}

function toWireMessage(message: ModelMessage): Record<string, unknown> {
  const base: Record<string, unknown> = {
    role: message.role,
    content: toWireContent(message),
  };
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    base.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  if (message.role === "tool" && message.toolCallId) {
    base.tool_call_id = message.toolCallId;
  }
  return base;
}

/**
 * 序列化工具定义到 OpenAI wire 格式。内部 ModelToolSpec 只含
 * name/description/parameters；网关（MiniMax 等）要求 tools[i].type
 * 必须为 "function"，缺失时返回 invalid tool type 400（issue #71/#73），
 * 因此这里统一补上，同时补 tool_choice 缺省 auto。
 */
function toWireTools(
  tools: readonly ModelToolSpec[],
  toolChoice: ModelInvocationRequest["toolChoice"],
): Record<string, unknown> {
  return {
    tools: tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
      },
    })),
    tool_choice: toolChoice ?? "auto",
  };
}

type ChatCompletionResponse = {
  choices?: {
    message?: {
      content?: unknown;
      tool_calls?: {
        id?: unknown;
        type?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      }[];
    };
  }[];
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  };
};

/**
 * Maps transport and protocol failures onto the shared categories. Retry and
 * fallback decisions belong to the router, never to this adapter.
 */
function categorizeStatus(status: number): ModelErrorCategory {
  if (status === 401 || status === 403) return "authentication_failed";
  if (status === 404) return "model_not_found";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "unknown";
}

function retryAfterMs(headers: Headers): number | undefined {
  const header = headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * Context-overflow arrives as a 400 that only the body distinguishes, so the
 * message is inspected without ever echoing prompt content back to callers.
 */
function categorizeBadRequest(body: string): ModelErrorCategory {
  const normalized = body.toLowerCase();
  if (
    normalized.includes("context length") ||
    normalized.includes("context_length") ||
    normalized.includes("maximum context") ||
    normalized.includes("too many tokens")
  ) {
    return "context_overflow";
  }
  if (normalized.includes("model") && normalized.includes("not found"))
    return "model_not_found";
  return "unknown";
}

function integerOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

export function createOpenAICompatibleAdapter(
  options: OpenAICompatibleOptions,
): ModelProviderAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/$/, "")}/chat/completions`;

  return {
    provider: options.provider,
    invoke: async (
      candidate: ModelCandidate,
      request: ModelInvocationRequest,
      signal: AbortSignal,
    ): Promise<ModelInvocationResponse> => {
      const apiKey = await options.resolveApiKey(candidate.accountName);

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: candidate.model,
            messages: request.messages.map(toWireMessage),
            ...(request.tools === undefined || request.tools.length === 0
              ? {}
              : toWireTools(request.tools, request.toolChoice)),
            ...(request.maxOutputTokens === undefined
              ? {}
              : { max_tokens: request.maxOutputTokens }),
            ...(request.temperature === undefined
              ? {} : { temperature: request.temperature }),
            // response_format is deliberately NOT sent. The newapi gateway
            // times out / 401s / 429s on any request carrying
            // `response_format: json_object` while the same prompt without it
            // returns clean JSON reliably. The prompts already mandate a pure
            // JSON object and the server validates with zod + a bounded
            // repair, so skipping response_format keeps JSON guarantees
            // without tripping the gateway.
          }),
          signal,
        });
      } catch (error) {
        if (signal.aborted)
          throw new ModelInvocationError("canceled", "invocation was canceled");
        throw new ModelInvocationError(
          "connection_failed",
          error instanceof Error ? error.message : "transport failure",
        );
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const category =
          response.status === 400
            ? categorizeBadRequest(body)
            : categorizeStatus(response.status);
        const delay = retryAfterMs(response.headers);
        // 把网关真实返回（截断、压缩空白）带进错误消息，便于排查 5xx 是网关侧
        // 还是模型侧问题（deep 分析工具循环曾因字段名错误被网关 5xx 拒收）。
        const detail =
          body.trim().length > 0
            ? ` — ${body.slice(0, 220).replace(/\s+/g, " ").trim()}`
            : "";
        throw new ModelInvocationError(
          category,
          `provider responded with ${response.status}${detail}`,
          ...(delay === undefined ? [] : [delay]),
        );
      }

      let parsed: ChatCompletionResponse;
      try {
        parsed = (await response.json()) as ChatCompletionResponse;
      } catch {
        throw new ModelInvocationError(
          "invalid_output",
          "provider response was not valid JSON",
        );
      }

      const message = parsed.choices?.[0]?.message;

      const toolCalls = Array.isArray(message?.tool_calls)
        ? message.tool_calls
            .map((call) => ({
              id: typeof call.id === "string" ? call.id : "",
              name: typeof call.function?.name === "string" ? call.function.name : "",
              arguments: typeof call.function?.arguments === "string" ? call.function.arguments : "{}",
            }))
            .filter((call) => call.name !== "")
        : undefined;

      // content 可能是字符串、null（纯工具调用）或数组（OpenAI 多模态分段）。
      let contentText = "";
      const rawContent = message?.content;
      if (typeof rawContent === "string") contentText = rawContent;
      else if (Array.isArray(rawContent)) {
        contentText = rawContent
          .map((part) =>
            typeof part === "object" &&
            part !== null &&
            typeof (part as { text?: unknown }).text === "string"
              ? ((part as { text: string }).text as string)
              : "",
          )
          .join("");
      }

      const hasToolCalls = toolCalls !== undefined && toolCalls.length > 0;
      if (contentText.length === 0 && !hasToolCalls)
        throw new ModelInvocationError(
          "invalid_output",
          "provider response did not contain message content",
        );

      return {
        content: contentText,
        usage: {
          inputTokens: integerOrZero(parsed.usage?.prompt_tokens),
          outputTokens: integerOrZero(parsed.usage?.completion_tokens),
        },
        ...(hasToolCalls ? { toolCalls } : {}),
      };
    },
  };
}
