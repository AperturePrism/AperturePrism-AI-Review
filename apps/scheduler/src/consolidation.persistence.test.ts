import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../../../packages/database/src/index.js";
import * as modelRouter from "../../../packages/model-router/src/index.js";
import { createLogger } from "../../../packages/observability/src/index.js";
import { memoryConsolidationSweep } from "./consolidation.js";

// Keep the actual sweep and database write helpers, replacing only the model
// transport and PostgreSQL driver so no external service is contacted.
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("consolidated memory persistence", () => {
  it("marks derived rules and knowledge as ready before retiring reflections", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://localhost/unused");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv(
      "MODEL_PROVIDER_BASE_URLS",
      '{"local":"https://models.example/v1"}',
    );
    const candidate = {
      provider: "local",
      model: "review",
      accountName: "test",
    };
    vi.spyOn(modelRouter, "routeModelInvocation").mockResolvedValue({
      response: {
        content: JSON.stringify([
          { kind: "rule", title: "Explicit errors", content: "Handle errors" },
          { kind: "knowledge", title: "Database", content: "Uses PostgreSQL" },
        ]),
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      candidate,
      attempts: [],
    });
    const writes: { sql: string; params: unknown[] }[] = [];
    const db = drizzle(async (sql, params) => {
      if (sql.includes('from "model_role_policies"'))
        return { rows: [[[candidate]]] };
      if (sql.startsWith("select distinct")) return { rows: [["repo-1"]] };
      if (sql.startsWith("select") && sql.includes('"source_ref"')) {
        return {
          rows: [
            [
              "reflection-1",
              "repo-1",
              "reflection",
              "Earlier result",
              "Raw conclusion",
              null,
              null,
              false,
              "2026-11-13T12:00:00Z",
              "2026-11-13T12:00:00Z",
            ],
          ],
        };
      }
      if (sql.startsWith("select")) return { rows: [] };
      writes.push({ sql, params });
      return { rows: [] };
    });
    const client = { db } as unknown as DatabaseClient;
    expect(
      await memoryConsolidationSweep(client, createLogger("silent")),
    ).toEqual({
      repositories: 1,
      rules: 2,
    });
    const inserts = writes.filter((entry) =>
      entry.sql.startsWith('insert into "repo_memory"'),
    );
    expect(inserts).toHaveLength(2);
    expect(inserts[0]!.params).toEqual([
      "repo-1",
      "rule",
      "Explicit errors",
      "Handle errors",
      "consolidation",
      null,
      true,
    ]);
    expect(inserts[1]!.params).toEqual([
      "repo-1",
      "knowledge",
      "Database",
      "Uses PostgreSQL",
      "consolidation",
      null,
      true,
    ]);
    expect(writes.at(-1)!.sql).toMatch(/^update "repo_memory"/);
    expect(writes.at(-1)!.params).toContain("reflection-1");
  });
});
