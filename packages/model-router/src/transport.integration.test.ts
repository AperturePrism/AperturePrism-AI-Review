/** 本机 HTTP 端到端：验证 native fetch 在真实断流、超时和 UTF-8 分片下的行为。 */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOpenAICompatibleAdapter,
  routeModelInvocation,
} from "./index.js";

const servers = new Set<Server>();
const timers = new Set<ReturnType<typeof setTimeout>>();
const candidate = { provider: "local", model: "test", accountName: "test" };
const request = { messages: [{ role: "user" as const, content: "hello" }] };
const signal = () => new AbortController().signal;
const frame = (text: string) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`;

async function localAdapter(
  handle: (response: ServerResponse) => void,
  stream = true,
) {
  const server = createServer((_request, response) => handle(response));
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return createOpenAICompatibleAdapter({
    provider: "local",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    resolveApiKey: async () => "local-only-test-key",
    stream,
  });
}

function later(action: () => void, ms = 5): void {
  const timer = setTimeout(() => {
    timers.delete(timer);
    action();
  }, ms);
  timers.add(timer);
}

afterEach(async () => {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  servers.clear();
});

describe("native model HTTP transport", () => {
  it("reads real HTTP chunks even when a multibyte codepoint crosses writes", async () => {
    const source = Buffer.from(
      frame("星绒🐾") +
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
    );
    const split = source.indexOf(Buffer.from("🐾")) + 1;
    const adapter = await localAdapter((response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(source.subarray(0, split));
      later(() => response.end(source.subarray(split)));
    });
    expect(await adapter.invoke(candidate, request, signal())).toEqual({
      content: "星绒🐾",
      usage: { inputTokens: 3, outputTokens: 2 },
    });
  });

  it("classifies a socket destroyed mid-stream as a connection failure", async () => {
    const adapter = await localAdapter((response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(frame("partial"));
      later(() => response.destroy());
    });
    await expect(
      adapter.invoke(candidate, request, signal()),
    ).rejects.toMatchObject({ category: "connection_failed" });
  });

  it("does not accept a cleanly closed stream without DONE", async () => {
    const adapter = await localAdapter((response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(frame("partial"));
    });
    await expect(
      adapter.invoke(candidate, request, signal()),
    ).rejects.toMatchObject({ category: "invalid_output" });
  });

  it("aborts an idle HTTP stream at the shared route deadline", async () => {
    const adapter = await localAdapter((response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": heartbeat\n\n");
    });
    await expect(
      routeModelInvocation(new Map([["local", adapter]]), {
        candidates: [candidate],
        request,
        deadlineMs: 40,
        retryPolicy: {
          maxAttemptsPerCandidate: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
        },
      }),
    ).rejects.toMatchObject({ lastCategory: "timeout" });
  });

  it("keeps a caller cancellation distinct from an upstream timeout", async () => {
    const controller = new AbortController();
    const adapter = await localAdapter((response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": heartbeat\n\n");
      later(() => controller.abort());
    });
    await expect(
      adapter.invoke(candidate, request, controller.signal),
    ).rejects.toMatchObject({ category: "canceled" });
  });

  it("does not log an untrusted gateway error body by default", async () => {
    const adapter = await localAdapter((response) => {
      response.writeHead(503);
      response.end("private source code and Bearer secret-value");
    }, false);
    try {
      await adapter.invoke(candidate, request, signal());
      throw new Error("expected error");
    } catch (error) {
      expect(error).toMatchObject({ category: "server_error" });
      expect(String(error)).not.toContain("private source");
      expect(String(error)).not.toContain("secret-value");
    }
  });

  it("also handles a native JSON completion through the bounded reader", async () => {
    const adapter = await localAdapter((response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: "json result" } }],
          usage: { prompt_tokens: -9, completion_tokens: 1.5 },
        }),
      );
    }, false);
    expect(await adapter.invoke(candidate, request, signal())).toEqual({
      content: "json result",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });
});
