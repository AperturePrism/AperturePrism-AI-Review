/**
 * 流式响应：按字节边界读取 SSE，合并文字、工具参数和最终用量。
 *
 * @example
 * const response = await fetch(url, { ...init, signal });
 * const result = await readOpenAIStream(response, { signal, onText: (text) => stdout.write(text) });
 *
 * UTF-8 字符、CRLF、JSON 与工具参数都允许被网络拆在任意两块之间。
 * 默认要求 [DONE]；连接中途断开不能被当成完整的审查结果发布。
 */
import {
  ModelInvocationError,
  type ModelInvocationResponse,
  type ModelToolCall,
} from "../../domain/src/index.js";

export type ServerSentEvent = {
  event: string;
  data: string;
  id: string | null;
};

export type StreamReadOptions = {
  signal?: AbortSignal;
  maxBytes?: number;
  maxEventBytes?: number;
  maxToolCalls?: number;
  requireDone?: boolean;
  allowTruncated?: boolean;
  onText?: (text: string) => void;
};

/** SSE 文本解析器只关心协议边界，模型字段由 readOpenAIStream 负责。 */
export class ServerSentEventReader {
  private buffer = "";
  private data: string[] = [];
  private event = "message";
  private id: string | null = null;
  private eventBytes = 0;
  private readonly maxEventBytes: number;

  constructor(maxEventBytes = 1_048_576) {
    if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes < 1)
      throw new RangeError("maxEventBytes must be a positive integer");
    this.maxEventBytes = maxEventBytes;
  }

  /** 传入解码后的新片段；最后一块用 finish 处理没有换行的末尾。 */
  push(text: string): ServerSentEvent[] {
    this.buffer += text;
    const result: ServerSentEvent[] = [];
    while (true) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) break;
      if (match[0] === "\r" && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const event = this.line(line);
      if (event) result.push(event);
    }
    if (this.eventBytes + Buffer.byteLength(this.buffer) > this.maxEventBytes)
      throw invalid("SSE event exceeded its byte limit");
    return result;
  }

  /** EOF 可处理最后一行，但不会凭空产生没有空行结束的事件。 */
  finish(): ServerSentEvent[] {
    const result = this.push("\n");
    this.buffer = "";
    return result;
  }

  private line(line: string): ServerSentEvent | null {
    if (line === "") {
      const event =
        this.data.length > 0
          ? { event: this.event, data: this.data.join("\n"), id: this.id }
          : null;
      this.data = [];
      this.event = "message";
      this.eventBytes = 0;
      return event;
    }
    this.eventBytes += Buffer.byteLength(line) + 1;
    if (this.eventBytes > this.maxEventBytes)
      throw invalid("SSE event exceeded its byte limit");
    if (line.startsWith(":")) return null; // 保活注释不能作为模型正文。
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    if (field === "event") this.event = value;
    if (field === "id" && !value.includes("\0")) this.id = value;
    return null;
  }
}

function invalid(message: string): ModelInvocationError {
  return new ModelInvocationError("invalid_output", message);
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (!Array.isArray(value))
    throw invalid("stream content must be text or content parts");
  return value
    .map((part: unknown) => {
      const item = object(part);
      return item && typeof item.text === "string" ? item.text : "";
    })
    .join("");
}

type StreamState = {
  content: string[];
  reasoning: string[];
  tools: Map<number, ModelToolCall>;
  inputTokens: number;
  outputTokens: number;
  done: boolean;
  finishReason: string | null;
};

