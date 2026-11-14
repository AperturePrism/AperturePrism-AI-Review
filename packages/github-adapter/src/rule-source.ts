/**
 * 外部规则文本的唯一 HTTP 入口：逐跳验证公有地址，并固定已经校验的 DNS 结果。
 * @example await fetchPublicRuleSourceText(url, {maxBytes:64000,maxChars:16000});
 */
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

export type RuleSourceErrorCode =
  | "invalid_url"
  | "non_public_url"
  | "redirect_limit"
  | "protocol_upgrade"
  | "http_error"
  | "unsupported_response"
  | "byte_limit"
  | "character_limit"
  | "invalid_utf8"
  | "invalid_limits";

/** code 和 message 都不带用户输入，调用方可以安全映射成用户可改的错误。 */
export class RuleSourceError extends Error {
  constructor(
    readonly code: RuleSourceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RuleSourceError";
  }
}

const defaultMaxResponseBytes = 256_000;
const maxRedirects = 5;
const timeoutMs = 15_000;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const blockedIpv4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedIpv4.addSubnet(address, prefix, "ipv4");
}

// Azure's virtual platform address is public-range but exposes host-local services.
blockedIpv4.addAddress("168.63.129.16", "ipv4");

const globalIpv6 = new BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");
const blockedIpv6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  blockedIpv6.addSubnet(address, prefix, "ipv6");
}

function isPublicAddress(address: string): boolean {
  switch (isIP(address)) {
    case 4:
      return !blockedIpv4.check(address, "ipv4");
    case 6:
      // Only global unicast is eligible; mapped/NAT64 addresses can reach IPv4 internals.
      return (
        globalIpv6.check(address, "ipv6") && !blockedIpv6.check(address, "ipv6")
      );
    default:
      return false;
  }
}

async function resolvePublicAddress(url: URL, signal: AbortSignal) {
  signal.throwIfAborted();
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new RuleSourceError(
      "invalid_url",
      "external repo rules URL must be credential-free HTTP(S)",
    );
  }
  const hostname = url.hostname.startsWith("[")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const family = isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family }]
    : await new Promise<{ address: string; family: number }[]>(
        (resolve, reject) => {
          const onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          void lookup(hostname, { all: true, verbatim: true }).then(
            (results) => {
              signal.removeEventListener("abort", onAbort);
              resolve(results);
            },
            (error: unknown) => {
              signal.removeEventListener("abort", onAbort);
              reject(error);
            },
          );
        },
      );
  signal.throwIfAborted();
  const address = addresses[0];
  if (!address || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new RuleSourceError(
      "non_public_url",
      "external repo rules URL must resolve only to public IP addresses",
    );
  }
  return address;
}

async function requestPublicUrl(url: URL, signal: AbortSignal) {
  const address = await resolvePublicAddress(url, signal);
  return new Promise<IncomingMessage>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        agent: false,
        family: address.family,
        signal,
        headers: { accept: "text/*", "accept-encoding": "identity" },
        // Pin the validated DNS result while retaining the URL's Host and TLS identity.
        lookup: (_hostname, _options, callback) => {
          callback(null, address.address, address.family);
        },
      },
      resolve,
    );
    request.once("error", reject);
    request.once("upgrade", (_response, socket) => {
      socket.destroy();
      reject(
        new RuleSourceError(
          "protocol_upgrade",
          "external repo rules does not support protocol upgrades",
        ),
      );
    });
    request.end();
  });
}

export type PublicRuleSourceOptions = {
  signal?: AbortSignal;
  maxBytes?: number;
  maxChars?: number;
  /** 管理界面的导入必须拒绝损坏文本；后台旧规则读取可显式保持宽松解码。 */
  strictUtf8?: boolean;
  /** 导入时不允许悄悄保存半份规则。 */
  rejectTruncation?: boolean;
};

export type PublicRuleSourceText = {
  content: string;
  /** 不回显签名查询参数和片段；实际请求仍使用完整 URL。 */
  sourceUrl: string;
  truncated: boolean;
};

