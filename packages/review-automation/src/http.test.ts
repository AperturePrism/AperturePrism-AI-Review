import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAutomation } from "./index.js";
import { createAutomationHttp } from "./http.js";
import type { AutomationActor } from "./types.js";

const cleanups: (() => Promise<void>)[] = [];
const actor: AutomationActor = {
  userId: "test-admin",
  isAdmin: true,
  canAccessRepository: () => true,
};
async function server(as = actor) {
  const directory = await mkdtemp(join(tmpdir(), "aperture-auto-http-"));
  const automation = createAutomation({ dataDirectory: directory });
  const handler = createAutomationHttp(automation);
  const application = createServer((request, response) => {
    void handler(request, response, as).then((handled) => {
      if (!handled) {
        response.statusCode = 404;
        response.end();
      }
    });
  });
  application.listen(0, "127.0.0.1");
  await once(application, "listening");
  cleanups.push(async () => {
    application.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      application.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  });
  return {
    automation,
    url: `http://127.0.0.1:${(application.address() as AddressInfo).port}`,
  };
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("automation HTTP boundary", () => {
  it("reads actual capabilities using the shared actor", async () => {
    const app = await server();
    const response = await fetch(
      app.url + "/api/automation?repository=owner/repo",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      data: { viewer: { userId: "test-admin", isAdmin: true, canWrite: true } },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("persists a rule through POST and returns it through GET", async () => {
    const app = await server();
    const response = await fetch(app.url + "/api/automation", {
      method: "POST",
      body: JSON.stringify({
        action: "rules.create",
        input: {
          repository: "owner/repo",
          name: "HTTP rule",
          condition: { all: [] },
          actions: [{ kind: "audit.record" }],
        },
      }),
    });
    expect(response.status).toBe(200);
    const list = await fetch(
      app.url + "/api/automation?action=rules.list&repository=owner/repo",
    );
    expect(await list.json()).toMatchObject({
      data: { total: 1, items: [{ name: "HTTP rule" }] },
    });
  });
  it("allows a read-only actor to trial a rule using POST without allowing mutations", async () => {
    const app = await server({
      ...actor,
      isAdmin: false,
      isReadOnly: true,
      canAccessRepository: () => true,
    });
    const event = {
      id: "test",
      type: "review.completed",
      repository: "owner/repo",
      occurredAt: "2026-11-13T10:00:00Z",
    };
    const rule = {
      name: "trial",
      condition: { all: [] },
      actions: [{ kind: "audit.record" }],
    };
    const trial = await fetch(app.url + "/api/automation", {
      method: "POST",
      body: JSON.stringify({
        action: "rules.preview",
        input: { repository: "owner/repo", rule, event },
      }),
    });
    expect(trial.status).toBe(200);
    expect(await trial.json()).toMatchObject({
      data: { matched: true, writes: false },
    });
    const write = await fetch(app.url + "/api/automation", {
      method: "POST",
      body: JSON.stringify({
        action: "rules.create",
        input: { repository: "owner/repo", ...rule },
      }),
    });
    expect(write.status).toBe(403);
    const summary = await fetch(
      app.url + "/api/automation?repository=owner/repo",
    );
    expect(await summary.json()).toMatchObject({
      data: { viewer: { canWrite: false } },
    });
  });
  it("does not allow a GET request to change rules", async () => {
    const app = await server();
    const response = await fetch(
      app.url +
        "/api/automation?repository=owner/repo&action=rules.delete&id=anything",
    );
    expect(response.status).toBe(405);
  });
  it("checks repository authorization before returning records", async () => {
    const app = await server({
      ...actor,
      isAdmin: false,
      canAccessRepository: () => false,
    });
    const response = await fetch(
      app.url + "/api/automation?repository=owner/repo&action=rules.list",
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  });
  it("reports invalid JSON as a fixable input error", async () => {
    const app = await server();
    const response = await fetch(app.url + "/api/automation", {
      method: "POST",
      body: "{",
    });
    expect(response.status).toBe(400);
  });
  it("returns a complete error for an oversized raw upload", async () => {
    const app = await server();
    const response = await fetch(app.url + "/api/automation", {
      method: "POST",
      body: "x".repeat(1024 * 1024 + 1),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "input_too_large" });
  });
  it("does not turn unknown subpaths into aliases of summary", async () => {
    const app = await server();
    expect(
      (await fetch(app.url + "/api/automation/unknown?repository=owner/repo"))
        .status,
    ).toBe(404);
  });
});
