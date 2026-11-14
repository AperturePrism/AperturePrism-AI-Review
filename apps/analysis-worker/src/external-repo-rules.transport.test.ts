import { once } from "node:events";
import { Agent, ClientRequest, type IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { Duplex } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { fetchExternalRepoRulesText } from "./external-repo-rules.js";

class MemorySocket extends Duplex {
  readonly connecting = false;
  readonly ready = (() => {
    let resolve!: (request: ClientRequest) => void;
    const promise = new Promise<ClientRequest>((ready) => {
      resolve = ready;
    });
    return { promise, resolve };
  })();

  override _read() {}

  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    const request: unknown = Reflect.get(this, "_httpMessage");
    if (!(request instanceof ClientRequest)) {
      callback(new Error("expected the native HTTP client to own this socket"));
      return;
    }
    this.ready.resolve(request);
    callback();
  }

  destroySoon() {
    // HTTP's close path expects net.Socket semantics, not Duplex.end alone.
    Socket.prototype.destroySoon.call(this as unknown as Socket);
    return this;
  }

  setTimeout() {
    return this;
  }

  setNoDelay() {
    return this;
  }

  setKeepAlive() {
    return this;
  }

  ref() {
    return this;
  }

  unref() {
    return this;
  }
}

async function withSocket(run: (socket: MemorySocket) => Promise<void>) {
  const socket = new MemorySocket();
  const createConnection = vi
    .spyOn(Agent.prototype, "createConnection")
    .mockReturnValue(socket as unknown as Socket);
  const connect = vi
    .spyOn(Socket.prototype, "connect")
    .mockImplementation(() => {
      throw new Error(
        "transport regressions must not open real network connections",
      );
    });
  try {
    await run(socket);
  } finally {
    socket.destroy();
    createConnection.mockRestore();
    connect.mockRestore();
  }
}

function startDownload(url = "http://8.8.8.8/rules", signal?: AbortSignal) {
  return fetchExternalRepoRulesText(url, signal).then(
    (text) => ({ outcome: "text" as const, text }),
    (error: unknown) => ({ outcome: "error" as const, error }),
  );
}

async function sendHeaders(socket: MemorySocket, contentLength: number) {
  const request = await socket.ready.promise;
  const received = once(request, "response");
  socket.push(
    `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${contentLength}\r\n\r\n`,
  );
  const [response] = (await received) as [IncomingMessage];
  await setImmediate();
  return { request, response };
}

describe("external repo rules native HTTP transport", () => {
  it.each(["2600::1", "2a00::1"])(
    "accepts public IPv6 %s through the native HTTP client",
    async (address) => {
      await withSocket(async (socket) => {
        const outcome = startDownload(`http://[${address}]/rules`);
        await sendHeaders(socket, 5);
        socket.push("rules");
        await expect(outcome).resolves.toEqual({
          outcome: "text",
          text: "rules",
        });
        await vi.waitFor(() => expect(socket.destroyed).toBe(true));
      });
    },
  );

  it("closes a completed response even if its peer keeps the connection open", async () => {
    await withSocket(async (socket) => {
      const controller = new AbortController();
      const outcome = startDownload(undefined, controller.signal);
      const { request, response } = await sendHeaders(socket, 5);
      socket.push("rules");
      await expect(outcome).resolves.toEqual({
        outcome: "text",
        text: "rules",
      });
      await vi.waitFor(() => expect(socket.destroyed).toBe(true));
      expect(request.destroyed).toBe(true);
      expect(response.destroyed).toBe(true);
      controller.abort();
      await setImmediate();
    });
  });

  it("destroys the request, response and socket when cancelled after headers", async () => {
    await withSocket(async (socket) => {
      const controller = new AbortController();
      const outcome = startDownload(undefined, controller.signal);
      const { request, response } = await sendHeaders(socket, 1_000);
      expect(request.writableFinished).toBe(true);
      const reason = new Error("cancelled after headers");
      controller.abort(reason);
      expect(socket.destroyed).toBe(true);
      await expect(outcome).resolves.toMatchObject({
        outcome: "error",
        error: reason,
      });
      const canceled = await outcome;
      expect(canceled.outcome === "error" ? canceled.error : undefined).toBe(
        reason,
      );
      expect(request.destroyed).toBe(true);
      expect(response.destroyed).toBe(true);
    });
  });

  it("destroys the entire transport when the total deadline expires during the body", async () => {
    const deadline = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(deadline.signal);
    try {
      await withSocket(async (socket) => {
        const outcome = startDownload();
        const { request, response } = await sendHeaders(socket, 1_000);
        const reason = new DOMException("deadline exceeded", "TimeoutError");
        deadline.abort(reason);
        expect(socket.destroyed).toBe(true);
        await expect(outcome).resolves.toMatchObject({
          outcome: "error",
          error: { name: "TimeoutError" },
        });
        const expired = await outcome;
        expect(expired.outcome === "error" ? expired.error : undefined).toBe(
          reason,
        );
        expect(request.destroyed).toBe(true);
        expect(response.destroyed).toBe(true);
        expect(timeout).toHaveBeenCalledWith(15_000);
      });
    } finally {
      timeout.mockRestore();
    }
  });

  it("closes the transport and rejects a body I/O failure", async () => {
    await withSocket(async (socket) => {
      const outcome = startDownload();
      const { request, response } = await sendHeaders(socket, 1_000);
      socket.destroy(new Error("body I/O failure"));
      await expect(outcome).resolves.toMatchObject({ outcome: "error" });
      expect(socket.destroyed).toBe(true);
      expect(request.destroyed).toBe(true);
      expect(response.destroyed).toBe(true);
    });
  });

  it("rejects an actual HTTP 101 response and destroys its upgraded socket", async () => {
    await withSocket(async (socket) => {
      const outcome = startDownload();
      await socket.ready.promise;
      socket.push(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
      await expect(outcome).resolves.toMatchObject({
        outcome: "error",
        error: {
          message: "external repo rules does not support protocol upgrades",
        },
      });
      expect(socket.destroyed).toBe(true);
    });
  });
});
