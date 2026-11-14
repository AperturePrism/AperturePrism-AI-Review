/**
 * HTTP 请求和回复：外部字节限制、JSON 解析、请求关联与统一错误。
 * 调用：const body = await readBody(request); json(response, 200, body, requestIdOf(request))。
 * 业务错误带可展示的状态和原因；程序故障由入口记录，不回显连接串和凭据。
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 用户能够自行修正的 HTTP 错误；统一由主入口发送。 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/** 关联 ID 一次生成后跟随请求，日志与最终错误使用同一个值。 */
const requestIds = new WeakMap<IncomingMessage, string>();

export function requestIdOf(request: IncomingMessage): string {
  const existing = requestIds.get(request);
  if (existing) return existing;
  const header = request.headers["x-request-id"];
  const id =
    typeof header === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(header)
      ? header
      : randomUUID();
  requestIds.set(request, id);
  return id;
}

/** 代理头只在部署明确声明可信代理时使用，公网调用者不能伪造来源绕过限额。 */
export function clientIp(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (
    process.env.TRUST_PROXY === "true" &&
    typeof forwarded === "string" &&
    forwarded.length > 0
  ) {
    return forwarded.split(",")[0]!.trim();
  }
  return request.socket.remoteAddress ?? "unknown";
}

/** JSON 回复不缓存：列表可能包含用户授权后的仓库内容和会话信息。 */
export function json(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  requestId: string,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-request-id": requestId,
  });
  response.end(JSON.stringify(body));
}

/**
 * 把请求读取为有限大小的原始字节；签名 webhook 必须用原字节验签。
 * @param request Node HTTP 请求。
 * @param limitBytes 默认 32 MiB，覆盖 GitHub 25 MiB payload 上限并保留封装余量。
 * @returns 完整请求体；超限返回 413，连接中断返回 400。
 */
export async function readBody(
  request: IncomingMessage,
  limitBytes = 32 * 1024 * 1024,
): Promise<Buffer> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limitBytes) {
    request.resume(); // 消费后续字节，让 413 可以正常写回同一连接。
    throw new HttpError(413, "request body too large");
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onAborted = (): void => {
      cleanup();
      reject(new HttpError(400, "request aborted"));
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limitBytes) {
        cleanup();
        request.resume();
        reject(new HttpError(413, "request body too large"));
        return;
      }
      chunks.push(bytes);
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

/** 外部 JSON 必须是对象；所有表单指令共用此处，null/数组不会落入业务代码。 */
export function parseJsonObject(raw: Buffer): Record<string, unknown> {
  const value: unknown = JSON.parse(raw.toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SyntaxError("JSON object required");
  }
  return value as Record<string, unknown>;
}

/** 安装表单需要一个 JSON 对象；格式填错交给调用指令给出具体字段提示。 */
export async function parseJsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown> | null> {
  const raw = await readBody(request);
  try {
    return parseJsonObject(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}
