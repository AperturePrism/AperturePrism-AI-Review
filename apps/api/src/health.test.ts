import { createHmac } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const UNCONFIGURED_PORT = 43211;
const CONFIGURED_PORT = 43212;
const PROTECTED_PORT = 43213;
const WEBUI_TOKEN = "protected-api-test-token";
const WEBHOOK_SECRET = "test-webhook-secret";

type ServerHandle = { process: ChildProcess; baseUrl: string };

type ServerOptions = {
  port: number;
  webhookSecret?: string;
  webuiToken?: string;
};

function startServer({
  port,
  webhookSecret,
  webuiToken,
}: ServerOptions): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/apps/api/src/main.js"], {
      cwd: resolvePath(process.cwd(), "apps/api"),
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL: "postgresql://prism:secret@127.0.0.1:1/prism",
        REDIS_URL: "redis://127.0.0.1:1",
        HEALTH_CHECK_TIMEOUT_MS: "200",
        ...(webhookSecret ? { GITHUB_WEBHOOK_SECRET: webhookSecret } : {}),
        ...(webuiToken ? { WEBUI_API_TOKEN: webuiToken } : {}),
      },
      stdio: "ignore",
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    let settled = false;
    const cleanup = () => {
      clearInterval(readinessCheck);
      clearTimeout(startupTimeout);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve({ process: child, baseUrl });
    };
    const readinessCheck = setInterval(() => {
      void fetch(`${baseUrl}/health/live`)
        .then((response) => {
          if (response.ok) finish();
        })
        .catch(() => undefined);
    }, 100);
    // Loading drizzle and the task engine over a network share is slow, so the
    // budget reflects measured cold-start rather than an optimistic guess.
    const startupTimeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`API did not start on port ${port}`));
    }, 90_000);

    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      if (!settled)
        finish(new Error(`API exited before listening with code ${code}`));
    });
  });
}

async function stopServer(handle: ServerHandle | undefined): Promise<void> {
  if (!handle) return;
  if (handle.process.exitCode !== null || handle.process.signalCode !== null)
    return;
  handle.process.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) =>
      handle.process.once("exit", () => resolve()),
    ),
    // Graceful shutdown can linger when the spawned API is closing
    // unreachable DB/Redis connections; fall back to SIGKILL after 8s.
    new Promise<void>((resolve) =>
      setTimeout(() => {
        try {
          handle.process.kill("SIGKILL");
        } catch {
          // process already gone
        }
        resolve();
      }, 8_000),
    ),
  ]);
}

