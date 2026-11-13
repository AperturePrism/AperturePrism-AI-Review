import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { drizzle } from "drizzle-orm/pg-proxy";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as schema from "../../../packages/database/src/schema.js";
import {
  finishUpdate,
  readUpdateHistory,
  reconcileUpdateHistory,
  reserveUpdate,
  type UpdateHistoryEntry,
} from "./update-history.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  readFileSync: vi.fn(),
}));

const NOW = new Date("2026-11-13T12:00:00.000Z");
const spawnMock = vi.mocked(spawn);
let api: typeof import("./update.js");

function attempt(overrides: Partial<UpdateHistoryEntry> = {}): UpdateHistoryEntry {
  return {
    id: "attempt-1",
    at: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    from: "v1.2.16",
    to: "v1.2.18",
    status: "pending",
    ok: false,
    ...overrides,
  };
}

/** Real Drizzle SQL/result mapping with an in-memory transaction transport.
 * pg-proxy does not implement transactions, so the boundary serializes and
 * commits/rolls back staged values. This is not a live PostgreSQL lock test. */
function historyDatabase(initial?: UpdateHistoryEntry[]) {
  let stored = initial === undefined ? undefined : JSON.stringify(initial);
  let queue = Promise.resolve();
  let active = 0;
  const calls: { query: string; params: unknown[] }[] = [];
  const controls = {
    failReads: 0,
    failWrites: 0,
    beforeWrite: undefined as ((items: UpdateHistoryEntry[]) => Promise<void>) | undefined,
  };
  const database = {
    transaction: <T>(operation: (tx: ReturnType<typeof drizzle>) => Promise<T>): Promise<T> => {
      const run = queue.then(async () => {
        active += 1;
        let staged = stored;
        calls.push({ query: "BEGIN", params: [] });
        const tx = drizzle(async (query, params, method) => {
          calls.push({ query, params });
          if (query.startsWith("set local ") || query.startsWith("select pg_advisory_xact_lock")) {
            return { rows: [] };
          }
          if (query.startsWith('select "value" from "system_settings"')) {
            if (controls.failReads > 0) {
              controls.failReads -= 1;
              throw new Error("read failed");
            }
            expect(params[0]).toBe("update_history");
            return { rows: staged === undefined ? [] : method === "all" ? [[staged]] : [{ value: staged }] };
          }
          if (query.startsWith('insert into "system_settings"')) {
            expect(params[0]).toBe("update_history");
            expect(typeof params[1]).toBe("string");
            const value = String(params[1]);
            await controls.beforeWrite?.(JSON.parse(value) as UpdateHistoryEntry[]);
            if (controls.failWrites > 0) {
              controls.failWrites -= 1;
              throw new Error("write failed");
            }
            staged = value;
            return { rows: [] };
          }
          throw new Error(`Unexpected SQL: ${query}`);
        });
        try {
          const result = await operation(tx);
          stored = staged;
          calls.push({ query: "COMMIT", params: [] });
          return result;
        } catch (error) {
          calls.push({ query: "ROLLBACK", params: [] });
          throw error;
        } finally {
          active -= 1;
        }
      });
      queue = run.then(() => undefined, () => undefined);
      return run;
    },
  };
  return {
    db: database as unknown as PostgresJsDatabase<typeof schema>,
    calls,
    controls,
    items: () => (stored === undefined ? [] : JSON.parse(stored) as UpdateHistoryEntry[]),
    active: () => active,
    setRaw: (value: string) => { stored = value; },
  };
}

function makeResponse() {
  const events = new EventEmitter();
  let body = "";
  let status = 0;
  let headers: Record<string, string> = {};
  const write = vi.fn((chunk: string) => { body += chunk; return true; });
  const writeHead = vi.fn((code: number, values: Record<string, string>) => {
    status = code;
    headers = values;
  });
  const end = vi.fn((chunk?: string) => { body += chunk ?? ""; });
  const response = Object.assign(events, { write, writeHead, end, destroy: vi.fn() });
  return {
    response: response as unknown as ServerResponse,
    write,
    writeHead,
    end,
    emit: events.emit.bind(events),
    body: () => body,
    json: () => JSON.parse(body) as Record<string, unknown>,
    status: () => status,
    headers: () => headers,
    sse: () => body.split("\n\n").flatMap((part) => {
      const type = part.match(/^event: (.+)$/m)?.[1];
      const data = part.match(/^data: (.+)$/m)?.[1];
      return type && data ? [{ type, data: JSON.parse(data) as Record<string, unknown> }] : [];
    }),
  };
}

function makeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
  });
  spawnMock.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}

function request(body: unknown = { target: "v1.2.18" }): IncomingMessage {
  return Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
}

function mockRegistry(options: {
  tags?: string[]; primaryDown?: boolean; missingDigest?: boolean; sameDigest?: boolean;
} = {}) {
  const { tags = ["v1.2.18"], primaryDown = false, missingDigest = false, sameDigest = false } = options;
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (primaryDown && url.host === "ghcr.io") throw new Error("primary down");
    if (url.pathname === "/token") return Response.json({ token: "test-token" });
    if (url.pathname.endsWith("/tags/list")) return Response.json({ tags });
    if (url.pathname.includes("/manifests/")) {
      return new Response(null, {
        headers: missingDigest ? {} : {
          "docker-content-digest": sameDigest || url.pathname.endsWith("/v1.2.17")
            ? "sha256:current" : "sha256:latest",
        },
      });
    }
    throw new Error(`Unexpected registry URL: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  spawnMock.mockReset();
  vi.setSystemTime(NOW);
  vi.mocked(readFileSync).mockReturnValue('{"version":"1.2.17"}');
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Live network is forbidden"); }));
  api = await import("./update.js");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("isValidUpdateTarget", () => {
  it.each(["1.0.83", "v1.0.83", "2.1.0", "latest", "stable"])("accepts %s", (target) => {
    expect(api.isValidUpdateTarget(target)).toBe(true);
  });
  it.each([
    "", "1.2", "1.2.3.4", "v1.0", "release-1.0.83", "1.0.83 ", "1.0.83\n",
    "v1.2.3\r\n", "latest\n", "stable\n", "v1.2.3\u2028", "main", "01.2.3",
    "1.2.3;reboot", "1.2.3-beta.1",
  ])("rejects malformed target %j", (target) => {
    expect(api.isValidUpdateTarget(target)).toBe(false);
  });
});

describe("currentVersion", () => {
  it("prefers the baked root package over both conflicting env versions", () => {
    vi.stubEnv("UPDATE_VERSION", "v9.0.0");
    vi.stubEnv("IMAGE_TAG", "v1.0.0");
    expect(api.currentVersion()).toBe("v1.2.17");
    expect(readFileSync).toHaveBeenCalledWith(resolve(process.cwd(), "package.json"), "utf8");
    expect(api.currentVersion()).toBe("v1.2.17");
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });
  it("uses UPDATE_VERSION only when the baked package is unavailable", () => {
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error("missing"); });
    vi.stubEnv("UPDATE_VERSION", "v1.2.16");
    vi.stubEnv("IMAGE_TAG", "1.2.15");
    expect(api.currentVersion()).toBe("v1.2.16");
  });
  it.each(["latest", "stable", "", "invalid"])("skips %j to a real IMAGE_TAG fallback", (channel) => {
    vi.mocked(readFileSync).mockReturnValue("{}");
    vi.stubEnv("UPDATE_VERSION", channel);
    vi.stubEnv("IMAGE_TAG", "1.2.15");
    expect(api.currentVersion()).toBe("1.2.15");
  });
  it("returns unknown instead of mutable channels when the package is unavailable", () => {
    vi.mocked(readFileSync).mockReturnValue("not JSON");
    vi.stubEnv("UPDATE_VERSION", "latest");
    vi.stubEnv("IMAGE_TAG", "stable");
    expect(api.currentVersion()).toBe("unknown");
  });
});

describe("history reconciliation", () => {
  it.each(["1.2.18", "v1.2.18"])("confirms pending against exact baked runtime %s", (runtime) => {
    expect(reconcileUpdateHistory([attempt()], runtime, NOW))
      .toMatchObject({ inProgress: false, items: [{ status: "success", ok: true, updatedAt: NOW.toISOString() }] });
  });
  it.each(["v1.2.17", "v1.2.19", "latest", "unknown"])("does not pretend success for runtime %s", (runtime) => {
    const items = [attempt()];
    const state = reconcileUpdateHistory(items, runtime, NOW);
    expect(state).toEqual({ items, inProgress: true });
    expect(state.items).toBe(items);
  });
  it("normalizes a non-v target in the other direction", () => {
    expect(reconcileUpdateHistory([attempt({ to: "1.2.18" })], "v1.2.18", NOW).items[0]?.ok).toBe(true);
  });
  it("never confirms a running script, even on the requested runtime", () => {
    expect(reconcileUpdateHistory([attempt({ status: "running" })], "v1.2.18", NOW))
      .toMatchObject({ inProgress: true, items: [{ status: "running", ok: false }] });
  });
  it("confirms a late first read if the exact requested runtime is present", () => {
    expect(reconcileUpdateHistory([attempt()], "v1.2.18", new Date(NOW.getTime() + 10 * 60_000)))
      .toMatchObject({ inProgress: false, items: [{ status: "success", ok: true }] });
  });
  it.each([
    ["pending", 3, "confirmation_timeout"], ["running", 30, "script_timeout"],
  ] as const)("expires %s with a distinct reason", (status, minutes, reason) => {
    expect(reconcileUpdateHistory([attempt({ status })], "v1.2.17", new Date(NOW.getTime() + minutes * 60_000)))
      .toMatchObject({ inProgress: false, items: [{ status: "failed", ok: false, reason }] });
  });
  it("does not rewrite legacy bool-only history or older pending entries", () => {
    const legacy = { at: NOW.toISOString(), from: "latest", to: "v1.2.18", ok: true };
    const items = [legacy, attempt()];
    expect(reconcileUpdateHistory(items, "v1.2.18", NOW)).toEqual({ items, inProgress: false });
    expect(reconcileUpdateHistory(items, "v1.2.18", NOW).items).toBe(items);
  });
});

describe("durable history SQL contract", () => {
  it("uses bounded transaction-scoped locking and reserves an absent history row", async () => {
    const history = historyDatabase();
    const entry = await reserveUpdate(history.db, "v1.2.17", "v1.2.18", "v1.2.17");
    expect(entry).toMatchObject({ from: "v1.2.17", to: "v1.2.18", status: "running", ok: false });
    expect(entry?.id).toEqual(expect.any(String));
    expect(history.items()).toEqual([entry]);
    expect(history.calls.slice(0, 4).map(({ query }) => query)).toEqual([
      "BEGIN", "set local lock_timeout = '5s'", "set local statement_timeout = '5s'",
      "select pg_advisory_xact_lock(hashtext($1))",
    ]);
    expect(history.calls.find(({ query }) => query.startsWith("insert"))?.query)
      .toContain('on conflict ("key") do update');
    expect(history.calls.at(-1)?.query).toBe("COMMIT");
  });
  it("allows only one simultaneous reservation including the initially missing row", async () => {
    const history = historyDatabase();
    const results = await Promise.all([
      reserveUpdate(history.db, "v1.2.17", "v1.2.18", "v1.2.17"),
      reserveUpdate(history.db, "v1.2.17", "v1.2.19", "v1.2.17"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(history.items()).toHaveLength(1);
  });
  it("rolls back a failed write and permits a subsequent reservation", async () => {
    const history = historyDatabase();
    history.controls.failWrites = 1;
    await expect(reserveUpdate(history.db, "v1.2.17", "v1.2.18", "v1.2.17")).rejects.toThrow();
    expect(history.items()).toEqual([]);
    expect(history.calls.at(-1)?.query).toBe("ROLLBACK");
    expect(await reserveUpdate(history.db, "v1.2.17", "v1.2.18", "v1.2.17")).not.toBeNull();
  });
  it("keeps legacy history equivalent without an unnecessary write", async () => {
    const legacy = { at: NOW.toISOString(), from: "v1.2.15", to: "latest", ok: true };
    const history = historyDatabase([legacy]);
    expect(await readUpdateHistory(history.db, "v1.2.17")).toEqual({ items: [legacy], inProgress: false });
    expect(history.calls.some(({ query }) => query.startsWith("insert"))).toBe(false);
  });
  it("does not resurrect an expired running attempt on a late zero exit", async () => {
    const history = historyDatabase([attempt({ status: "running", updatedAt: new Date(NOW.getTime() - 30 * 60_000).toISOString() })]);
    await readUpdateHistory(history.db, "v1.2.18");
    expect(await finishUpdate(history.db, "attempt-1", true))
      .toMatchObject({ status: "failed", reason: "script_timeout", ok: false });
  });
  it("preserves only 50 entries on reservation", async () => {
    const history = historyDatabase(Array.from({ length: 50 }, (_, n) => attempt({ id: `old-${n}`, status: "failed" })));
    await reserveUpdate(history.db, "v1.2.17", "v1.2.18", "v1.2.17");
    expect(history.items()).toHaveLength(50);
    expect(history.items().at(-1)?.id).toBe("old-48");
  });
});

describe("GET /update/history", () => {
  it("returns fresh runtime and durable in-progress state", async () => {
    const history = historyDatabase([attempt()]);
    const res = makeResponse();
    await api.handleUpdateHistory(res.response, "request-1", history.db);
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({ items: [attempt()], currentVersion: "v1.2.17", inProgress: true });
  });
  it("confirms pending from the new baked runtime after API restart", async () => {
    const history = historyDatabase([attempt()]);
    vi.mocked(readFileSync).mockReturnValue('{"version":"1.2.18"}');
    const res = makeResponse();
    await api.handleUpdateHistory(res.response, "request-1", history.db);
    expect(res.json()).toMatchObject({ currentVersion: "v1.2.18", inProgress: false, items: [{ ok: true, status: "success" }] });
    expect(history.items()[0]?.status).toBe("success");
  });
  it("never uses target-looking env fallback as confirmation evidence", async () => {
    const history = historyDatabase([attempt()]);
    vi.mocked(readFileSync).mockReturnValue("{}");
    vi.stubEnv("UPDATE_VERSION", "v1.2.18");
    const res = makeResponse();
    await api.handleUpdateHistory(res.response, "request-1", history.db);
    expect(res.json()).toMatchObject({ currentVersion: "v1.2.18", inProgress: true, items: [{ status: "pending", ok: false }] });
  });
  it("durably expires pending without claiming requested target as currentVersion", async () => {
    const history = historyDatabase([attempt({ updatedAt: new Date(NOW.getTime() - 3 * 60_000).toISOString() })]);
    const res = makeResponse();
    await api.handleUpdateHistory(res.response, "request-1", history.db);
    expect(res.json()).toMatchObject({ currentVersion: "v1.2.17", inProgress: false, items: [{ status: "failed", reason: "confirmation_timeout", ok: false }] });
    expect(history.items()[0]?.status).toBe("failed");
  });
  it.each(["db read error", "corrupt history"])("fails closed on %s", async (failure) => {
    const history = historyDatabase();
    if (failure === "db read error") history.controls.failReads = 1;
    else history.setRaw("{broken");
    const res = makeResponse();
    await api.handleUpdateHistory(res.response, "request-1", history.db);
    expect(res.status()).toBe(503);
    expect(res.json()).toMatchObject({ reason: "history_read_failed" });
  });
});

describe("GET /update/status", () => {
  it.each([
    ["v1.2.18", true], ["1.2.17", false], ["v1.2.17", false], ["v1.2.16", false],
  ])("compares normalized semver without offering a downgrade to %s", async (tag, available) => {
    mockRegistry({ tags: [String(tag)] });
    const res = makeResponse();
    await api.handleUpdateStatus(res.response, "request-1", historyDatabase().db);
    expect(res.status()).toBe(200);
    expect(res.json()).toMatchObject({ updateAvailable: available, current: { version: "v1.2.17" } });
    expect(res.headers()["cache-control"]).toBe("no-store");
  });
  it.each([{ tags: [] }, { missingDigest: true }, { primaryDown: true }])("reports unknown for missing/stale metadata %j", async (options) => {
    mockRegistry(options);
    const res = makeResponse();
    await api.handleUpdateStatus(res.response, "request-1", historyDatabase().db);
    expect(res.json().updateAvailable).toBeNull();
  });
  it("does not offer newer semver if image content is unchanged", async () => {
    mockRegistry({ sameDigest: true });
    const res = makeResponse();
    await api.handleUpdateStatus(res.response, "request-1", historyDatabase().db);
    expect(res.json().updateAvailable).toBe(false);
  });
  it("reports durable pending across restart even during registry failure", async () => {
    const res = makeResponse();
    await api.handleUpdateStatus(res.response, "request-1", historyDatabase([attempt()]).db);
    expect(res.status()).toBe(503);
    expect(res.json()).toMatchObject({ inProgress: true, updateAvailable: null, reason: "registry_unreachable" });
  });
});

describe("POST /update/apply", () => {
  it("persists running before spawn/started and pending before done/client refetch", async () => {
    const history = historyDatabase();
    const res = makeResponse();
    const collect = res.write.getMockImplementation()!;
    res.write.mockImplementation((chunk: string) => {
      if (chunk.includes("event: started")) expect(history.items()[0]?.status).toBe("running");
      if (chunk.includes("event: done")) expect(history.items()[0]?.status).toBe("pending");
      return collect(chunk);
    });
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      expect(history.items()[0]).toMatchObject({ status: "running", ok: false, from: "v1.2.17", to: "v1.2.18" });
      expect(history.active()).toBe(0);
      return child as unknown as ReturnType<typeof spawn>;
    });
    const completion = api.handleUpdateApply(request(), res.response, "request-1", true, history.db);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    expect(res.sse()[0]).toMatchObject({ type: "started", data: { id: history.items()[0]?.id, previous: "v1.2.17", target: "v1.2.18" } });
    child.emit("close", 0);
    await completion;
    expect(history.items()[0]).toMatchObject({ status: "pending", ok: false });
    expect(res.sse().at(-1)).toEqual({ type: "done", data: { ok: true, previous: "v1.2.17", applied: "v1.2.18", restartPending: true } });
    const fresh = makeResponse();
    await api.handleUpdateHistory(fresh.response, "request-2", history.db);
    expect(fresh.json()).toMatchObject({ inProgress: true, currentVersion: "v1.2.17" });
  });
  it.each(["running", "pending"] as const)("rejects persisted %s after restart without registry/spawn/audit effects", async (status) => {
    const history = historyDatabase([attempt({ status })]);
    const res = makeResponse();
    const audit = vi.fn();
    await api.handleUpdateApply(request({ target: "latest" }), res.response, "request-1", true, history.db, audit);
    expect(res.status()).toBe(409);
    expect(res.json()).toMatchObject({ reason: "update_in_progress" });
    expect(fetch).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
  it("serializes concurrent applies so only one script launches", async () => {
    const history = historyDatabase();
    const child = makeChild();
    const one = makeResponse();
    const two = makeResponse();
    const first = api.handleUpdateApply(request(), one.response, "request-1", true, history.db);
    const second = api.handleUpdateApply(request(), two.response, "request-2", true, history.db);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    child.emit("close", 1);
    await Promise.all([first, second]);
    expect([one.status(), two.status()].sort()).toEqual([200, 409]);
    expect(history.items()).toHaveLength(1);
  });
  it("blocks a second local child even after durable running history expires", async () => {
    const history = historyDatabase();
    const child = makeChild();
    const res = makeResponse();
    const completion = api.handleUpdateApply(request(), res.response, "request-1", true, history.db);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    vi.setSystemTime(new Date(NOW.getTime() + 31 * 60_000));
    const state = makeResponse();
    await api.handleUpdateHistory(state.response, "request-2", history.db);
    expect(state.json()).toMatchObject({ inProgress: true, items: [{ status: "failed", reason: "script_timeout" }] });
    const blocked = makeResponse();
    await api.handleUpdateApply(request(), blocked.response, "request-3", true, history.db);
    expect(blocked.status()).toBe(409);
    expect(spawnMock).toHaveBeenCalledOnce();
    child.emit("close", 0);
    await completion;
    expect(history.items()[0]?.status).toBe("failed");
    const nextChild = makeChild();
    const next = makeResponse();
    const nextCompletion = api.handleUpdateApply(request(), next.response, "request-4", true, history.db);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    nextChild.emit("close", 1);
    await nextCompletion;
  });
  it.each(["latest", "stable"])("pins %s to the highest primary-registry immutable tag outside the DB lock", async (channel) => {
    const history = historyDatabase();
    const fetchMock = mockRegistry({ tags: ["stable", "v1.2.9", "1.2.19", "v1.2.18", "v1.3.0-beta.1", "latest"] });
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input) => { expect(history.active()).toBe(0); return original(input); });
    const child = makeChild();
    const res = makeResponse();
    const audit = vi.fn();
    const completion = api.handleUpdateApply(request({ target: channel, backupBefore: false }), res.response, "request-1", true, history.db, audit);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    expect(history.items()[0]?.to).toBe("1.2.19");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ target: "1.2.19", backupBefore: false }));
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["--target", "1.2.19"]));
    expect(spawnMock.mock.calls[0]?.[1]).not.toContain("--backup");
    child.emit("close", 0);
    await completion;
  });
  it.each(["primary down", "no semver"])("fails closed resolving latest with %s", async (failure) => {
    const history = historyDatabase();
    mockRegistry(failure === "primary down" ? { primaryDown: true } : { tags: ["latest", "stable"] });
    const res = makeResponse();
    const audit = vi.fn();
    await api.handleUpdateApply(request({ target: "latest" }), res.response, "request-1", true, history.db, audit);
    expect(res.status()).toBe(503);
    expect(res.json()).toMatchObject({ reason: "target_resolution_failed" });
    expect(history.items()).toEqual([]);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
  it("does not call the registry for an exact semver", async () => {
    const history = historyDatabase();
    const child = makeChild();
    const res = makeResponse();
    const completion = api.handleUpdateApply(request({ target: "1.2.18" }), res.response, "request-1", true, history.db);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    expect(fetch).not.toHaveBeenCalled();
    child.emit("close", 0);
    await completion;
  });
  it("records nonzero script/helper-launch exit as failed", async () => {
    const history = historyDatabase();
    const child = makeChild();
    const res = makeResponse();
    const completion = api.handleUpdateApply(request(), res.response, "request-1", true, history.db);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    child.emit("close", 1);
    await completion;
    expect(history.items()[0]).toMatchObject({ status: "failed", ok: false, reason: "script_exit_1" });
    expect(res.sse().at(-1)).toMatchObject({ type: "done", data: { ok: false, restartPending: false, reason: "script_exit_1" } });
  });
  it("settles error followed by close exactly once", async () => {
    const history = historyDatabase();
    const child = makeChild();
    const res = makeResponse();
    const completion = api.handleUpdateApply(request(), res.response, "request-1", true, history.db);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    child.emit("error", new Error("spawn ENOENT"));
    child.emit("close", 0);
    await completion;
    expect(history.items()[0]).toMatchObject({ status: "failed", reason: "script_start_failed" });
    expect(res.sse().filter(({ type }) => type === "done")).toHaveLength(1);
    expect(history.calls.filter(({ query }) => query.startsWith("insert"))).toHaveLength(2);
  });
  it("persists synchronous spawn failure and releases the reservation", async () => {
    const history = historyDatabase();
    spawnMock.mockImplementation(() => { throw new Error("cannot spawn"); });
    const res = makeResponse();
    await api.handleUpdateApply(request(), res.response, "request-1", true, history.db);
    expect(history.items()[0]).toMatchObject({ status: "failed", reason: "script_start_failed" });
    expect(await reserveUpdate(history.db, "v1.2.17", "v1.2.19", "v1.2.17")).not.toBeNull();
  });
  it("never spawns when the initial durable running write fails", async () => {
    const history = historyDatabase();
    history.controls.failWrites = 1;
    const res = makeResponse();
    await api.handleUpdateApply(request(), res.response, "request-1", true, history.db);
    expect(res.status()).toBe(503);
    expect(res.json()).toMatchObject({ reason: "history_write_failed" });
    expect(history.items()).toEqual([]);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(await reserveUpdate(history.db, "v1.2.17", "v1.2.18", "v1.2.17")).not.toBeNull();
  });
  it("awaits a delayed pending commit before emitting done", async () => {
    const history = historyDatabase();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    history.controls.beforeWrite = async (items) => { if (items[0]?.status === "pending") await gate; };
    const child = makeChild();
    const res = makeResponse();
    const completion = api.handleUpdateApply(request(), res.response, "request-1", true, history.db);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    child.emit("close", 0);
    await vi.waitFor(() => expect(history.active()).toBe(1));
    expect(res.sse().some(({ type }) => type === "done")).toBe(false);
    expect(history.items()[0]?.status).toBe("running");
    release!();
    await completion;
    expect(history.items()[0]?.status).toBe("pending");
    expect(res.sse().at(-1)?.type).toBe("done");
  });
  it.each([1, 2])("never fakes success with %s failed completion writes", async (failures) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const history = historyDatabase();
    const child = makeChild();
    const res = makeResponse();
    const completion = api.handleUpdateApply(request(), res.response, "request-1", true, history.db);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    history.controls.failWrites = failures;
    child.emit("close", 0);
    await completion;
    expect(history.items()[0]).toMatchObject({ status: failures === 1 ? "failed" : "running", ok: false });
    expect(res.sse().at(-1)).toMatchObject({ data: { ok: false, restartPending: false, reason: "history_write_failed" } });
  });
  it("marks stream setup failure without spawning or leaking the reservation", async () => {
    const history = historyDatabase();
    const res = makeResponse();
    res.writeHead.mockImplementation(() => { throw new Error("closed stream"); });
    await api.handleUpdateApply(request(), res.response, "request-1", true, history.db);
    expect(history.items()[0]).toMatchObject({ status: "failed", reason: "stream_setup_failed" });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(await reserveUpdate(history.db, "v1.2.17", "v1.2.19", "v1.2.17")).not.toBeNull();
  });
  it.each(["disconnect", "write throw", "response error"])("keeps updater alive on %s and persists completion", async (failure) => {
    const history = historyDatabase();
    const child = makeChild();
    const res = makeResponse();
    const completion = api.handleUpdateApply(request(), res.response, "request-1", true, history.db);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    if (failure === "disconnect") res.emit("close");
    else if (failure === "response error") res.emit("error", new Error("socket error"));
    else res.write.mockImplementation(() => { throw new Error("write destroyed"); });
    child.stdout.emit("data", Buffer.from('{"level":"stage","stage":"pull","message":"pulling"}\n'));
    child.stderr.emit("data", Buffer.from("warning\n"));
    expect(child.kill).not.toHaveBeenCalled();
    child.emit("close", 0);
    await completion;
    expect(history.items()[0]).toMatchObject({ status: "pending", ok: false });
    expect(child.kill).not.toHaveBeenCalled();
  });
  it.each(["v1.2.3\n", "latest\n", 42])("rejects invalid target %j before side effects", async (target) => {
    const history = historyDatabase();
    const audit = vi.fn();
    const res = makeResponse();
    await api.handleUpdateApply(request({ target }), res.response, "request-1", true, history.db, audit);
    expect(res.status()).toBe(400);
    expect(history.calls).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });
  it("requires admin before reading or reserving history", async () => {
    const history = historyDatabase();
    const res = makeResponse();
    await api.handleUpdateApply(request(), res.response, "request-1", false, history.db);
    expect(res.status()).toBe(403);
    expect(history.calls).toEqual([]);
  });
});
