import { describe, expect, it } from "vitest";
import { createLineReader } from "./update.js";

function read(chunks: readonly Buffer[]): string[] {
  const lines: string[] = [];
  const reader = createLineReader((line) => lines.push(line));
  for (const chunk of chunks) reader.write(chunk);
  reader.end();
  return lines;
}

describe("更新脚本日志行切分", () => {
  it("多字节 UTF-8 字符被 chunk 截断时不产生替换字符", () => {
    const bytes = Buffer.from('{"message":"更新完成"}\n');
    const split = bytes.indexOf(Buffer.from("更")) + 1;
    expect(read([bytes.subarray(0, split), bytes.subarray(split)])).toEqual([
      '{"message":"更新完成"}',
    ]);
  });

  it("跨 chunk 的 JSON 行和没有换行的尾行都会在 close 前输出", () => {
    expect(
      read([
        Buffer.from('{"level":"stage","sta'),
        Buffer.from('ge":"backup"}\nwarn'),
        Buffer.from("ing detail"),
      ]),
    ).toEqual(['{"level":"stage","stage":"backup"}', "warning detail"]);
  });

  it("同时识别 CRLF 与单独的 CR 进度行", () => {
    expect(read([Buffer.from("pull 10%\rpull 20%\r\nready\n")])).toEqual([
      "pull 10%",
      "pull 20%",
      "ready",
    ]);
  });
});
