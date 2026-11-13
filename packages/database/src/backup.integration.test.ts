import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseClient,
  type DatabaseClient,
  modelRolePolicies,
} from "./index.js";
import {
  applyBackupSnapshot,
  BACKUP_VERSION,
  buildBackupSnapshot,
} from "./backup.js";

const databaseUrl = process.env.APERTUREPRISM_INTEGRATION_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration("backup snapshot PostgreSQL integration", () => {
  let client: DatabaseClient;
  /** Original policies + log_level so the restore test never destroys them. */
  let originalPolicies: { role: string; version: string; candidates: unknown }[] = [];
  let originalLogLevel: string | null = null;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("integration database URL is required");
    client = createDatabaseClient(databaseUrl);
    originalPolicies = await client.db
      .select({
        role: modelRolePolicies.role,
        version: modelRolePolicies.version,
        candidates: modelRolePolicies.candidates,
      })
      .from(modelRolePolicies);
    const level = await client.sql<{ value: string }[]>`
      select value from system_settings where key = 'log_level' limit 1`;
    originalLogLevel = level[0]?.value ?? null;
  });

  afterAll(async () => {
    if (!client) return;
    // Restore the pre-test policy set (the restore path replaces all policies).
    await client.sql`delete from model_role_policies`;
    for (const policy of originalPolicies) {
      await client.db.insert(modelRolePolicies).values(policy);
    }
    if (originalLogLevel === null) {
      await client.sql`delete from system_settings where key = 'log_level'`;
    } else {
      await client.sql`update system_settings set value = ${originalLogLevel} where key = 'log_level'`;
    }
    await client.close();
  });

  it("exports a snapshot and restores settings + policies without secrets", async () => {
    const snapshot = await buildBackupSnapshot(client.db);
    expect(snapshot.version).toBe(BACKUP_VERSION);
    expect(snapshot.settings.every((s) => s.key !== "webui_api_token" || s.value === null)).toBe(true);

    const result = await applyBackupSnapshot(client.db, {
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      settings: [{ key: "log_level", value: "debug", hasValue: true }],
      policies: [
        {
          role: "issue_analysis",
          version: "restored-v1",
          candidates: [{ provider: "newapi", model: "deepseek-v4-flash", accountName: "newapi-main" }],
        },
      ],
      providers: ["newapi-main"],
    });
    expect(result.settings).toBe(1);
    expect(result.policies).toBe(1);

    const level = await client.sql<{ value: string }[]>`
      select value from system_settings where key = 'log_level' limit 1`;
    expect(level[0]?.value).toBe("debug");
    const restored = await client.sql<{ version: string }[]>`
      select version from model_role_policies where version = 'restored-v1' limit 1`;
    expect(restored[0]?.version).toBe("restored-v1");
  });

  it("rolls back settings and policy replacement when a later insert fails", async () => {
    const before = await buildBackupSnapshot(client.db);
    const policy = {
      role: "issue_analysis",
      version: "duplicate-role-must-rollback",
      candidates: [],
    };

    // Duplicate roles violate the existing unique constraint after the first
    // policy insert, so this exercises a failure after settings and DELETE.
    await expect(
      applyBackupSnapshot(client.db, {
        version: BACKUP_VERSION,
        settings: [{ key: "log_level", value: "trace", hasValue: true }],
        policies: [policy, policy],
      }),
    ).rejects.toThrow();

    const after = await buildBackupSnapshot(client.db);
    expect(after.settings).toEqual(before.settings);
    expect(after.policies).toEqual(before.policies);
  });

  it("rejects an unsupported backup version", async () => {
    await expect(
      applyBackupSnapshot(client.db, {
        version: "bogus/v9",
        settings: [],
        policies: [],
      }),
    ).rejects.toThrow(/unsupported backup version/);
  });
});
