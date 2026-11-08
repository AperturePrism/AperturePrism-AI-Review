import { EventEmitter } from "node:events";
import { IncomingMessage, type RequestOptions } from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchExternalRepoRulesText } from "./external-repo-rules.js";

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  httpRequest: vi.fn(),
  httpsRequest: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:http")>()),
  request: mocks.httpRequest,
}));
vi.mock("node:https", () => ({ request: mocks.httpsRequest }));

function response(
  body: string | Buffer = "review rules",
  status = 200,
  headers: IncomingMessage["headers"] = { "content-type": "text/plain" },
) {
  const message = new IncomingMessage(new Socket());
  message.statusCode = status;
  message.headers = headers;
  message.complete = true;
  message._read = () => {
    message.push(body);
    message.push(null);
  };
  return message;
}

function serve(...responses: IncomingMessage[]) {
  const request = (
    _url: URL,
    options: RequestOptions,
    onResponse: (message: IncomingMessage) => void,
  ) => {
    const outgoing = new EventEmitter();
    const message = responses.shift();
    if (!message) throw new Error("unexpected request");
    return Object.assign(outgoing, {
      end: () => {
        options.signal?.addEventListener(
          "abort",
          () => message.destroy(options.signal?.reason),
          { once: true },
        );
        onResponse(message);
      },
    });
  };
  mocks.httpRequest.mockImplementation(request);
  mocks.httpsRequest.mockImplementation(request);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("external repo rules public URL validation", () => {
  it.each([
    "http://localhost/rules",
    "http://127.0.0.1/rules",
    "http://127.1/rules",
    "http://2130706433/rules",
    "http://0x7f000001/rules",
    "http://0177.0.0.1/rules",
    "http://0.0.0.0/rules",
    "http://10.10.0.1/rules",
    "http://100.100.100.200/latest/meta-data",
    "http://169.254.169.254/latest/meta-data",
    "http://168.63.129.16/?comp=versions",
    "http://172.16.0.1/rules",
    "http://192.168.0.1/rules",
    "http://192.0.0.1/rules",
    "http://198.18.0.1/rules",
    "http://192.0.2.1/rules",
    "http://224.0.0.1/rules",
    "http://255.255.255.255/rules",
    "http://[::]/rules",
    "http://[::1]/rules",
    "http://[::ffff:127.0.0.1]/rules",
    "http://[::ffff:8.8.8.8]/rules",
    "http://[64:ff9b::a00:1]/rules",
    "http://[fd00:ec2::254]/latest/meta-data",
    "http://[fe80::1]/rules",
    "http://[ff02::1]/rules",
    "http://[2001:db8::1]/rules",
    "http://[2002:7f00:1::]/rules",
    "http://[3fff::1]/rules",
  ])(
    "rejects non-public target %s before opening a connection",
    async (url) => {
      mocks.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
      await expect(fetchExternalRepoRulesText(url)).rejects.toThrow(
        "public IP",
      );
      expect(mocks.httpRequest).not.toHaveBeenCalled();
      expect(mocks.httpsRequest).not.toHaveBeenCalled();
    },
  );

  it.each([
    "ftp://example.com/rules",
    "file:///etc/passwd",
    "https://user:password@example.com/rules",
  ])("rejects unsupported or credential-bearing URL %s", async (url) => {
    await expect(fetchExternalRepoRulesText(url)).rejects.toThrow("HTTP(S)");
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.httpRequest).not.toHaveBeenCalled();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });

  it("rejects DNS answers containing any non-public IPv4 or IPv6 address", async () => {
    for (const address of ["10.0.0.1", "::1", "::ffff:10.0.0.1"]) {
      mocks.lookup.mockResolvedValue([
        { address: "8.8.8.8", family: 4 },
        { address, family: address.includes(":") ? 6 : 4 },
      ]);
      await expect(
        fetchExternalRepoRulesText("https://rules.example/rules"),
      ).rejects.toThrow("public IP");
    }
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });

  it("rejects an empty DNS answer", async () => {
    mocks.lookup.mockResolvedValue([]);
    await expect(
      fetchExternalRepoRulesText("https://rules.example/rules"),
    ).rejects.toThrow("public IP");
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });

  it("pins the validated address without a second DNS resolution", async () => {
    serve(response());
    await expect(
      fetchExternalRepoRulesText("https://rules.example/rules"),
    ).resolves.toBe("review rules");
    expect(mocks.lookup).toHaveBeenCalledExactlyOnceWith("rules.example", {
      all: true,
      verbatim: true,
    });
    const [url, options] = mocks.httpsRequest.mock.calls[0]!;
    expect(url.hostname).toBe("rules.example");
    expect(options).toMatchObject({ agent: false, family: 4 });
    const callback = vi.fn();
    options.lookup("rules.example", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });

  it.each(["http://8.8.8.8/rules", "https://[2606:4700:4700::1111]/rules"])(
    "accepts public literal %s without DNS lookup",
    async (url) => {
      serve(response());
      await expect(fetchExternalRepoRulesText(url)).resolves.toBe(
        "review rules",
      );
      expect(mocks.lookup).not.toHaveBeenCalled();
    },
  );
});

describe("external repo rules redirects", () => {
  it("validates each redirect and resolves relative locations", async () => {
    const redirect = response("", 302, { location: "/final.txt" });
    serve(redirect, response("final rules"));
    await expect(
      fetchExternalRepoRulesText("https://rules.example/start"),
    ).resolves.toBe("final rules");
    expect(redirect.destroyed).toBe(true);
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
    expect(mocks.httpsRequest.mock.calls[1]![0].pathname).toBe("/final.txt");
  });

  it.each([
    "http://169.254.169.254/latest/meta-data",
    "http://168.63.129.16/?comp=versions",
    "http://[::1]/rules",
    "file:///etc/passwd",
    "http://user:password@rules.example/rules",
  ])("blocks unsafe redirect location %s", async (location) => {
    const redirect = response("", 302, { location });
    serve(redirect);
    await expect(
      fetchExternalRepoRulesText("https://rules.example/start"),
    ).rejects.toThrow();
    expect(redirect.destroyed).toBe(true);
    expect(mocks.httpsRequest).toHaveBeenCalledTimes(1);
    expect(mocks.httpRequest).not.toHaveBeenCalled();
  });

  it("blocks a redirect whose hostname resolves to an internal address", async () => {
    mocks.lookup
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValueOnce([{ address: "192.168.1.1", family: 4 }]);
    serve(response("", 307, { location: "https://internal.example/rules" }));
    await expect(
      fetchExternalRepoRulesText("https://rules.example/start"),
    ).rejects.toThrow("public IP");
    expect(mocks.httpsRequest).toHaveBeenCalledTimes(1);
  });

  it("rechecks DNS even for redirects back to the same hostname", async () => {
    mocks.lookup
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    serve(response("", 301, { location: "/redirected" }));
    await expect(
      fetchExternalRepoRulesText("https://rules.example/start"),
    ).rejects.toThrow("public IP");
    expect(mocks.httpsRequest).toHaveBeenCalledTimes(1);
  });

  it("bounds redirect loops and destroys the final response", async () => {
    const redirects = Array.from({ length: 6 }, () =>
      response("", 302, { location: "/again" }),
    );
    serve(...redirects);
    await expect(
      fetchExternalRepoRulesText("https://rules.example/start"),
    ).rejects.toThrow("redirect limit");
    expect(mocks.httpsRequest).toHaveBeenCalledTimes(6);
    expect(redirects.every((message) => message.destroyed)).toBe(true);
  });
});

describe("external repo rules bounded text streaming", () => {
  it("accepts text content types and absent content-type", async () => {
    for (const headers of [
      {},
      { "content-type": "Text/Markdown; charset=utf-8" },
    ]) {
      serve(response("规则\nkeep it simple", 200, headers));
      await expect(
        fetchExternalRepoRulesText("https://rules.example/rules"),
      ).resolves.toBe("规则\nkeep it simple");
    }
  });

  it.each([
    { "content-type": "application/json" },
    { "content-type": "text/plain", "content-encoding": "gzip" },
  ])(
    "rejects unsupported response headers %j and closes the body",
    async (headers) => {
      const message = response("body", 200, headers);
      const read = vi.spyOn(message, "_read");
      serve(message);
      await expect(
        fetchExternalRepoRulesText("https://rules.example/rules"),
      ).rejects.toThrow("uncompressed text");
      expect(message.destroyed).toBe(true);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("closes non-success responses before reading their body", async () => {
    const message = response("not found", 404);
    const read = vi.spyOn(message, "_read");
    serve(message);
    await expect(
      fetchExternalRepoRulesText("https://rules.example/rules"),
    ).rejects.toThrow("HTTP 404");
    expect(message.destroyed).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  it("returns undefined for empty or whitespace-only text", async () => {
    for (const body of ["", "  \n\t"]) {
      serve(response(body));
      await expect(
        fetchExternalRepoRulesText("https://rules.example/rules"),
      ).resolves.toBeUndefined();
    }
  });

  it("does not truncate a response exactly at the byte limit", async () => {
    serve(response("a".repeat(256_000)));
    await expect(
      fetchExternalRepoRulesText("https://rules.example/rules"),
    ).resolves.toBe("a".repeat(256_000));
  });

  it("enforces a byte limit on oversized UTF-8 text without replacement characters", async () => {
    const message = response("规".repeat(100_000));
    serve(message);
    const text = await fetchExternalRepoRulesText(
      "https://rules.example/rules",
    );
    expect(text).toBe(`${"规".repeat(85_333)}\n\n（内容过长，已截断）`);
    expect(message.destroyed).toBe(true);
  });

  it("stops a long stream before consuming the full response", async () => {
    const message = response();
    let generatedBytes = 0;
    message._read = () => {
      generatedBytes += 16_000;
      message.push(Buffer.alloc(16_000, "a"));
    };
    serve(message);
    const text = await fetchExternalRepoRulesText(
      "https://rules.example/rules",
    );
    expect(text).toBe(`${"a".repeat(256_000)}\n\n（内容过长，已截断）`);
    expect(message.destroyed).toBe(true);
    expect(generatedBytes).toBeLessThan(400_000);
  });

  it("does not read beyond the limit even when content-length understates the body", async () => {
    const message = response("a".repeat(1_000_000), 200, {
      "content-type": "text/plain",
      "content-length": "10",
    });
    serve(message);
    const text = await fetchExternalRepoRulesText(
      "https://rules.example/rules",
    );
    expect(text).toBe(`${"a".repeat(256_000)}\n\n（内容过长，已截断）`);
    expect(message.destroyed).toBe(true);
  });
});

describe("external repo rules cancellation and timeout", () => {
  it("rejects protocol upgrades and closes the upgraded socket", async () => {
    const socket = new Socket();
    mocks.httpRequest.mockImplementation(() => {
      const request = new EventEmitter();
      return Object.assign(request, {
        end: () =>
          request.emit("upgrade", response("", 101), socket, Buffer.alloc(0)),
      });
    });
    await expect(
      fetchExternalRepoRulesText("http://rules.example/rules"),
    ).rejects.toThrow("does not support protocol upgrades");
    expect(socket.destroyed).toBe(true);
  });

  it("does not resolve DNS or connect after caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      fetchExternalRepoRulesText(
        "https://rules.example/rules",
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });

  it("stops waiting for DNS when the caller cancels", async () => {
    mocks.lookup.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const pending = fetchExternalRepoRulesText(
      "https://rules.example/rules",
      controller.signal,
    );
    controller.abort(new Error("cancelled during DNS"));
    await expect(pending).rejects.toThrow("cancelled during DNS");
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });

  it("times out even if DNS never completes", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    mocks.lookup.mockReturnValue(new Promise(() => {}));
    const pending = fetchExternalRepoRulesText("https://rules.example/rules");
    controller.abort(new Error("timeout"));
    await expect(pending).rejects.toThrow("timeout");
    expect(AbortSignal.timeout).toHaveBeenCalledWith(15_000);
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("uses a single timeout across redirects and body streaming", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const body = response();
    body._read = () => {};
    serve(response("", 302, { location: "/final" }), body);
    const pending = fetchExternalRepoRulesText("https://rules.example/rules");
    await vi.waitFor(() => expect(mocks.httpsRequest).toHaveBeenCalledTimes(2));
    controller.abort(new Error("timeout during body"));
    await expect(pending).rejects.toThrow("timeout during body");
    expect(AbortSignal.timeout).toHaveBeenCalledTimes(1);
    expect(mocks.httpsRequest.mock.calls[0]![1].signal).toBe(
      mocks.httpsRequest.mock.calls[1]![1].signal,
    );
    expect(body.destroyed).toBe(true);
    vi.restoreAllMocks();
  });
});
