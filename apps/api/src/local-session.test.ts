import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
vi.mock("./runtime.js", () => ({
  database: { db: {} },
  config: { credentialMasterKey: "local-master-key" },
  logger: { warn: vi.fn() },
}));
vi.mock("./preferences.js", () => ({
  currentOAuth: () => ({ clientId: "", clientSecret: "" }),
  webuiToken: () => "local-admin-token",
}));
vi.mock("../../../packages/database/src/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  findValidSession: vi.fn(),
}));
import { findValidSession } from "../../../packages/database/src/index.js";
import { isAuthorized, sessionLogin, signSession } from "./identity.js";

describe("password sessions without GitHub OAuth", () => {
  it("signs and recognizes a persisted local session using the instance key", async () => {
    const token = signSession("local-admin");
    vi.mocked(findValidSession).mockResolvedValue({
      id: "session",
      userLogin: "local-admin",
      authMethod: "password",
      issuedAt: new Date(),
      expiresAt: new Date("2099-01-01"),
      lastSeenAt: new Date(),
      revokedAt: null,
      userAgent: null,
      ip: null,
    });
    const request = {
      headers: { authorization: `Bearer ${token}` },
      url: "/tasks",
    } as IncomingMessage;
    expect(sessionLogin(request)).toBe("local-admin");
    expect(await isAuthorized(request)).toBe(true);
    vi.mocked(findValidSession).mockResolvedValue(null);
    expect(await isAuthorized(request, true)).toBe(false);
  });
});
