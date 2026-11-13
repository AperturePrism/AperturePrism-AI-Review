import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { getTableName, type SQL, type Table } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({
  db: {} as unknown,
  canAccess: vi.fn(),
  readOnly: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("../runtime.js", () => ({
  database: {
    get db() {
      return seam.db;
    },
  },
  logger: { warn: vi.fn() },
  config: {},
}));
vi.mock("../identity.js", () => ({
  canAccessRepo: seam.canAccess,
  isReadOnlyRequest: seam.readOnly,
  audit: seam.audit,
  visibleRepoScope: vi.fn(),
  isAdminRequest: vi.fn(),
}));
vi.mock("../github.js", () => ({ githubClientPromise: Promise.resolve(null) }));
vi.mock("./settings.js", () => ({ settingDefaultValue: () => "" }));

import { routes } from "./auto-merge.js";
import { routes as repositoryRoutes } from "./repositories.js";
import { dispatch, orderRoutes } from "../utils/routes.js";
import { HttpError, json } from "../utils/http.js";

const REPO = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-0000-0000-000000000002";
const NOW = new Date("2026-11-13T00:00:00Z");
const dialect = new PgDialect();
type Row = Record<string, unknown>;
type Write = { table: string; values: Row[]; target?: unknown; set?: Row };
let state: {
  events: string[];
  selections: {
    table: string;
    fields: string[];
    query: { sql: string; params: unknown[] };
    limit: number;
  }[];
  writes: Write[];
  settings: Row[];
  queue: Row[];
  repositories: Row[];
  failCancel: boolean;
};

/** 保留真实 SQL 条件，模拟提交/回滚；HTTP 路由使用实际业务 handler。 */
function makeDb(inTransaction = false) {
  return {
    select(fields: Record<string, unknown>) {
      let tableName = "";
      let predicate: SQL;
      let locked = false;
      const query = {
        from(table: Table) {
          tableName = getTableName(table);
          return query;
        },
        where(where: SQL) {
          predicate = where;
          return query;
        },
        for(mode: string) {
          expect(inTransaction).toBe(true);
          expect(mode).toBe("update");
          expect(tableName).toBe("repositories");
          locked = true;
          return query;
        },
        orderBy() {
          return query;
        },
        async limit(limit: number) {
          const sql = dialect.sqlToQuery(predicate);
          state.selections.push({
            table: tableName,
            fields: Object.keys(fields),
            query: sql,
            limit,
          });
          state.events.push(
            locked ? "repository:locked" : `select:${tableName}`,
          );
          const source =
            tableName === "repositories" ? state.repositories : state.queue;
          const repoId = sql.params[0];
          const rows = source.filter(
            (row) =>
              (tableName === "repositories" ? row.id : row.repositoryId) ===
              repoId,
          );
          return rows
            .slice(0, limit)
            .map((row) =>
              Object.fromEntries(
                Object.keys(fields).map((key) => [key, row[key]]),
              ),
            );
        },
      };
      return query;
    },
    insert(table: Table) {
      expect(inTransaction).toBe(true);
      expect(state.events.at(-1)).toBe("repository:locked");
      const write: Write = { table: getTableName(table), values: [] };
      return {
        values(values: Row[]) {
          write.values = values;
          return {
            async onConflictDoUpdate(conflict: { target: unknown; set: Row }) {
              state.events.push("settings:upsert");
              state.writes.push({ ...write, ...conflict });
              state.settings = values;
            },
          };
        },
      };
    },
    update(table: Table) {
      expect(inTransaction).toBe(true);
      expect(getTableName(table)).toBe("pull_request_auto_merges");
      return {
        set(values: Row) {
          return {
            async where(predicate: SQL) {
              state.events.push("queue:cancel");
              if (state.failCancel) throw new Error("database unavailable");
              const query = dialect.sqlToQuery(predicate);
              expect(query.sql).toContain('"repository_id" =');
              expect(query.sql).toContain('"status" in');
              expect(query.params).toEqual([
                REPO,
                "pending",
                "waiting",
                "blocked",
              ]);
              state.queue = state.queue.map((row) =>
                row.repositoryId === query.params[0] &&
                query.params.slice(1).includes(row.status)
                  ? { ...row, ...values }
                  : row,
              );
            },
          };
        },
      };
    },
    async transaction(callback: (tx: unknown) => Promise<unknown>) {
      const snapshot = structuredClone({
        settings: state.settings,
        queue: state.queue,
      });
      state.events.push("begin");
      try {
        const result = await callback(makeDb(true));
        state.events.push("commit");
        return result;
      } catch (error) {
        state.settings = snapshot.settings;
        state.queue = snapshot.queue;
        state.events.push("rollback");
        throw error;
      }
    },
  };
}

function queueRow(id: string, repositoryId: string, status = "waiting"): Row {
  return {
    id,
    repositoryId,
    taskId: `task-${id}`,
    installationId: "private-installation",
    repoSecrets: "not-for-http",
    repositoryFullName: "private/repo",
    pullNumber: 7,
    headSha: "a".repeat(40),
    method: "squash",
    status,
    reason: "awaiting_checks",
    message: null,
    mergeCommitSha: null,
    attempts: 1,
    nextAttemptAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  seam.canAccess.mockResolvedValue(true);
  seam.readOnly.mockResolvedValue(false);
  state = {
    events: [],
    selections: [],
    writes: [],
    settings: [],
    failCancel: false,
    repositories: [{ id: REPO, owner: "owner", name: "repo" }],
    queue: [queueRow("ours", REPO), queueRow("theirs", OTHER)],
  };
  seam.db = makeDb();
});

async function http(path: string, method = "GET", body?: unknown, raw = false) {
  const server = createServer((request, response) => {
    void dispatch(
      orderRoutes([...routes, ...repositoryRoutes]),
      request,
      response,
      "auto-merge-test",
      { isAdmin: async () => false },
    )
      .then((handled) => {
        if (!handled)
          json(response, 404, { reason: "not_found" }, "auto-merge-test");
      })
      .catch((error: unknown) =>
        json(
          response,
          error instanceof HttpError ? error.status : 500,
          {
            status: "error",
            reason:
              error instanceof HttpError ? error.message : "internal_error",
          },
          "auto-merge-test",
        ),
      );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,
      {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: raw ? String(body) : JSON.stringify(body),
            }),
      },
    );
    return {
      status: response.status,
      allow: response.headers.get("allow"),
      body: (await response.json()) as Row,
    };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const path = `/repositories/${REPO}/auto-merge`;
const settingsPath = `${path}/settings`;
const valid = { enabled: true, method: "squash", requiredChecks: ["ci"] };

describe("auto-merge HTTP history and permissions", () => {
  it("returns a bounded, repository-scoped whitelist without installation details", async () => {
    const result = await http(path);
    expect(result.status).toBe(200);
    expect(result.body.canManage).toBe(true);
    const items = result.body.items as Row[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "ours",
      pullNumber: 7,
      status: "waiting",
    });
    expect(JSON.stringify(result.body)).not.toMatch(
      /private-installation|not-for-http|theirs|installationId|repoSecrets|repositoryFullName/,
    );
    const selection = state.selections.find(
      (query) => query.table === "pull_request_auto_merges",
    )!;
    expect(selection.query.params).toEqual([REPO]);
    expect(selection.query.sql).toContain('"repository_id" =');
    expect(selection.limit).toBe(20);
  });
  it("honors an explicit limit", async () => {
    expect((await http(`${path}?limit=1`)).status).toBe(200);
    expect(state.selections.at(-1)?.limit).toBe(1);
  });
  it.each(["0", "101", "1.5", "NaN", ""])(
    'rejects invalid limit "%s"',
    async (limit) => {
      expect((await http(`${path}?limit=${limit}`)).status).toBe(400);
      expect(state.selections).toEqual([]);
    },
  );
  it("does not read any repository data without view access", async () => {
    seam.canAccess.mockResolvedValue(false);
    expect((await http(path)).status).toBe(403);
    expect(state.selections).toEqual([]);
  });
  it("allows viewing while withholding write controls from a view-only user", async () => {
    seam.canAccess.mockImplementation(
      async (_request, _id, need) => need === "view",
    );
    expect((await http(path)).body.canManage).toBe(false);
  });
  it("withholds write controls from a read-only manager", async () => {
    seam.readOnly.mockResolvedValue(true);
    expect((await http(path)).body.canManage).toBe(false);
  });
  it("reports a missing repository without reading queue rows", async () => {
    state.repositories = [];
    expect((await http(path)).status).toBe(404);
    expect(state.selections.map((query) => query.table)).toEqual([
      "repositories",
    ]);
  });
  it.each(["not-a-uuid", "%ZZ", "%2F"])(
    'rejects malformed repository identity "%s"',
    async (id) => {
      expect((await http(`/repositories/${id}/auto-merge`)).status).toBe(400);
      expect(state.selections).toEqual([]);
    },
  );
});

describe("auto-merge atomic settings HTTP", () => {
  it("locks the repository before saving all three normalized settings and auditing", async () => {
    const result = await http(settingsPath, "PUT", {
      ...valid,
      requiredChecks: [" ci ", "ci", "build,linux"],
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      status: "ok",
      settings: { ...valid, requiredChecks: ["ci", "build,linux"] },
    });
    expect(state.events).toEqual([
      "begin",
      "repository:locked",
      "settings:upsert",
      "commit",
    ]);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]?.table).toBe("repository_settings");
    expect(
      state.settings.map(({ repositoryId, key, value }) => ({
        repositoryId,
        key,
        value,
      })),
    ).toEqual([
      { repositoryId: REPO, key: "pr_auto_merge_enabled", value: "true" },
      { repositoryId: REPO, key: "pr_auto_merge_method", value: "squash" },
      {
        repositoryId: REPO,
        key: "pr_auto_merge_required_checks",
        value: '["ci","build,linux"]',
      },
    ]);
    expect(seam.audit).toHaveBeenCalledWith(
      expect.anything(),
      "repository_auto_merge.update",
      "owner/repo",
      result.body.settings,
    );
  });
  it("atomically disables and cancels only this repository's outstanding intentions", async () => {
    state.queue = ["pending", "waiting", "blocked", "merged", "canceled"]
      .map((status) => queueRow(status, REPO, status))
      .concat(queueRow("theirs", OTHER));
    const result = await http(settingsPath, "PUT", {
      ...valid,
      enabled: false,
    });
    expect(result.status).toBe(200);
    expect(state.events).toEqual([
      "begin",
      "repository:locked",
      "settings:upsert",
      "queue:cancel",
      "commit",
    ]);
    for (const row of state.queue.slice(0, 3)) {
      expect(row).toMatchObject({
        status: "canceled",
        reason: "configuration_disabled",
        completedAt: expect.any(Date),
      });
    }
    expect(
      state.queue.slice(3).map((row) => [row.id, row.status, row.completedAt]),
    ).toEqual([
      ["merged", "merged", null],
      ["canceled", "canceled", null],
      ["theirs", "waiting", null],
    ]);
  });
  it("rolls back settings and queue together if cancellation fails", async () => {
    state.failCancel = true;
    const before = structuredClone(state.queue);
    const result = await http(settingsPath, "PUT", {
      ...valid,
      enabled: false,
    });
    expect(result.status).toBe(500);
    expect(result.body.reason).toBe("internal_error");
    expect(state.settings).toEqual([]);
    expect(state.queue).toEqual(before);
    expect(state.events.at(-1)).toBe("rollback");
    expect(seam.audit).not.toHaveBeenCalled();
  });
  it.each(["view", "none", "readOnly"])(
    "rejects %s users before reading or writing the database",
    async (permission) => {
      seam.canAccess.mockResolvedValue(permission === "readOnly");
      seam.readOnly.mockResolvedValue(permission === "readOnly");
      expect((await http(settingsPath, "PUT", valid)).status).toBe(403);
      expect(state.events).toEqual([]);
      expect(seam.audit).not.toHaveBeenCalled();
    },
  );
  it("reports a repository removed before locking without writing settings", async () => {
    state.repositories = [];
    expect((await http(settingsPath, "PUT", valid)).status).toBe(404);
    expect(state.writes).toEqual([]);
    expect(state.events.at(-1)).toBe("rollback");
  });
  it.each([
    null,
    [],
    {},
    { ...valid, extra: true },
    { ...valid, enabled: "true" },
    { ...valid, method: "automatic" },
    { ...valid, method: null },
    { ...valid, method: { toString: "merge" } },
    { ...valid, requiredChecks: "ci" },
    { ...valid, requiredChecks: [42] },
    { ...valid, requiredChecks: [" "] },
    { ...valid, requiredChecks: ["x".repeat(201)] },
    { ...valid, requiredChecks: ["ci\n"] },
    { ...valid, requiredChecks: ["bad\u0000name"] },
    { ...valid, requiredChecks: ["bad\u0085name"] },
    { ...valid, requiredChecks: Array.from({ length: 101 }, () => "ci") },
  ])(
    "rejects malformed input before starting a transaction: %j",
    async (body) => {
      expect((await http(settingsPath, "PUT", body)).status).toBe(400);
      expect(state.events).toEqual([]);
      expect(seam.audit).not.toHaveBeenCalled();
    },
  );
  it("accepts an empty check list and each supported merge method", async () => {
    for (const method of ["merge", "squash", "rebase"]) {
      expect(
        (
          await http(settingsPath, "PUT", {
            ...valid,
            method,
            requiredChecks: [],
          })
        ).status,
      ).toBe(200);
    }
  });
  it("rejects invalid JSON and oversized bodies", async () => {
    expect((await http(settingsPath, "PUT", "{broken", true)).status).toBe(400);
    expect(
      (await http(settingsPath, "PUT", " ".repeat(128 * 1024 + 1), true))
        .status,
    ).toBe(413);
    expect(state.events).toEqual([]);
  });
  it("returns 405 for GET settings and PUT history through route dispatch", async () => {
    const settings = await http(settingsPath);
    expect(settings.status).toBe(405);
    expect(settings.allow).toBe("PUT");
    expect((await http(path, "PUT", valid)).status).toBe(405);
    expect(state.events).toEqual([]);
  });
  it.each([
    "pr_auto_merge_enabled",
    "pr_auto_merge_method",
    "pr_auto_merge_required_checks",
  ])("blocks %s through the legacy per-key write endpoint", async (key) => {
    const result = await http(`/repositories/${REPO}/settings`, "PUT", {
      key,
      value: "true",
    });
    expect(result.status).toBe(400);
    expect(result.body.reason).toBe(
      "auto_merge_settings_require_atomic_endpoint",
    );
    expect(state.writes).toEqual([]);
    expect(seam.audit).not.toHaveBeenCalled();
  });
});
