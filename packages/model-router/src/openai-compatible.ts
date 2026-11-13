/**
 * OpenAI 协议：只翻译请求与供应商响应，重试与回退仍由模型路由拥有。
 * @example
 * createOpenAICompatibleAdapter({ provider: "gateway", baseUrl, resolveApiKey, stream: true });
 */
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
import { readOpenAIStream, type StreamReadOptions } from "./stream.js";
import { redactDiagnosticText } from "../../observability/src/redaction.js";

export type OpenAICompatibleOptions = {
  provider: string;
  baseUrl: string;
  /** Resolves the decrypted API key for an account, kept out of this module. */
  resolveApiKey: (accountName: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  /** 有些网关只可靠支持普通 JSON；流式协议因此显式开启。 */
  stream?: boolean;
  streamOptions?: Omit<StreamReadOptions, "signal">;
  maxResponseBytes?: number;
  /** 仅在受控排障环境使用；默认只保留状态码，避免网关回显提示词。 */
  includeErrorDetail?: boolean;
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
  if (
    message.role === "assistant" &&
    message.toolCalls &&
    message.toolCalls.length > 0
  ) {
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
        ...(tool.parameters === undefined
          ? {}
          : { parameters: tool.parameters }),
      },
    })),
    tool_choice: toolChoice ?? "auto",
  };
}

type ChatCompletionResponse = {
  choices?: {
    message?: {
      content?: unknown;
      /** reasoning 模型（deepseek-v4-pro 等）可能只回 reasoning_content 而 content 为空。 */
      reasoning_content?: unknown;
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
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

/** 普通 JSON 与错误页也限制大小，不能先读进内存再检查。 */
async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new ModelInvocationError(
      "invalid_output",
      "provider response exceeded its byte limit",
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const text: string[] = [];
  let bytes = 0;
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal.aborted)
        throw new ModelInvocationError(
          "canceled",
          "provider response read was canceled",
        );
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        throw new ModelInvocationError(
          "connection_failed",
          "provider response connection ended unexpectedly",
        );
      }
      if (signal.aborted)
        throw new ModelInvocationError(
          "canceled",
          "provider response read was canceled",
        );
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes)
        throw new ModelInvocationError(
          "invalid_output",
          "provider response exceeded its byte limit",
        );
      text.push(decoder.decode(chunk.value, { stream: true }));
    }
    text.push(decoder.decode());
    return text.join("");
  } finally {
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createOpenAICompatibleAdapter(
  options: OpenAICompatibleOptions,
): ModelProviderAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const parsedUrl = new URL(options.baseUrl);
  if (
    !["http:", "https:"].includes(parsedUrl.protocol) ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.search ||
    parsedUrl.hash
  )
    throw new RangeError(
      "provider baseUrl must be an HTTP URL without credentials, query, or fragment",
    );
  const maxResponseBytes = options.maxResponseBytes ?? 8_388_608;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1)
    throw new RangeError("maxResponseBytes must be a positive integer");
  const endpoint = `${options.baseUrl.replace(/\/$/, "")}/chat/completions`;

  return {
    provider: options.provider,
    invoke: async (
      candidate: ModelCandidate,
      request: ModelInvocationRequest,
      signal: AbortSignal,
    ): Promise<ModelInvocationResponse> => {
      if (signal.aborted)
        throw new ModelInvocationError("canceled", "invocation was canceled");
      const apiKey = await options.resolveApiKey(candidate.accountName);
      if (signal.aborted)
        throw new ModelInvocationError(
          "canceled",
          "invocation was canceled while resolving credentials",
        );

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
            ...(options.stream
              ? { stream: true, stream_options: { include_usage: true } }
              : {}),
            messages: request.messages.map(toWireMessage),
            ...(request.tools === undefined || request.tools.length === 0
              ? {}
              : toWireTools(request.tools, request.toolChoice)),
            ...(request.maxOutputTokens === undefined
              ? {}
              : { max_tokens: request.maxOutputTokens }),
            ...(request.temperature === undefined
              ? {}
              : { temperature: request.temperature }),
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
          error instanceof Error
            ? redactDiagnosticText(error.message)
            : "transport failure",
        );
      }

      if (!response.ok) {
        const body = await readBoundedBody(
          response,
          Math.min(maxResponseBytes, 65_536),
          signal,
        ).catch(() => "");
        if (signal.aborted)
          throw new ModelInvocationError(
            "canceled",
            "invocation was canceled while reading provider error",
          );
        const category =
          response.status === 400
            ? categorizeBadRequest(body)
            : categorizeStatus(response.status);
        const delay = retryAfterMs(response.headers);
        // 把网关真实返回（截断、压缩空白）带进错误消息，便于排查 5xx 是网关侧
        // 还是模型侧问题（deep 分析工具循环曾因字段名错误被网关 5xx 拒收）。
        const detail =
          options.includeErrorDetail && body.trim().length > 0
            ? ` — ${redactDiagnosticText(body.replace(/\s+/g, " ").trim(), 220)}`
            : "";
        throw new ModelInvocationError(
          category,
          `provider responded with ${response.status}${detail}`,
          ...(delay === undefined ? [] : [delay]),
        );
      }

      if (
        options.stream ||
        response.headers
          .get("content-type")
          ?.toLowerCase()
          .includes("text/event-stream")
      ) {
        return readOpenAIStream(response, {
          ...options.streamOptions,
          maxBytes: maxResponseBytes,
          signal,
        });
      }

      let parsed: ChatCompletionResponse;
      try {
        parsed = JSON.parse(
          await readBoundedBody(response, maxResponseBytes, signal),
        ) as ChatCompletionResponse;
      } catch (error) {
        if (signal.aborted)
          throw new ModelInvocationError(
            "canceled",
            "invocation was canceled while reading response",
          );
        if (error instanceof ModelInvocationError) throw error;
        throw new ModelInvocationError(
          "invalid_output",
          "provider response was not valid JSON",
        );
      }

      if (
        !parsed ||
        typeof parsed !== "object" ||
        !Array.isArray(parsed.choices)
      )
        throw new ModelInvocationError(
          "invalid_output",
          "provider response did not contain a choices array",
        );

      const message = parsed.choices?.[0]?.message;

      const toolCalls = Array.isArray(message?.tool_calls)
        ? message.tool_calls
            .filter((call) => call !== null && typeof call === "object")
            .map((call) => ({
              id: typeof call.id === "string" ? call.id : "",
              name:
                typeof call.function?.name === "string"
                  ? call.function.name
                  : "",
              arguments:
                typeof call.function?.arguments === "string"
                  ? call.function.arguments
                  : "{}",
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
      // reasoning 模型（deepseek-v4-pro 等）在推理 token 预算内可能把内容都写进
      // reasoning_content，而 content 为空（此前即触 invalid_output 空响应，issue
      // #72 / #226 / #17）。有 tool_calls 时忽略（正文在后续轮次产出）；
      // 否则用 reasoning_content 兜底，避免把模型已产出的判断误判为空响应。
      if (contentText.length === 0 && !hasToolCalls) {
        const reasoning = message?.reasoning_content;
        if (typeof reasoning === "string" && reasoning.trim().length > 0) {
          contentText = reasoning.trim();
        }
      }
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
