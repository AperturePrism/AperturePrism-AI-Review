/** 真 PostgreSQL + HTTP 验证既有全局设置与并发导入保存不丢失。 */
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("../runtime.js", () => ({
  database: { db: {} },
  logger: { warn: vi.fn() },
  config: {},
}));
vi.mock("../identity.js", () => ({
  audit: vi.fn(),
  isAdminRequest: vi.fn(),
  isReadOnlyRequest: vi.fn(),
}));
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../../../packages/database/src/client.js";
import { loadSettings } from "../../../../packages/database/src/settings-store.js";
import {
  loadGlobalReviewRules,
  saveGlobalReviewRules,
  globalReviewRulesHash,
} from "../../../../packages/database/src/global-review-rules.js";
import { createGlobalRulesRoutes } from "./global-rules.js";
import { dispatch } from "../utils/routes.js";
import { HttpError } from "../utils/http.js";

const databaseUrl = process.env.APERTUREPRISM_INTEGRATION_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("global review rules PostgreSQL HTTP persistence", () => {
  let database: DatabaseClient;
  let previous: { value: string; updated_at: string } | undefined;
  let server: ReturnType<typeof createServer>;
  let url: string;
  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
    [previous] = await database.sql<
      { value: string; updated_at: string }[]
    >`select value,updated_at::text from system_settings where key='review_rules_global'`;
    await database.sql`delete from system_settings where key='review_rules_global'`;
    const routes = createGlobalRulesRoutes({
      isAdmin: async () => true,
      isReadOnly: async () => false,
      load: () => loadGlobalReviewRules(database.db),
      save: (input) => saveGlobalReviewRules(database.db, input),
      fetchSource: async () => ({
        content: "# 预览，不自动写入",
        sourceUrl: "https://rules.example/global.md",
      }),
      audit: () => undefined,
    });
    server = createServer((request, response) => {
      void dispatch(routes, request, response, "db-global-rules", {
        isAdmin: async () => true,
      }).catch((error) => {
        response.writeHead(error instanceof HttpError ? error.status : 500, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify({
            status: "error",
            reason: error instanceof Error ? error.message : "error",
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/repo-rules/global`;
  });
  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    if (!database) return;
    if (previous)
      await database.sql`insert into system_settings(key,value,updated_at) values('review_rules_global',${previous.value},${previous.updated_at}::timestamptz) on conflict(key) do update set value=excluded.value,updated_at=excluded.updated_at`;
    else
      await database.sql`delete from system_settings where key='review_rules_global'`;
    await database.close();
  });
  const put = async (content: string, expectedContentHash: string) =>
    fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, expectedContentHash }),
    });

  it("creates the existing settings key without migration and reads it back through HTTP", async () => {
    const initial = await (await fetch(url)).json();
    expect(initial.content).toBe("");
    expect(initial.updatedAt).toBeNull();
    const content = "# 全局审查规则\n必须提供代码证据。";
    const response = await put(content, initial.contentHash);
    expect(response.status).toBe(200);
    expect((await response.json()).content).toBe(content);
    const [row] =
      await database.sql`select value from system_settings where key='review_rules_global'`;
    expect(row?.value).toBe(content);
    expect(
      (await loadSettings(database.db, ["review_rules_global"])).get(
        "review_rules_global",
      ),
    ).toBe(content);
    expect((await (await fetch(url)).json()).content).toBe(content);
  });
  it("preserves an old global rule written through the previous settings storage", async () => {
    const content = "旧版本保留的 Markdown\r\n\t- 不要丢失。";
    await database.sql`update system_settings set value=${content} where key='review_rules_global'`;
    const read = await (await fetch(url)).json();
    expect(read.content).toBe(content);
    expect(read.contentHash).toBe(globalReviewRulesHash(content));
    expect(
      (await loadSettings(database.db, ["review_rules_global"])).get(
        "review_rules_global",
      ),
    ).toBe(content);
    expect(typeof read.updatedAt).toBe("string");
  });
  it("allows exactly one of two concurrent editors using the same old fingerprint", async () => {
    const current = await (await fetch(url)).json();
    const responses = await Promise.all([
      put("editor one", current.contentHash),
      put("editor two", current.contentHash),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = await responses.find((r) => r.status === 200)!.json();
    const read = await (await fetch(url)).json();
    expect(read.content).toBe(winner.content);
    expect(read.contentHash).toBe(winner.contentHash);
  });
  it("refuses a stale editor after a write from the legacy settings endpoint", async () => {
    const read = await (await fetch(url)).json();
    await database.sql`update system_settings set value='legacy editor update' where key='review_rules_global'`;
    expect((await put("stale import", read.contentHash)).status).toBe(409);
    expect((await (await fetch(url)).json()).content).toBe(
      "legacy editor update",
    );
  });
  it("URL preview does not write and an explicit clear retains the same key", async () => {
    const before = await (await fetch(url)).json();
    const preview = await fetch(url + "/from-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://rules.example/global.md" }),
    });
    expect(preview.status).toBe(200);
    expect((await (await fetch(url)).json()).contentHash).toBe(
      before.contentHash,
    );
    expect((await put("", before.contentHash)).status).toBe(200);
    const [row] =
      await database.sql`select value from system_settings where key='review_rules_global'`;
    expect(row?.value).toBe("");
  });
});