function readEvent(
  event: ServerSentEvent,
  state: StreamState,
  options: StreamReadOptions,
): void {
  if (state.done) return;
  if (event.data.trim() === "[DONE]") {
    state.done = true;
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(event.data);
  } catch {
    throw invalid("stream event was not valid JSON");
  }
  const chunk = object(value);
  if (!chunk) throw invalid("stream chunk must be an object");
  if (event.event === "error" || chunk.error !== undefined)
    throw new ModelInvocationError(
      "server_error",
      "provider sent a stream error",
    );
  const usage = object(chunk.usage);
  if (usage) {
    const input = validCount(usage.prompt_tokens);
    const output = validCount(usage.completion_tokens);
    if (input !== null) state.inputTokens = input;
    if (output !== null) state.outputTokens = output;
  }
  if (!Array.isArray(chunk.choices)) return; // 用量/心跳 chunk 可以不带正文。
  for (const choiceValue of chunk.choices) {
    const choice = object(choiceValue);
    if (!choice || (choice.index !== undefined && choice.index !== 0)) continue;
    if (typeof choice.finish_reason === "string")
      state.finishReason = choice.finish_reason;
    const delta = object(choice.delta);
    if (!delta) continue;
    const content = textContent(delta.content);
    if (content) {
      state.content.push(content);
      options.onText?.(content);
    }
    if (typeof delta.reasoning_content === "string")
      state.reasoning.push(delta.reasoning_content);
    if (!Array.isArray(delta.tool_calls)) continue;
    for (const callValue of delta.tool_calls) {
      const call = object(callValue);
      const index = validCount(call?.index);
      if (!call || index === null || index >= (options.maxToolCalls ?? 128))
        throw invalid("stream tool index is outside its limit");
      const previous = state.tools.get(index) ?? {
        id: "",
        name: "",
        arguments: "",
      };
      const definition = object(call.function);
      if (typeof call.id === "string") previous.id += call.id;
      if (typeof definition?.name === "string")
        previous.name += definition.name;
      if (typeof definition?.arguments === "string")
        previous.arguments += definition.arguments;
      state.tools.set(index, previous);
    }
  }
}

/** 读取并校验 OpenAI chat/completions SSE，工具参数直到完成后才交给调用者。 */
export async function readOpenAIStream(
  response: Response,
  options: StreamReadOptions = {},
): Promise<ModelInvocationResponse> {
  if (!response.body) throw invalid("provider stream did not contain a body");
  const maxBytes = options.maxBytes ?? 8_388_608;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new RangeError("maxBytes must be a positive integer");
  if (
    options.maxToolCalls !== undefined &&
    (!Number.isSafeInteger(options.maxToolCalls) || options.maxToolCalls < 1)
  )
    throw new RangeError("maxToolCalls must be a positive integer");
  const reader = response.body.getReader();
  const events = new ServerSentEventReader(options.maxEventBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const state: StreamState = {
    content: [],
    reasoning: [],
    tools: new Map(),
    inputTokens: 0,
    outputTokens: 0,
    done: false,
    finishReason: null,
  };
  let bytes = 0;
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (options.signal?.aborted)
      throw new ModelInvocationError(
        "canceled",
        "provider stream was canceled",
      );
    while (!state.done) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        throw new ModelInvocationError(
          "connection_failed",
          "provider stream connection ended unexpectedly",
        );
      }
      if (options.signal?.aborted)
        throw new ModelInvocationError(
          "canceled",
          "provider stream was canceled",
        );
      if (chunk.done) {
        for (const event of events.push(decoder.decode()))
          readEvent(event, state, options);
        for (const event of events.finish()) readEvent(event, state, options);
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes)
        throw invalid("provider stream exceeded its byte limit");
      for (const event of events.push(
        decoder.decode(chunk.value, { stream: true }),
      ))
        readEvent(event, state, options);
    }
    if ((options.requireDone ?? true) && !state.done)
      throw invalid("provider stream ended before [DONE]");
    if (!options.allowTruncated && state.finishReason === "length")
      throw invalid("provider stream exhausted its output token limit");
    const toolCalls = [...state.tools.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => call);
    if (toolCalls.some((call) => !call.id || !call.name))
      throw invalid("provider stream contained an incomplete tool call");
    const content =
      state.content.join("") ||
      (toolCalls.length ? "" : state.reasoning.join("").trim());
    if (!content && !toolCalls.length)
      throw invalid("provider stream did not contain message content");
    return {
      content,
      usage: {
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
      },
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  } catch (error) {
    if (options.signal?.aborted)
      throw new ModelInvocationError(
        "canceled",
        "provider stream was canceled",
      );
    if (error instanceof TypeError && error.message.includes("encoded data"))
      throw invalid("provider stream was not valid UTF-8");
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => undefined); // 自定义流的 cancel 可能不结束，不能因此拖住已完成的调用。
    reader.releaseLock();
  }
}
