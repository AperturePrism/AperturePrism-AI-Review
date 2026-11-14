import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import { getRepoMemorySummary } from "./repo-memory.js";
import * as schema from "./schema.js";

function summaryDatabase(rows: unknown[][] = []) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const proxy = drizzle(
    async (sql, params) => {
      queries.push({ sql: sql.replace(/\s+/g, " "), params });
      return { rows };
    },
    { schema },
  );
  return {
    db: proxy as unknown as Parameters<typeof getRepoMemorySummary>[0],
    queries,
  };
}

describe("repository memory summary", () => {
  it("selects ready rules/knowledge, including legacy consolidation outputs", async () => {
    const { db, queries } = summaryDatabase();
    expect(await getRepoMemorySummary(db, "repo-1")).toBe("");
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain('"repo_memory"."kind" in (');
    expect(queries[0]!.params).toEqual([
      "repo-1",
      "rule",
      "knowledge",
      true,
      "consolidation",
      50,
    ]);
    expect(queries[0]!.sql).toContain('"repo_memory"."repository_id" = $1');
    expect(queries[0]!.sql).toContain(
      '("repo_memory"."consolidated" = $4 or "repo_memory"."source_type" = $5)',
    );
  });

  it("keeps the existing rule and knowledge rendering", async () => {
    const { db } = summaryDatabase([
      ["rule", "Keep tests", "Test changed behavior", "2026-11-13T12:00:00Z"],
      ["knowledge", "API", "Uses pagination", "2026-11-13T12:01:00Z"],
    ]);
    expect(await getRepoMemorySummary(db, "repo-1")).toBe(
      "- [规则] Keep tests\n  Test changed behavior\n\n- [知识] API\n  Uses pagination",
    );
  });
});
