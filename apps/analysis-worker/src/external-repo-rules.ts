import { lookup } from "node:dns/promises";
import { request as httpRequest,type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList,isIP } from "node:net";

const maxResponseBytes = 256_000;
const maxRedirects = 5;
const timeoutMs = 15_000;
const truncationNotice = "\n\n（内容过长，已截断）";
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
    throw new Error("external repo rules URL must be credential-free HTTP(S)");
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
    throw new Error(
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
        new Error("external repo rules does not support protocol upgrades"),
      );
    });
    request.end();
  });
}

async function readTextResponse(response: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = maxResponseBytes - bytes;
    if (buffer.length > remaining) {
      chunks.push(buffer.subarray(0, remaining));
      bytes += remaining;
      truncated = true;
      response.destroy();
      break;
    }
    chunks.push(buffer);
    bytes += buffer.length;
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks, bytes), {
    stream: truncated,
  });
  if (!text.trim()) return undefined;
  return truncated ? `${text}${truncationNotice}` : text;
}

export async function fetchExternalRepoRulesText(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const requestSignal = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(signal ? [signal] : []),
  ]);
  let url = new URL(rawUrl);
  for (let redirects = 0; ; redirects += 1) {
    const response = await requestPublicUrl(url, requestSignal);
    const status = response.statusCode ?? 0;
    if (redirectStatuses.has(status)) {
      const location = response.headers.location;
      response.destroy();
      if (!location || redirects >= maxRedirects) {
        throw new Error(
          "external repo rules redirect limit exceeded or missing location",
        );
      }
      url = new URL(location, url);
      continue;
    }
    if (status < 200 || status >= 300) {
      response.destroy();
      throw new Error(`external repo rules returned HTTP ${status}`);
    }
    const contentType = response.headers["content-type"] ?? "";
    const encoding = response.headers["content-encoding"] ?? "identity";
    if (
      (contentType && !contentType.toLowerCase().startsWith("text/")) ||
      encoding.toLowerCase() !== "identity"
    ) {
      response.destroy();
      throw new Error("external repo rules response must be uncompressed text");
    }
    return readTextResponse(response);
  }
}
