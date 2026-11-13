import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

export type SessionSignerConfig = {
  clientId: string;
  clientSecret: string;
  ttlMs: number;
};

export type SessionSigner = {
  sign: (login: string) => string;
  /** Returns the login for a valid, unexpired token, or null. */
  parse: (token: string) => string | null;
};

/**
 * Stateless OAuth session tokens: `base64url({login,exp}).base64url(hmac)`.
 * The HMAC key is derived from the OAuth credentials, so a signed token only
 * verifies while the same credentials are configured.
 */
export function createSessionSigner(
  config: SessionSignerConfig,
): SessionSigner {
  const key = createHash("sha256")
    .update(`${config.clientSecret}:${config.clientId}`)
    .digest();

  const sign = (login: string): string => {
    const payload = Buffer.from(
      JSON.stringify({
        login,
        exp: Date.now() + config.ttlMs,
        nonce: randomUUID(),
      }),
    ).toString("base64url");
    const sig = createHmac("sha256", key).update(payload).digest("base64url");
    return `${payload}.${sig}`;
  };

  const parse = (token: string): string | null => {
    const dot = token.indexOf(".");
    if (dot === -1) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = createHmac("sha256", key).update(payload).digest();
    const received = Buffer.from(sig, "base64url");
    if (
      expected.length !== received.length ||
      !timingSafeEqual(expected, received)
    )
      return null;
    try {
      const data = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as { login?: unknown; exp?: unknown };
      if (typeof data.login !== "string") return null;
      if (typeof data.exp !== "number" || data.exp < Date.now()) return null;
      return data.login;
    } catch {
      return null;
    }
  };

  return { sign, parse };
}
