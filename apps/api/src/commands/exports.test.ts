import { createServer, type ServerResponse } from "node:http";
import { once, EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
vi.mock("../runtime.js", () => ({
  database: { db: {} },
  logger: { warn: vi.fn() },
  config: {},
}));
import {
  csvField,
  encodeExportCursor,
  parseExportOptions,
  streamExport,
  type ExportServices,
  type ExportOptions,
} from "./exports.js";

const ONE = "00000000-0000-0000-0000-000000000001";
const TWO = "00000000-0000-0000-0000-000000000002";
const now = new Date("2026-11-13T00:00:00.000Z");
const records = [
  { id: ONE, createdAt: new Date("2026-11-12T10:20:30.000Z"), title: "审查一" },
  { id: TWO, createdAt: new Date("2026-11-12T10:20:30.000Z"), title: "审查二" },
];
function options(query = ""): ExportOptions {
  return parseExportOptions(
    new URL("http://localhost/exports/tasks" + query),
    now,
  );
}
function source(): ExportServices {
  return {
    list: vi.fn(async (input, pageSize) =>
      records
        .filter(
          (row) =>
            !input.after ||
            row.createdAt > input.after.createdAt ||
            (row.createdAt.getTime() === input.after.createdAt.getTime() &&
              row.id > input.after.id),
        )
        .slice(0, pageSize),
    ),
  };
}
async function download(
  input: ExportOptions,
  mode: "download" | "sse" = "download",
) {
  const services = source();
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type":
        mode === "sse" ? "text/event-stream" : "application/x-ndjson",
      trailer: "x-next-cursor",
    });
    void streamExport(
      input,
      response,
      services,
      ["id", "createdAt", "title"],
      mode,
    ).catch((error: unknown) =>
      response.destroy(error instanceof Error ? error : undefined),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const result = await fetch(`http://127.0.0.1:${port}/`);
    return { text: await result.text(), services };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("export query and resume cursor", () => {
  it("provides bounded defaults without requiring a format choice", () => {
    expect(options()).toMatchObject({
      format: "jsonl",
      type: "pr",
      limit: 1000,
      after: null,
      snapshot: now,
    });
  });
  it.each([
    "?format=xml",
    "?limit=0",
    "?limit=50001",
    "?limit=1.1",
    "?type=unknown",
    "?cursor=invalid",
  ])("rejects malformed export query %s", (query) => {
    expect(() => options(query)).toThrow();
  });
  it("preserves both the exact row and export snapshot when resuming", () => {
    const cursor = encodeExportCursor(records[0]!, now);
    expect(options("?cursor=" + cursor)).toMatchObject({
      after: { id: ONE, createdAt: records[0]!.createdAt },
      snapshot: now,
    });
  });
  it("rejects a cursor with an invalid UUID before asking for data", () => {
    const raw = Buffer.from(
      JSON.stringify({
        id: "bad",
        createdAt: now.toISOString(),
        snapshot: now.toISOString(),
      }),
    ).toString("base64url");
    expect(() => options("?cursor=" + raw)).toThrow("cursor");
  });
  it("rejects invalid cursor dates and a bookmark after its own snapshot", () => {
    for (const createdAt of ["not-date", "2027-01-01T00:00:00Z"]) {
      const raw = Buffer.from(
        JSON.stringify({ id: ONE, createdAt, snapshot: now.toISOString() }),
      ).toString("base64url");
      expect(() => options("?cursor=" + raw)).toThrow("cursor");
    }
  });
});

describe("CSV cells remain data when opened in a spreadsheet", () => {
  it.each(["=1+1", "+cmd", "-cmd", "@SUM(1)", "  =1+1"])(
    "neutralizes formula text %s",
    (text) => {
      expect(csvField(text)).toBe("\"'" + text + '"');
    },
  );
  it("keeps actual negative numbers numeric-looking", () => {
    expect(csvField(-4)).toBe('"-4"');
  });
  it("escapes quotes, embedded newlines and comma values", () => {
    expect(csvField('line\n"quote",comma')).toBe('"line\n""quote"",comma"');
  });
  it("represents missing values as empty cells", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });
  it("keeps structured results in one JSON cell", () => {
    expect(csvField({ status: "pass" })).toBe('"{""status"":""pass""}"');
  });
});

