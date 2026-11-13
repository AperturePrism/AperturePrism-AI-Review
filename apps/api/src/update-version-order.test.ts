import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleUpdateStatus } from "./update.js";

let registryVersion: string;
const fetchMock = vi.fn(async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes("/token?")) return Response.json({ token: "registry-token" });
  if (url.includes("/tags/list")) return Response.json({ tags: [registryVersion] });
  return new Response(null, {
    headers: { "docker-content-digest": `sha256:${url.split("/").at(-1)}` },
  });
});
async function status(): Promise<{ updateAvailable: boolean }> {
  let body = "";
  const response = {
    writeHead: vi.fn(),
    end: (value: string) => { body = value; },
  } as unknown as ServerResponse;
  await handleUpdateStatus(response, "test-request");
  return JSON.parse(body) as { updateAvailable: boolean };
}

beforeEach(() => {
  registryVersion = "v1.2.15";
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("UPDATE_VERSION", "v1.2.16");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("update version ordering", () => {
  it("does not advertise an older registry image as an update", async () => {
    expect((await status()).updateAvailable).toBe(false);
  });
  it("treats v-prefixed and unprefixed versions as the same release", async () => {
    vi.stubEnv("UPDATE_VERSION", "1.2.15");
    expect((await status()).updateAvailable).toBe(false);
  });
  it("continues to offer a genuinely newer release", async () => {
    registryVersion = "v1.3.0";
    expect((await status()).updateAvailable).toBe(true);
  });
  it("compares version components numerically", async () => {
    vi.stubEnv("UPDATE_VERSION", "v1.10.0");
    registryVersion = "v1.9.20";
    expect((await status()).updateAvailable).toBe(false);
  });
});