async function fetchJson(
  handle: ServerHandle,
  path: string,
  method = "GET",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${handle.baseUrl}${path}`, { method });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe("API endpoints", () => {
  let unconfiguredServer: ServerHandle;
  let configuredServer: ServerHandle;
  let protectedServer: ServerHandle;

  beforeAll(async () => {
    [unconfiguredServer, configuredServer, protectedServer] = await Promise.all(
      [
        startServer({ port: UNCONFIGURED_PORT }),
        startServer({
          port: CONFIGURED_PORT,
          webhookSecret: WEBHOOK_SECRET,
        }),
        startServer({ port: PROTECTED_PORT, webuiToken: WEBUI_TOKEN }),
      ],
    );
  }, 120_000);

  afterAll(async () => {
    await Promise.all([
      stopServer(unconfiguredServer),
      stopServer(configuredServer),
      stopServer(protectedServer),
    ]);
  }, 60_000);

  it("protects every discovered non-public exact endpoint over real HTTP", async () => {
    const discovery = await fetch(`${protectedServer.baseUrl}/api/routes`, {
      headers: { authorization: `Bearer ${WEBUI_TOKEN}` },
    });
    expect(discovery.status).toBe(200);
    const registry = (await discovery.json()) as {
      items: { path: string; methods: string[]; match: string }[];
    };
    const publicPaths = new Set([
      "/health/live",
      "/health/ready",
      "/github/webhook",
      "/auth/status",
      "/auth/login",
      "/auth/callback",
      "/auth/register",
      "/setup/status",
    ]);
    let checked = 0;
    for (const route of registry.items) {
      if (route.match !== "exact" || publicPaths.has(route.path)) continue;
      const method = route.methods[0] ?? "GET";
      const result = await fetch(`${protectedServer.baseUrl}${route.path}`, {
        method,
      });
      expect(result.status, `${method} ${route.path}`).toBe(401);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(30);
  });

  it.each([
    "/api/workbench/summary",
    "/exports/tasks",
    "/exports/results",
    "/tasks/batch",
    "/repositories/00000000-0000-0000-0000-000000000001/queue",
    "/repo-rules/anything/file",
  ])("requires login before accessing %s", async (path) => {
    const result = await fetch(`${protectedServer.baseUrl}${path}`);
    expect(result.status).toBe(401);
  });

  it("returns the loaded OpenAPI paths through an authenticated HTTP request", async () => {
    const result = await fetch(`${protectedServer.baseUrl}/openapi.json`, {
      headers: { authorization: `Bearer ${WEBUI_TOKEN}` },
    });
    expect(result.status).toBe(200);
    const document = (await result.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(document.openapi).toBe("3.1.0");
    expect(document.paths["/tasks/batch"]).toBeDefined();
    expect(document.paths["/exports/tasks"]).toBeDefined();
  });

  it("allows invalid task batch input to fail at the user boundary before touching the database", async () => {
    const result = await fetch(`${protectedServer.baseUrl}/tasks/batch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${WEBUI_TOKEN}`,
        "content-type": "application/json",
        "x-request-id": "batch-input-test",
      },
      body: JSON.stringify({ action: "retry", taskIds: ["wrong-id"] }),
    });
    expect(result.status).toBe(400);
    expect(result.headers.get("x-request-id")).toBe("batch-input-test");
  });

  it("does not fall through a wrong method into a subject detail route", async () => {
    const result = await fetch(`${protectedServer.baseUrl}/results/delete`, {
      headers: { authorization: `Bearer ${WEBUI_TOKEN}` },
    });
    expect(result.status).toBe(405);
    expect(result.headers.get("allow")).toBe("POST");
  });

  it("does not treat Unicode bearer tokens as an internal server failure", async () => {
    const token = "é".repeat(WEBUI_TOKEN.length);
    const result = await fetch(`${protectedServer.baseUrl}/api/routes`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(result.status).toBe(401);
  });

  it("keeps known business paths closed until a database-only token can be loaded", async () => {
    const result = await fetch(`${unconfiguredServer.baseUrl}/tasks`);
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({
      reason: "authentication_not_ready",
    });
  });

  it("returns ok on /health/live regardless of dependencies", async () => {
    const { status } = await fetchJson(unconfiguredServer, "/health/live");
    expect(status).toBe(200);
  });

  it("/health/ready reports 503 when database and redis are unavailable", async () => {
    const { status, body } = await fetchJson(
      unconfiguredServer,
      "/health/ready",
    );
    expect(status).toBe(503);
    const deps = body.dependencies as {
      database: { status: string };
      redis: { status: string };
    };
    expect(deps.database.status).toBe("error");
    expect(deps.redis.status).toBe("error");
  });

  it("returns 404 for unknown routes", async () => {
    const { status } = await fetchJson(unconfiguredServer, "/nope");
    expect(status).toBe(404);
  });

  it("returns 503 when the webhook secret is not configured", async () => {
    const response = await fetch(
      `${unconfiguredServer.baseUrl}/github/webhook`,
      {
        method: "POST",
        body: "{}",
      },
    );
    expect(response.status).toBe(503);
  });

  it("returns 401 for an invalid signature", async () => {
    const response = await fetch(`${configuredServer.baseUrl}/github/webhook`, {
      method: "POST",
      headers: {
        "x-hub-signature-256": "sha256=invalid",
        "x-github-delivery": "delivery-1",
        "x-github-event": "ping",
      },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  it("returns 400 when GitHub headers are missing", async () => {
    const body = "{}";
    const signature = createHmac("sha256", WEBHOOK_SECRET)
      .update(body)
      .digest("hex");
    const response = await fetch(`${configuredServer.baseUrl}/github/webhook`, {
      method: "POST",
      headers: { "x-hub-signature-256": `sha256=${signature}` },
      body,
    });
    expect(response.status).toBe(400);
  });

  it("returns 405 for non-POST requests", async () => {
    const response = await fetch(`${configuredServer.baseUrl}/github/webhook`);
    expect(response.status).toBe(405);
  });
});
