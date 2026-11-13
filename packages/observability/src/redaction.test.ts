/** 日志入口与独立脱敏的回归，检查深层凭据和日志容量。 */
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./index.js";
import { redactDiagnosticText, redactDiagnosticValue } from "./redaction.js";

describe("diagnostic redaction", () => {
  it("removes common credential formats and URL secrets", () => {
    const value = redactDiagnosticText(
      "Bearer secret-authorization https://user:password@example.test/x?api_key=topsecret&ok=1 sk-1234567890123 eyJhbGc.abcdef.signature",
    );
    expect(value).not.toContain("secret-authorization");
    expect(value).not.toContain("password@");
    expect(value).not.toContain("topsecret");
    expect(value).not.toContain("1234567890123");
    expect(value).not.toContain("eyJhbGc");
    expect(value).toContain("ok=1");
  });

  it("redacts complete PEM blocks and respects output length", () => {
    const value = redactDiagnosticText(
      "-----BEGIN PRIVATE KEY-----\nsecretmaterial\n-----END PRIVATE KEY----- tail",
    );
    expect(value).not.toContain("secretmaterial");
    expect(value).toContain("tail");
    expect(redactDiagnosticText("a".repeat(1_000), 10)).toHaveLength(10);
  });

  it("redacts credential keys at arbitrary depth and handles cycles", () => {
    const value: Record<string, unknown> = {
      account: {
        nested: { API_KEY: "key-value", messages: ["private prompt"] },
      },
      harmless: "visible",
    };
    value.self = value;
    const safe = redactDiagnosticValue(value);
    expect(JSON.stringify(safe)).toContain("visible");
    expect(JSON.stringify(safe)).not.toContain("key-value");
    expect(JSON.stringify(safe)).not.toContain("private prompt");
    expect(JSON.stringify(safe)).toContain("Circular");
  });

  it("limits depth and array size while retaining safe diagnostic fields", () => {
    const safe = redactDiagnosticValue(
      { deep: { inner: { more: "hidden" } }, list: [1, 2, 3] },
      { maxDepth: 2, maxItems: 2 },
    );
    expect(safe).toEqual({ deep: { inner: "[Depth limit]" }, list: [1, 2] });
  });

  it("sanitizes Error messages and does not expose source through stack traces", () => {
    const safe = redactDiagnosticValue(
      new Error("failed with Bearer abc-secret"),
    );
    expect(safe).toEqual({
      name: "Error",
      message: "failed with Bearer [REDACTED]",
    });
  });

  it("applies deep sanitization at the actual createLogger entry", () => {
    let output = "";
    const stream = new Writable({
      write(chunk, _encoding, done) {
        output += chunk.toString();
        done();
      },
    });
    const logger = createLogger("info", stream);
    logger.info(
      {
        nested: { deeper: { apiKey: "never-log-this" } },
        requestId: "r-1",
        failure: "Bearer credential-value",
      },
      "test",
    );
    expect(output).toContain("r-1");
    expect(output).not.toContain("never-log-this");
    expect(output).not.toContain("credential-value");
    expect(JSON.parse(output).msg).toBe("test");
  });
});
