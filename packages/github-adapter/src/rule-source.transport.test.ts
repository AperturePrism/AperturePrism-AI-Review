/** 实际本地 HTTP server 验证严格导入；只在测试的 TCP 边界改路由，不放松生产 URL 校验。 */
import { once } from "node:events";
import {
  Agent,
  createServer,
  type IncomingMessage,
  type Server,
} from "node:http";
import { connect, type AddressInfo } from "node:net";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPublicRuleSourceText, RuleSourceError } from "./rule-source.js";

const mocks = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));

let server: Server;
let port: number;
let requests: IncomingMessage[];
let route: { mockRestore(): void };
beforeEach(async () => {
  requests = [];
  mocks.lookup
    .mockReset()
    .mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  server = createServer(async (request, response) => {
    requests.push(request);
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    if (path === "/redirect") {
      response.writeHead(302, {
        location: "/rules?signature=fixture-secret#part",
      });
      response.end();
    } else if (path === "/redirect-private") {
      response.writeHead(302, { location: `http://127.0.0.1:${port}/rules` });
      response.end();
    } else if (path === "/bad-utf8") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(Buffer.from([0xff, 0xfe]));
    } else if (path === "/incomplete-utf8") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(Buffer.from([0xe4, 0xb8]));
    } else if (path === "/bytes") {
      response.writeHead(200, { "content-type": "text/markdown" });
      response.end("界".repeat(25));
    } else if (path === "/chars") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("a".repeat(17));
    } else if (path === "/declared-large") {
      response.writeHead(200, {
        "content-type": "text/plain",
        "content-length": "10000",
      });
      response.flushHeaders();
    } else if (path === "/binary") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end("not rules");
    } else if (path === "/slow") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.flushHeaders();
    } else if (path === "/slow-body") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("# partial rule body\n");
    } else if (path === "/not-found") {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
    } else {
      response.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
      });
      const bytes = Buffer.from("# 规则\n保持参数化查询。\n");
      response.write(bytes.subarray(0, 3));
      await setImmediate();
      response.end(bytes.subarray(3));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
  // 保留 native HTTP 编解码，只有 socket 实际终点改成同进程 fixture。
  route = vi
    .spyOn(Agent.prototype, "createConnection")
    .mockImplementation(() => connect({ host: "127.0.0.1", port }));
});
afterEach(async () => {
  route?.mockRestore();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
const url = (path: string) => `http://rules.example${path}`;

describe("public rule source strict native HTTP import", () => {
  it("reads fragmented UTF-8 through actual HTTP and never sends service credentials", async () => {
    const result = await fetchPublicRuleSourceText(
      url("/rules?signature=fixture-secret#section"),
      { maxBytes: 64000, maxChars: 16000 },
    );
    expect(result).toEqual({
      content: "# 规则\n保持参数化查询。\n",
      sourceUrl: url("/rules"),
      truncated: false,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers).toMatchObject({
      host: "rules.example",
      accept: "text/*",
      "accept-encoding": "identity",
    });
    expect(requests[0]!.headers.authorization).toBeUndefined();
    expect(requests[0]!.headers.cookie).toBeUndefined();
    expect(requests[0]!.url).toBe("/rules?signature=fixture-secret");
  });

  it("validates and follows redirects, returning a query-free final source", async () => {
    const result = await fetchPublicRuleSourceText(
      url("/redirect?token=fixture-secret"),
    );
    expect(result.sourceUrl).toBe(url("/rules"));
    expect(result.content).toContain("保持参数化");
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(2);
  });

  it("refuses a private redirect before a second connection", async () => {
    await expect(
      fetchPublicRuleSourceText(url("/redirect-private")),
    ).rejects.toMatchObject({ code: "non_public_url" });
    expect(requests).toHaveLength(1);
  });

  it.each(["/bad-utf8", "/incomplete-utf8"])(
    "rejects invalid UTF-8 without replacement at %s",
    async (path) => {
      await expect(fetchPublicRuleSourceText(url(path))).rejects.toMatchObject({
        code: "invalid_utf8",
      });
    },
  );

  it("rejects byte overflow instead of returning a truncated rule", async () => {
    await expect(
      fetchPublicRuleSourceText(url("/bytes"), { maxBytes: 64 }),
    ).rejects.toMatchObject({ code: "byte_limit" });
  });

  it("rejects character overflow independently of the byte cap", async () => {
    await expect(
      fetchPublicRuleSourceText(url("/chars"), { maxBytes: 64, maxChars: 16 }),
    ).rejects.toMatchObject({ code: "character_limit" });
  });

  it("rejects declared overflow without waiting for the body", async () => {
    await expect(
      fetchPublicRuleSourceText(url("/declared-large"), { maxBytes: 64 }),
    ).rejects.toMatchObject({ code: "byte_limit" });
  });

  it("refuses non-text media instead of importing a binary response", async () => {
    await expect(
      fetchPublicRuleSourceText(url("/binary")),
    ).rejects.toMatchObject({ code: "unsupported_response" });
  });

  it("preserves HTTP status classification without echoing the source query", async () => {
    await expect(
      fetchPublicRuleSourceText(url("/not-found?token=fixture-secret")),
    ).rejects.toMatchObject({
      code: "http_error",
      message: "external repo rules returned HTTP 404",
    });
  });

  it("rejects credentialed and private URLs without opening a connection", async () => {
    for (const target of [
      "http://user:fixture-secret@rules.example/path",
      "http://127.0.0.1/rules?token=fixture-secret",
      "file:///etc/passwd",
    ]) {
      const error = await fetchPublicRuleSourceText(target).catch(
        (error) => error,
      );
      expect(error).toBeInstanceOf(RuleSourceError);
      expect(error.message).not.toContain("fixture-secret");
    }
    expect(requests).toHaveLength(0);
  });

  it("aborts an incomplete body when the caller cancels", async () => {
    const abort = new AbortController();
    const result = fetchPublicRuleSourceText(url("/slow"), {
      signal: abort.signal,
    });
    const caught = result.catch((error) => error);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const reason = new Error("cancel fixture");
    abort.abort(reason);
    expect(await caught).toBe(reason);
  });

  it("preserves a caller timeout after actual HTTP body bytes arrive", async () => {
    const deadline = AbortSignal.timeout(200);
    const result = fetchPublicRuleSourceText(url("/slow-body"), {
      signal: deadline,
    });
    const caught = result.catch((error) => error);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(await caught).toBe(deadline.reason);
    expect(deadline.reason).toMatchObject({ name: "TimeoutError" });
  });
});
