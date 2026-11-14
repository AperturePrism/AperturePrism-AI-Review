/** 实际 HTTP 传输覆盖已保存密钥的模型发现，不调用付费模型。 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCredentialCipher } from "../../../../packages/config/src/credentials.js";

const state = vi.hoisted(() => ({
  rows: [] as unknown[][],
  key: "",
  baseUrls: {} as Record<string, string>,
  warn: vi.fn(),
  select: vi.fn(),
}));
vi.mock("../runtime.js", () => ({
  database: { db: { select: (...args: unknown[]) => state.select(...args) } },
  config: {
    get credentialMasterKey() {
      return state.key;
    },
    get modelProviderBaseUrls() {
      return state.baseUrls;
    },
  },
  logger: { warn: (...args: unknown[]) => state.warn(...args) },
}));
vi.mock("../identity.js", () => ({ audit: vi.fn() }));
import { handleProviders, readProviderModels, routes } from "./providers.js";
import { dispatch } from "../utils/routes.js";
import { json } from "../utils/http.js";

const servers: ReturnType<typeof createServer>[] = [];
const secret = "local-provider-credential-154";
const masterKey = Buffer.alloc(32, 7).toString("base64");
let sealed: string;
beforeEach(() => {
  sealed = createCredentialCipher(masterKey).seal(secret);
  state.key = masterKey;
  state.rows = [];
  state.baseUrls = {};
  state.warn.mockReset();
  state.select.mockReset().mockImplementation(() => {
    const rows = state.rows.shift() ?? [];
    const query = {
      from: () => query,
      where: () => query,
      limit: async () => rows,
      orderBy: async () => rows,
      then: (yes: (rows: unknown[]) => unknown) =>
        Promise.resolve(rows).then(yes),
    };
    return query;
  });
});
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
) {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(() => res.destroy());
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function api(admin = true) {
  return serve(async (req, res) => {
    if (
      !(await dispatch(routes, req, res, "local-request", {
        isAdmin: async () => admin,
      }))
    )
      json(res, 404, { reason: "not found" }, "local-request");
  });
}
async function post(origin: string, body: unknown) {
  return fetch(origin + "/setup/models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function savedRows(baseUrl: string) {
  state.rows = [[{ credential: sealed }], [{ value: baseUrl }]];
}

describe("saved provider model discovery", () => {
  it("uses the stored credential only on the server and normalizes the original URL", async () => {
    const captures: { url: string; authorization: string | undefined }[] = [];
    const upstream = await serve((req, res) => {
      captures.push({
        url: req.url!,
        authorization: req.headers.authorization,
      });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: [{ id: "z-model" }, { id: "a-model" }, { id: "a-model" }],
        }),
      );
    });
    savedRows(upstream + "/v1/");
    const response = await post(await api(), {
      provider: "old",
      accountName: "old-main",
      baseUrl: upstream + "/v1/chat/completions/",
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual({
      status: "ok",
      models: ["a-model", "z-model"],
    });
    expect(captures).toEqual([
      { url: "/v1/models", authorization: `Bearer ${secret}` },
    ]);
    expect(body).not.toContain(secret);
    expect(body).not.toContain(sealed);
  });
  it("keeps explicitly supplied keys compatible without reading an account", async () => {
    let authorization: string | undefined;
    const upstream = await serve((req, res) => {
      authorization = req.headers.authorization;
      res.end('{"data":[{"id":"new-model"}]}');
    });
    const response = await post(await api(), {
      baseUrl: upstream,
      apiKey: "local-new-key",
    });
    expect(response.status).toBe(200);
    expect(authorization).toBe("Bearer local-new-key");
    expect(state.select).not.toHaveBeenCalled();
  });
  it("uses an environment-only URL for existing accounts", async () => {
    const upstream = await serve((_req, res) =>
      res.end('{"data":[{"id":"legacy-model"}]}'),
    );
    state.baseUrls.old = upstream + "/v1";
    state.rows = [[{ credential: sealed }], []];
    const response = await post(await api(), {
      provider: "old",
      accountName: "old-main",
      baseUrl: upstream + "/v1",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ models: ["legacy-model"] });
  });
  it("fills legacy environment URLs in the provider editor without returning credentials", async () => {
    state.baseUrls.old = "https://legacy.example.test/v1";
    state.rows = [[], [{ provider: "old", name: "old-main" }], []];
    const origin = await serve((_req, res) => handleProviders(res, "test"));
    const text = await (await fetch(origin)).text();
    expect(JSON.parse(text).accounts).toEqual([
      {
        provider: "old",
        name: "old-main",
        baseUrl: "https://legacy.example.test/v1",
      },
    ]);
    expect(text).not.toContain(secret);
  });
  it("does not send a saved credential to an unsaved replacement address", async () => {
    const requests = vi.fn();
    const replacement = await serve((req, res) => {
      requests(req.headers);
      res.end('{"data":[]}');
    });
    savedRows("https://saved.example.test/v1");
    const response = await post(await api(), {
      provider: "old",
      accountName: "old-main",
      baseUrl: replacement + "/v1",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      reason: "saved_provider_url_changed",
    });
    expect(requests).not.toHaveBeenCalled();
  });
  it("does not follow a redirect with a saved credential", async () => {
    const requests = vi.fn();
    const target = await serve((req, res) => {
      requests(req.headers);
      res.end('{"data":[]}');
    });
    const upstream = await serve((_req, res) => {
      res.writeHead(302, { location: target + "/v1/models" });
      res.end();
    });
    savedRows(upstream + "/v1");
    const response = await post(await api(), {
      provider: "old",
      accountName: "old-main",
      baseUrl: upstream + "/v1",
    });
    expect(response.status).toBe(502);
    expect(requests).not.toHaveBeenCalled();
    expect(JSON.stringify(state.warn.mock.calls)).not.toContain(secret);
  });
  it("requires admin access before reading a saved credential", async () => {
    const response = await post(await api(false), {
      provider: "old",
      accountName: "old-main",
    });
    expect(response.status).toBe(403);
    expect(state.select).not.toHaveBeenCalled();
  });
  it("returns a useful error for a missing account", async () => {
    state.rows = [[]];
    const response = await post(await api(), {
      provider: "missing",
      accountName: "missing-main",
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      reason: "provider_account_not_found",
    });
  });
  it("does not substitute another account if credential decryption fails", async () => {
    savedRows("https://saved.example.test/v1");
    state.key = Buffer.alloc(32, 8).toString("base64");
    const response = await post(await api(), {
      provider: "old",
      accountName: "old-main",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      reason: "saved_credential_unavailable",
    });
    expect(JSON.stringify(state.warn.mock.calls)).not.toContain(sealed);
  });
  it("reports missing master-key configuration without returning a ciphertext", async () => {
    savedRows("https://saved.example.test/v1");
    state.key = "";
    const response = await post(await api(), {
      provider: "old",
      accountName: "old-main",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      reason: "master_key_missing",
    });
  });
  it("redacts an upstream credential echo in returned diagnostics", async () => {
    const upstream = await serve((_req, res) => {
      res.writeHead(401);
      res.end(`Invalid Authorization Bearer ${secret}`);
    });
    savedRows(upstream + "/v1");
    const response = await post(await api(), {
      provider: "old",
      accountName: "old-main",
    });
    const body = await response.text();
    expect(response.status).toBe(502);
    expect(JSON.parse(body)).toMatchObject({
      reason: "models_request_failed",
      httpStatus: 401,
    });
    expect(body).not.toContain(secret);
    expect(JSON.stringify(state.warn.mock.calls)).not.toContain(secret);
  });
  it.each([secret, `provider/${secret}/model`])(
    "rejects a successful model list that only echoes the saved credential: %s",
    async (id) => {
      const upstream = await serve((_req, res) =>
        res.end(JSON.stringify({ data: [{ id }] })),
      );
      savedRows(upstream + "/v1");
      const response = await post(await api(), {
        provider: "old",
        accountName: "old-main",
      });
      const text = await response.text();
      expect(response.status).toBe(502);
      expect(JSON.parse(text)).toMatchObject({
        reason: "models_credential_echo",
      });
      expect(JSON.parse(text)).not.toHaveProperty("models");
      expect(text).not.toContain(secret);
      expect(JSON.stringify(state.warn.mock.calls)).not.toContain(secret);
    },
  );
  it("keeps real model IDs while discarding raw and embedded credential echoes", async () => {
    const ids = [
      "vendor/model:v2",
      secret,
      `echo-${secret}`,
      "https://models.example.test/org/nested/model",
    ];
    const upstream = await serve((_req, res) =>
      res.end(JSON.stringify({ data: ids.map((id) => ({ id })) })),
    );
    savedRows(upstream + "/v1");
    const response = await post(await api(), {
      provider: "old",
      accountName: "old-main",
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text).models).toEqual([
      "https://models.example.test/org/nested/model",
      "vendor/model:v2",
    ]);
    expect(text).not.toContain(secret);
  });
  it("preserves a legitimate nested API path and ordinary model IDs", async () => {
    const requests: string[] = [];
    const upstream = await serve((req, res) => {
      requests.push(req.url!);
      res.end('{"data":[{"id":"org/model-a"},{"id":"org/model-b:v3"}]}');
    });
    savedRows(upstream + "/gateway/tenant/openai/v1/");
    const response = await post(await api(), {
      provider: "old",
      accountName: "old-main",
      baseUrl: upstream + "/gateway/tenant/openai/v1/models/",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      models: ["org/model-a", "org/model-b:v3"],
    });
    expect(requests).toEqual(["/gateway/tenant/openai/v1/models"]);
  });
});

describe("bounded model-list HTTP responses", () => {
  it.each(["not json", '{"data":{}}', "[]"])(
    "rejects an invalid response instead of reporting an empty successful list: %s",
    async (body) => {
      const upstream = await serve((_req, res) => res.end(body));
      await expect(readProviderModels(upstream, secret)).rejects.toMatchObject({
        reason: "invalid_models_response",
      });
    },
  );
  it("times out while reading a response body after headers have arrived", async () => {
    const upstream = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"data":[');
      setTimeout(() => res.end("]}"), 250);
    });
    await expect(
      readProviderModels(upstream, secret, { timeoutMs: 40 }),
    ).rejects.toMatchObject({ reason: "models_fetch_timeout" });
  });
  it("rejects oversized data with a bounded allocation", async () => {
    const upstream = await serve((_req, res) =>
      res.end("x".repeat(2 * 1024 * 1024 + 1)),
    );
    await expect(readProviderModels(upstream, secret)).rejects.toMatchObject({
      reason: "models_response_too_large",
    });
  });
  it.each([
    "https://user:password@example.test/v1",
    "https://example.test/v1?key=bad",
    "file:///tmp/model-list",
  ])("rejects unsafe URL credential placement %s", async (url) => {
    await expect(readProviderModels(url, secret)).rejects.toMatchObject({
      reason: "invalid_provider_url",
    });
  });
});