describe("HTTP export streaming", () => {
  it("sends independent UTF-8 JSONL records and per-record resume tokens", async () => {
    const result = await download(options());
    const lines = result.text
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            record: { id: string; title: string };
            cursor: string;
          },
      );
    expect(lines.map((line) => line.record.title)).toEqual([
      "审查一",
      "审查二",
    ]);
    expect(lines.every((line) => typeof line.cursor === "string")).toBe(true);
    expect(options("?cursor=" + lines[1]!.cursor).after?.id).toBe(TWO);
  });
  it("resumes after the last downloaded record without skipping a same-timestamp sibling", async () => {
    const first = await download(options("?limit=1"));
    const bookmark = (JSON.parse(first.text.trim()) as { cursor: string })
      .cursor;
    const second = await download(options("?cursor=" + bookmark));
    const rows = second.text
      .trim()
      .split("\n")
      .map(
        (line) => (JSON.parse(line) as { record: { id: string } }).record.id,
      );
    expect(rows).toEqual([TWO]);
  });
  it("writes CSV headers once and emits all selected columns in order", async () => {
    const result = await download(options("?format=csv"));
    const lines = result.text.trim().split("\r\n");
    expect(lines[0]).toBe('"id","createdAt","title"');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"审查一"');
  });
  it("puts a resume token in every SSE record id and finishes with a count", async () => {
    const result = await download(options(), "sse");
    expect(result.text.match(/^event: record$/gm)).toHaveLength(2);
    expect(result.text.match(/^id: /gm)).toHaveLength(2);
    expect(result.text).toContain('event: complete\ndata: {"count":2,');
  });
  it("does not request data beyond the requested total record limit", async () => {
    const result = await download(options("?limit=1"));
    expect(result.text.trim().split("\n")).toHaveLength(1);
    expect(result.services.list).toHaveBeenCalledOnce();
    expect(result.services.list).toHaveBeenCalledWith(expect.anything(), 1);
  });
  it("finishes an empty export cleanly", async () => {
    const output = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      addTrailers: ReturnType<typeof vi.fn>;
      destroyed: boolean;
      writableEnded: boolean;
    };
    Object.assign(output, {
      write: vi.fn(() => true),
      end: vi.fn(),
      addTrailers: vi.fn(),
      destroyed: false,
      writableEnded: false,
    });
    const count = await streamExport(
      options(),
      output as unknown as ServerResponse,
      { list: async () => [] },
      ["id"],
    );
    expect(count).toBe(0);
    expect(output.end).toHaveBeenCalledOnce();
    expect(output.write).not.toHaveBeenCalled();
  });
  it("removes temporary backpressure listeners after a slow writer drains", async () => {
    const output = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      addTrailers: ReturnType<typeof vi.fn>;
      destroyed: boolean;
      writableEnded: boolean;
    };
    Object.assign(output, {
      write: vi.fn(() => {
        setImmediate(() => output.emit("drain"));
        return false;
      }),
      end: vi.fn(),
      addTrailers: vi.fn(),
      destroyed: false,
      writableEnded: false,
    });
    expect(
      await streamExport(
        options(),
        output as unknown as ServerResponse,
        source(),
        ["id"],
      ),
    ).toBe(2);
    expect(output.listenerCount("drain")).toBe(0);
    expect(output.listenerCount("close")).toBe(0);
    expect(output.listenerCount("error")).toBe(0);
  });
  it("stops reading when the downloader disconnects during a blocked write", async () => {
    const output = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      addTrailers: ReturnType<typeof vi.fn>;
      destroyed: boolean;
      writableEnded: boolean;
    };
    Object.assign(output, {
      write: vi.fn(() => {
        setImmediate(() => {
          output.destroyed = true;
          output.emit("close");
        });
        return false;
      }),
      end: vi.fn(),
      addTrailers: vi.fn(),
      destroyed: false,
      writableEnded: false,
    });
    const input = source();
    expect(
      await streamExport(
        options(),
        output as unknown as ServerResponse,
        input,
        ["id"],
      ),
    ).toBe(0);
    expect(input.list).toHaveBeenCalledOnce();
    expect(output.write).toHaveBeenCalledOnce();
    expect(output.listenerCount("drain")).toBe(0);
  });
});
