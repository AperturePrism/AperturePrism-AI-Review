/** 通用设置接口不能绕过全局规则接口的管理员校验。 */
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("../runtime.js", () => {
  const db = {
    select: () => {
      const query = {
        from: () => query,
        orderBy: async () => state.rows,
      };
      return query;
    },
  };
  return {
    database: { db },
    config: {
      embedding: { model: "test-embedding" },
      qqOfficialIntents: 0,
      logLevel: "info",
      githubWebhookSecret: "",
    },
    logger: { warn: vi.fn() },
  };
});
vi.mock("../github.js", () => ({
  githubAppSlug: async () => null,
  githubAppConfiguredFlag: async () => false,
}));
vi.mock("../identity.js", () => ({ audit: vi.fn() }));
vi.mock("../preferences.js", () => ({
  WRITABLE_SETTING_KEYS: new Set(["review_rules_global", "log_level"]),
  SECRET_KEYS: new Set<string>(),
  refreshRuntimeSettings: vi.fn(),
  webhookEnabled: () => false,
  embeddingConfig: () => ({}),
  qqConfig: () => ({}),
  oauthConfigured: () => false,
  webuiToken: () => "",
}));

import { handleSettings } from "./settings.js";
import { dispatch } from "../utils/routes.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function serve() {
  const server = createServer((request, response) => {
    void dispatch(
      [{ path: "/settings", handle: handleSettings }],
      request,
      response,
      "settings-test",
      { isAdmin: async () => true },
    );
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("通用设置接口的专用键拦截", () => {
  it("拒绝通过 PUT /settings 写入全局审核规则", async () => {
    const response = await fetch((await serve()) + "/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "review_rules_global", value: "# bypass" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      reason: "dedicated_settings_endpoint_required",
      message: expect.stringContaining("全局审核规则接口"),
    });
  });

  it("GET /settings 不再返回全局审核规则", async () => {
    state.rows = [];
    const response = await fetch((await serve()) + "/settings");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: { key: string }[];
    };
    expect(body.items.some((item) => item.key === "review_rules_global")).toBe(
      false,
    );
  });
});
