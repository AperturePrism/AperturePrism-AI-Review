import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./runtime.js", () => ({
  database: { db: {} },
  config: {},
  logger: { warn: vi.fn() },
}));
vi.mock("./preferences.js", () => ({
  currentOAuth: () => ({
    clientId: "test-app",
    clientSecret: "test-oauth-secret",
  }),
  webuiToken: () => "admin-bearer-token",
}));
vi.mock("../../../packages/database/src/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getUser: vi.fn(),
  listGrantsForUser: vi.fn(),
  canAccessGrant: vi.fn(),
  findValidSession: vi.fn(),
}));
import {
  getUser,
  findValidSession,
  listGrantsForUser,
  canAccessGrant,
} from "../../../packages/database/src/index.js";
import {
  canAccessRepo,
  extractBearerOrQueryToken,
  isAdminRequest,
  isAuthorized,
  isReadOnlyRequest,
  sessionLogin,
  signSession,
  visibleRepoScope,
} from "./identity.js";

function request(
  headers: Record<string, string> = {},
  url = "/tasks",
): IncomingMessage {
  return { headers, url } as IncomingMessage;
}
const member = {
  login: "member",
  displayName: "Member",
  isAdmin: false,
  isReadOnly: false,
  passwordHash: null,
  hasPassword: false,
};
beforeEach(async () => {
  vi.mocked(findValidSession)
    .mockReset()
    .mockResolvedValue({
      id: "session",
      userLogin: "member",
      authMethod: "password",
      issuedAt: new Date(),
      expiresAt: new Date("2099-01-01"),
      lastSeenAt: new Date(),
      revokedAt: null,
      userAgent: null,
      ip: null,
    });
  vi.mocked(getUser).mockReset().mockResolvedValue(member);
  vi.mocked(listGrantsForUser).mockReset().mockResolvedValue([]);
  vi.mocked(canAccessGrant).mockReset().mockResolvedValue(false);
});

describe("authentication and role resolution share one credential", () => {
  it("does not promote a member bearer token when an invalid cookie is present", async () => {
    const input = request({
      authorization: `Bearer ${signSession("member")}`,
      cookie: "__ap_session=invalid-cookie",
    });
    expect(await isAuthorized(input)).toBe(true);
    expect(sessionLogin(input)).toBe("member");
    expect(await isAdminRequest(input)).toBe(false);
    expect(getUser).toHaveBeenCalledWith(expect.anything(), "member");
  });
  it("does not promote an empty bearer token by authenticating a cookie instead", async () => {
    const input = request({
      authorization: "Bearer ",
      cookie: `__ap_session=${signSession("member")}`,
    });
    expect(await isAuthorized(input)).toBe(false);
    expect(sessionLogin(input)).toBeNull();
    expect(await isAdminRequest(input)).toBe(false);
  });
  it("does not authenticate a bad bearer through another valid cookie", async () => {
    const input = request({
      authorization: "Bearer wrong",
      cookie: `__ap_session=${signSession("member")}`,
    });
    expect(await isAuthorized(input)).toBe(false);
    expect(await isAdminRequest(input)).toBe(false);
  });
  it("uses a shared administrator token consistently even beside a member cookie", async () => {
    const input = request({
      authorization: "Bearer admin-bearer-token",
      cookie: `__ap_session=${signSession("member")}`,
    });
    expect(await isAuthorized(input)).toBe(true);
    expect(sessionLogin(input)).toBeNull();
    expect(await isAdminRequest(input)).toBe(true);
    expect(getUser).not.toHaveBeenCalled();
  });
  it("accepts a signed member cookie without a bearer header", async () => {
    const input = request({
      cookie: `__ap_session=${encodeURIComponent(signSession("member"))}`,
    });
    expect(await isAuthorized(input)).toBe(true);
    expect(sessionLogin(input)).toBe("member");
    expect(await isAdminRequest(input)).toBe(false);
  });
  it("keeps a signed query token consistent for legacy SSE clients", async () => {
    const input = request(
      {},
      "/events?token=" + encodeURIComponent(signSession("member")),
    );
    expect(await isAuthorized(input)).toBe(true);
    expect(sessionLogin(input)).toBe("member");
  });
  it("does not accept an unauthenticated request as an administrator", async () => {
    expect(await isAdminRequest(request())).toBe(false);
    expect(getUser).not.toHaveBeenCalled();
  });
  it("compares UTF-8 byte lengths before a constant-time bearer comparison", async () => {
    const input = request({
      authorization: "Bearer " + "é".repeat("admin-bearer-token".length),
    });
    await expect(isAuthorized(input)).resolves.toBe(false);
    expect(await isAuthorized(input)).toBe(false);
  });
  it("rejects malformed URL-encoded cookies", async () => {
    expect(
      await isAuthorized(request({ cookie: "__ap_session=%bad%value" })),
    ).toBe(false);
  });
  it("chooses the bearer source before query and cookie sources", async () => {
    const input = request(
      { authorization: "Bearer expected", cookie: "__ap_session=cookie" },
      "/tasks?token=query",
    );
    expect(extractBearerOrQueryToken(input)).toBe("expected");
  });
});

describe("repository and read-only permissions", () => {
  it("returns an empty visibility scope for a member with no repository grants", async () => {
    const input = request({ authorization: `Bearer ${signSession("member")}` });
    const scope = await visibleRepoScope(input);
    expect(scope?.ids).toEqual(new Set());
    expect(scope?.fullNames).toEqual(new Set());
  });
  it("requires the requested manage level instead of accepting a view grant", async () => {
    const input = request({ authorization: `Bearer ${signSession("member")}` });
    expect(await canAccessRepo(input, "repo", "manage")).toBe(false);
    expect(canAccessGrant).toHaveBeenCalledWith(
      expect.anything(),
      "member",
      "repo",
      "manage",
    );
  });
  it("marks a read-only member even when they supply an invalid cookie", async () => {
    vi.mocked(getUser).mockResolvedValue({ ...member, isReadOnly: true });
    const input = request({
      authorization: `Bearer ${signSession("member")}`,
      cookie: "__ap_session=bad",
    });
    expect(await isReadOnlyRequest(input)).toBe(true);
  });
  it("recognizes persisted administrator roles", async () => {
    vi.mocked(getUser).mockResolvedValue({ ...member, isAdmin: true });
    const input = request({ authorization: `Bearer ${signSession("member")}` });
    expect(await isAdminRequest(input)).toBe(true);
    expect(await visibleRepoScope(input)).toBeNull();
  });
});

describe("persisted session revocation", () => {
  it("rejects a revoked or missing persistent session even when its signature is valid", async () => {
    vi.mocked(findValidSession).mockResolvedValue(null);
    const input = request({ authorization: `Bearer ${signSession("member")}` });
    expect(await isAuthorized(input)).toBe(false);
    expect(await isAdminRequest(input)).toBe(false);
  });
  it("checks the same token used for signature and role identification", async () => {
    const token = signSession("member");
    const input = request({
      authorization: `Bearer ${token}`,
      cookie: "__ap_session=wrong",
    });
    await isAuthorized(input);
    expect(findValidSession).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      token,
    );
  });
  it("rechecks long-lived SSE credentials after a session was revoked", async () => {
    const input = request({ authorization: `Bearer ${signSession("member")}` });
    expect(await isAuthorized(input)).toBe(true);
    vi.mocked(findValidSession).mockResolvedValue(null);
    expect(await isAuthorized(input, true)).toBe(false);
  });
});
