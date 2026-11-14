import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  config: { webuiApiToken: undefined as string | undefined, logLevel: "info" },
}));
vi.mock("./runtime.js", () => ({
  database: { db: { select: () => ({ from: mocks.from }) } },
  logger: { warn: vi.fn(), debug: vi.fn(), level: "info" },
  config: mocks.config,
}));

describe("authentication startup readiness", () => {
  it("does not treat uninitialized database overrides as open mode", async () => {
    vi.resetModules();
    mocks.config.webuiApiToken = undefined;
    let deliver: ((rows: { key: string; value: string }[]) => void) | undefined;
    mocks.from.mockReturnValue(
      new Promise((resolve) => {
        deliver = resolve;
      }),
    );
    const preferences = await import("./preferences.js");
    expect(preferences.authenticationReady()).toBe(false);
    const loading = preferences.refreshRuntimeSettings();
    expect(preferences.authenticationReady()).toBe(false);
    deliver!([{ key: "webui_api_token", value: "stored-only-token" }]);
    await loading;
    expect(preferences.authenticationReady()).toBe(true);
    expect(preferences.webuiToken()).toBe("stored-only-token");
  });
  it("keeps business authentication unavailable after a failed initial settings read", async () => {
    vi.resetModules();
    mocks.config.webuiApiToken = undefined;
    mocks.from.mockRejectedValue(new Error("database offline"));
    const preferences = await import("./preferences.js");
    await preferences.refreshRuntimeSettings();
    expect(preferences.authenticationReady()).toBe(false);
  });
  it("recognizes an explicitly configured environment bearer even when overrides are unavailable", async () => {
    vi.resetModules();
    mocks.config.webuiApiToken = "environment-token";
    mocks.from.mockRejectedValue(new Error("database offline"));
    const preferences = await import("./preferences.js");
    await preferences.refreshRuntimeSettings();
    expect(preferences.authenticationReady()).toBe(true);
    expect(preferences.webuiToken()).toBe("environment-token");
  });
});
