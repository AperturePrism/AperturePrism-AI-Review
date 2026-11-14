import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "./client.js";
import { getRepoMemorySummary, writeRepoMemory } from "./repo-memory.js";

const databaseUrl = process.env.APERTUREPRISM_INTEGRATION_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration("repository memory summary PostgreSQL integration", () => {
  let client: DatabaseClient;
  let repositoryId: string;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("integration database URL is required");
    client = createDatabaseClient(databaseUrl);
    const rows = await client.sql<{ id: string }[]>`
      insert into repositories (github_id, owner, name)
      values (${`memory-test-${randomUUID()}`}, 'memory-test', 'summary') returning id`;
    repositoryId = rows[0]!.id;
  });

  afterAll(async () => {
    if (!client) return;
    if (repositoryId) {
      await client.sql`delete from repo_memory where repository_id = ${repositoryId}`;
      await client.sql`delete from repositories where id = ${repositoryId}`;
    }
    await client.close();
  });

  it("includes legacy derived outputs while excluding raw reflections and unfinished manual rules", async () => {
    await writeRepoMemory(client.db, {
      repositoryId,
      kind: "reflection",
      title: "Raw history",
      content: "RAW",
      consolidated: true,
    });
    await writeRepoMemory(client.db, {
      repositoryId,
      kind: "rule",
      title: "Legacy derived",
      content: "LEGACY",
      sourceType: "consolidation", // Deliberately keeps the old false default.
    });
    await writeRepoMemory(client.db, {
      repositoryId,
      kind: "knowledge",
      title: "Ready knowledge",
      content: "READY",
      consolidated: true,
    });
    await writeRepoMemory(client.db, {
      repositoryId,
      kind: "rule",
      title: "Unfinished manual rule",
      content: "DRAFT",
    });
    const summary = await getRepoMemorySummary(client.db, repositoryId);
    expect(summary).toContain("LEGACY");
    expect(summary).toContain("READY");
    expect(summary).not.toContain("RAW");
    expect(summary).not.toContain("DRAFT");
  });
});
