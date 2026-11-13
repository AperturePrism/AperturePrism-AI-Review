import { PassThrough } from "node:stream";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clientIp,
  HttpError,
  json,
  parseJsonBody,
  parseJsonObject,
  readBody,
  requestIdOf,
} from "./http.js";

function bodyRequest(
  text: string,
  headers: Record<string, string> = {},
): IncomingMessage {
  const stream = new PassThrough();
  Object.assign(stream, { headers, socket: { remoteAddress: "127.0.0.1" } });
  stream.end(Buffer.from(text));
  return stream as unknown as IncomingMessage;
}

afterEach(() => vi.unstubAllEnvs());

describe("bounded HTTP request bodies", () => {
  it("returns raw bytes for webhook signature verification", async () => {
    const input = '{"text": "注释\\n"}\n';
    expect(await readBody(bodyRequest(input))).toEqual(Buffer.from(input));
  });

  it("allows an empty request body", async () => {
    expect(await readBody(bodyRequest(""))).toHaveLength(0);
  });

  it("counts UTF-8 bytes instead of JavaScript characters", async () => {
    await expect(readBody(bodyRequest("云云"), 5)).rejects.toMatchObject({
      status: 413,
    });
    expect(await readBody(bodyRequest("云云"), 6)).toHaveLength(6);
  });

  it("rejects an oversized declared body before waiting for the upload", async () => {
    const input = bodyRequest("", { "content-length": "9000" });
    await expect(readBody(input, 512)).rejects.toMatchObject({
      status: 413,
      message: "request body too large",
    });
  });

  it("rejects chunked uploads when their combined size exceeds the limit", async () => {
    const stream = new PassThrough();
    Object.assign(stream, { headers: {} });
    const result = readBody(stream as unknown as IncomingMessage, 5);
    stream.write("123");
    stream.end("456");
    await expect(result).rejects.toMatchObject({ status: 413 });
  });

  it("removes body listeners after a successful upload", async () => {
    const input = bodyRequest("{} ");
    await readBody(input);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("aborted")).toBe(0);
  });

  it("classifies a disconnected upload as an input failure", async () => {
    const stream = new PassThrough();
    Object.assign(stream, { headers: {} });
    const result = readBody(stream as unknown as IncomingMessage);
    stream.emit("aborted");
    await expect(result).rejects.toMatchObject({
      status: 400,
      message: "request aborted",
    });
  });

  it("preserves the originating stream error", async () => {
    const stream = new PassThrough();
    Object.assign(stream, { headers: {} });
    const error = new Error("read failed");
    const result = readBody(stream as unknown as IncomingMessage);
    stream.emit("error", error);
    await expect(result).rejects.toBe(error);
  });

  it("sends a complete 413 response for an actual oversized HTTP upload", async () => {
    const server = createServer((request, response) => {
      void readBody(request, 16)
        .then(() => json(response, 200, {}, "test"))
        .catch((error: unknown) => {
          json(
            response,
            error instanceof HttpError ? error.status : 500,
            { error: error instanceof Error ? error.message : "error" },
            "test",
          );
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address() as AddressInfo;
      const output = await fetch(`http://127.0.0.1:${address.port}/`, {
        method: "POST",
        body: "x".repeat(64),
      });
      expect(output.status).toBe(413);
      await expect(output.json()).resolves.toEqual({
        error: "request body too large",
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe("JSON boundary", () => {
  it.each(["null", "[]", '"hello"', "42", "true", "", "{"])(
    "rejects %s as a JSON form",
    (text) => {
      expect(() => parseJsonObject(Buffer.from(text))).toThrow(SyntaxError);
    },
  );

  it("accepts an object without mutating its values", () => {
    expect(
      parseJsonObject(Buffer.from('{"empty":"", "yes":false, "count":0}')),
    ).toEqual({ empty: "", yes: false, count: 0 });
  });

  it("returns null for an invalid installation form", async () => {
    await expect(parseJsonBody(bodyRequest("null"))).resolves.toBeNull();
  });

  it("returns the parsed installation object", async () => {
    await expect(parseJsonBody(bodyRequest('{"appId":"17"}'))).resolves.toEqual(
      { appId: "17" },
    );
  });
});

describe("request identity and forwarding", () => {
  it("keeps a safe correlation id across success and error handling", () => {
    const request = bodyRequest("", { "x-request-id": "trace-123.child" });
    expect(requestIdOf(request)).toBe("trace-123.child");
    expect(requestIdOf(request)).toBe("trace-123.child");
  });

  it.each([" ", "a".repeat(129), "unsafe/segment", "控制字符"])(
    "replaces an unsafe correlation id",
    (id) => {
      const request = bodyRequest("", { "x-request-id": id });
      const generated = requestIdOf(request);
      expect(generated).toMatch(/^[a-f0-9-]{36}$/);
      expect(requestIdOf(request)).toBe(generated);
    },
  );

  it("ignores forwarding headers unless the deployment trusts its proxy", () => {
    vi.stubEnv("TRUST_PROXY", "false");
    expect(
      clientIp(bodyRequest("", { "x-forwarded-for": "spoofed, proxy" })),
    ).toBe("127.0.0.1");
  });

  it("uses the first forwarded address when explicitly configured", () => {
    vi.stubEnv("TRUST_PROXY", "true");
    expect(
      clientIp(
        bodyRequest("", { "x-forwarded-for": "192.0.2.20, 192.0.2.30" }),
      ),
    ).toBe("192.0.2.20");
  });

  it("does not cache user-scoped JSON and retains its request id", () => {
    const response = {
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;
    json(response, 200, { count: 2 }, "run-1");
    expect(response.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-request-id": "run-1",
      }),
    );
    expect(response.end).toHaveBeenCalledWith('{"count":2}');
  });
});
