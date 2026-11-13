import { describe, expect, it, vi } from "vitest";
import { createSessionSigner } from "./session.js";

const signer = createSessionSigner({
  clientId: "client-a",
  clientSecret: "secret-a",
  ttlMs: 60_000,
});

describe("session signer", () => {
  it("round-trips a login through sign and parse", () => {
    const token = signer.sign("octocat");
    expect(signer.parse(token)).toBe("octocat");
  });

  it("rejects a tampered payload", () => {
    const token = signer.sign("octocat");
    const [, sig] = token.split(".");
    const tampered = Buffer.from(
      JSON.stringify({ login: "mallory", exp: Date.now() + 60_000 }),
    ).toString("base64url");
    expect(signer.parse(`${tampered}.${sig}`)).toBeNull();
  });

  it("rejects a token signed by different credentials", () => {
    const other = createSessionSigner({
      clientId: "client-b",
      clientSecret: "secret-b",
      ttlMs: 60_000,
    });
    const token = other.sign("octocat");
    expect(signer.parse(token)).toBeNull();
  });

  it("rejects an expired token", () => {
    const expired = createSessionSigner({
      clientId: "client-a",
      clientSecret: "secret-a",
      ttlMs: -1,
    });
    const token = expired.sign("octocat");
    expect(signer.parse(token)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(signer.parse("no-dot")).toBeNull();
    expect(signer.parse("")).toBeNull();
  });
});

it("issues distinct persistent sessions for two logins in the same millisecond", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  try {
    const first = signer.sign("octocat");
    const second = signer.sign("octocat");
    expect(first).not.toBe(second);
    expect(signer.parse(first)).toBe("octocat");
    expect(signer.parse(second)).toBe("octocat");
  } finally {
    clock.mockRestore();
  }
});