async function readTextResponse(
  response: IncomingMessage,
  options: Required<
    Pick<
      PublicRuleSourceOptions,
      "maxBytes" | "strictUtf8" | "rejectTruncation"
    >
  > &
    Pick<PublicRuleSourceOptions, "maxChars">,
): Promise<{ content: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    for await (const chunk of response) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = options.maxBytes - bytes;
      if (buffer.length > remaining) {
        if (options.rejectTruncation)
          throw new RuleSourceError(
            "byte_limit",
            "external repo rules response exceeded its byte limit",
          );
        chunks.push(buffer.subarray(0, remaining));
        bytes += remaining;
        truncated = true;
        break;
      }
      chunks.push(buffer);
      bytes += buffer.length;
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: options.strictUtf8 }).decode(
        Buffer.concat(chunks, bytes),
        { stream: truncated },
      );
    } catch {
      throw new RuleSourceError(
        "invalid_utf8",
        "external repo rules response must be valid UTF-8 text",
      );
    }
    if (options.maxChars !== undefined && content.length > options.maxChars) {
      if (options.rejectTruncation)
        throw new RuleSourceError(
          "character_limit",
          "external repo rules response exceeded its character limit",
        );
      content = content.slice(0, options.maxChars);
      // 不把一个 UTF-16 代理对截成损坏的半个字符。
      if (/[\uD800-\uDBFF]$/.test(content)) content = content.slice(0, -1);
      truncated = true;
    }
    return { content, truncated };
  } finally {
    response.destroy();
  }
}

export async function fetchPublicRuleSourceText(
  rawUrl: string,
  options: PublicRuleSourceOptions = {},
): Promise<PublicRuleSourceText> {
  const maxBytes = options.maxBytes ?? defaultMaxResponseBytes;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    (options.maxChars !== undefined &&
      (!Number.isSafeInteger(options.maxChars) || options.maxChars < 1))
  )
    throw new RuleSourceError(
      "invalid_limits",
      "external repo rules text limits must be positive integers",
    );
  const requestSignal = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(options.signal ? [options.signal] : []),
  ]);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new RuleSourceError(
      "invalid_url",
      "external repo rules URL must be credential-free HTTP(S)",
    );
  }
  for (let redirects = 0; ; redirects += 1) {
    const response = await requestPublicUrl(url, requestSignal);
    const status = response.statusCode ?? 0;
    if (redirectStatuses.has(status)) {
      const location = response.headers.location;
      response.destroy();
      if (!location || redirects >= maxRedirects) {
        throw new RuleSourceError(
          "redirect_limit",
          "external repo rules redirect limit exceeded or missing location",
        );
      }
      try {
        url = new URL(location, url);
      } catch {
        throw new RuleSourceError(
          "invalid_url",
          "external repo rules redirect location is invalid",
        );
      }
      continue;
    }
    if (status < 200 || status >= 300) {
      response.destroy();
      throw new RuleSourceError(
        "http_error",
        `external repo rules returned HTTP ${status}`,
      );
    }
    const contentType = response.headers["content-type"] ?? "";
    const encoding = response.headers["content-encoding"] ?? "identity";
    if (
      (contentType && !contentType.toLowerCase().startsWith("text/")) ||
      encoding.toLowerCase() !== "identity"
    ) {
      response.destroy();
      throw new RuleSourceError(
        "unsupported_response",
        "external repo rules response must be uncompressed text",
      );
    }
    const declaredBytes = response.headers["content-length"];
    if (
      (options.rejectTruncation ?? true) &&
      declaredBytes !== undefined &&
      /^\d+$/.test(declaredBytes) &&
      Number(declaredBytes) > maxBytes
    ) {
      response.destroy();
      throw new RuleSourceError(
        "byte_limit",
        "external repo rules response exceeded its byte limit",
      );
    }
    let result: Awaited<ReturnType<typeof readTextResponse>>;
    try {
      result = await readTextResponse(response, {
        maxBytes,
        ...(options.maxChars === undefined
          ? {}
          : { maxChars: options.maxChars }),
        strictUtf8: options.strictUtf8 ?? true,
        rejectTruncation: options.rejectTruncation ?? true,
      });
    } catch (error) {
      // Node 的响应体迭代可能只抛 ECONNRESET；保留真正的超时或调用方取消原因。
      if (requestSignal.aborted) throw requestSignal.reason;
      throw error;
    }
    return { ...result, sourceUrl: `${url.origin}${url.pathname}` };
  }
}
