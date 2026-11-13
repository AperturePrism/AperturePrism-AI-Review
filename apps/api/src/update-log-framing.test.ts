import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleUpdateApply } from "./update.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}
class FakeResponse extends EventEmitter {
  chunks: string[] = [];
  writeHead(): void {}
  write(chunk: string): boolean { this.chunks.push(chunk); return true; }
  end(): void {}
}
let child: FakeChild;
let response: FakeResponse;
beforeEach(() => {
  child = new FakeChild();
  response = new FakeResponse();
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
});
async function start(): Promise<void> {
  const request = Readable.from([Buffer.from('{"target":"v1.2.16"}')]);
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) }),
  } as unknown as Parameters<typeof handleUpdateApply>[4];
  await handleUpdateApply(
    request as unknown as IncomingMessage,
    response as unknown as ServerResponse,
    "request-test", true, db,
  );
}
function frames(): { type: string; data: Record<string, unknown> }[] {
  return response.chunks.join("").split("\n\n").flatMap((frame) => {
    const type = frame.match(/^event: (.+)$/m)?.[1];
    const data = frame.match(/^data: (.+)$/m)?.[1];
    return type && data ? [{ type, data: JSON.parse(data) as Record<string, unknown> }] : [];
  });
}

describe("update child-process log framing", () => {
  it("reassembles a stage JSON record split across stdout chunks", async () => {
    await start();
    child.stdout.emit("data", Buffer.from('{"level":"stage","sta'));
    child.stdout.emit("data", Buffer.from('ge":"backup","message":"备份配置"}\n'));
    child.emit("close", 0);
    expect(frames()).toContainEqual({ type: "stage", data: { stage: "backup", message: "备份配置" } });
    expect(frames().filter((frame) => frame.type === "log").some((frame) => String(frame.data.message).includes('{"level"'))).toBe(false);
  });

  it("decodes UTF-8 characters split across byte chunks", async () => {
    await start();
    const bytes = Buffer.from('{"level":"info","message":"更新完成"}\n');
    const split = bytes.indexOf(Buffer.from("更")) + 1;
    child.stdout.emit("data", bytes.subarray(0, split));
    child.stdout.emit("data", bytes.subarray(split));
    child.emit("close", 0);
    expect(frames()).toContainEqual({ type: "log", data: { level: "info", message: "更新完成" } });
    expect(response.chunks.join("")).not.toContain("�");
  });

  it("keeps stderr separate and flushes the final unterminated lines before done", async () => {
    await start();
    child.stdout.emit("data", Buffer.from('{"level":"stage","stage":"pull",'));
    child.stderr.emit("data", Buffer.from("warning "));
    child.stdout.emit("data", Buffer.from('"message":"拉取镜像"}'));
    child.stderr.emit("data", Buffer.from("detail"));
    child.emit("close", 0);
    const result = frames();
    expect(result).toContainEqual({ type: "stage", data: { stage: "pull", message: "拉取镜像" } });
    expect(result).toContainEqual({ type: "log", data: { level: "warn", message: "warning detail" } });
    expect(result.at(-1)?.type).toBe("done");
  });

  it("still emits separate complete lines and carriage-return progress", async () => {
    await start();
    child.stdout.emit("data", Buffer.from("pull 10%\rpull 20%\r\nready\n"));
    child.emit("close", 0);
    const messages = frames().filter((frame) => frame.type === "log").map((frame) => frame.data.message);
    expect(messages.slice(0, 3)).toEqual(["pull 10%", "pull 20%", "ready"]);
  });
});
