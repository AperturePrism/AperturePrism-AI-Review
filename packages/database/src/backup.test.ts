import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it, vi } from "vitest";
import { applyBackupSnapshot, BACKUP_VERSION } from "./backup.js";
import * as schema from "./schema.js";

function restoreDatabase(failOnPolicy = false) {
  const outside: string[] = [];
  const inside: string[] = [];
  const lifecycle: string[] = [];
  const execute = async (sql: string, queries: string[]) => {
    queries.push(sql);
    if (failOnPolicy && sql.startsWith('insert into "model_role_policies"'))
      throw new Error("policy write failed");
    return { rows: [] };
  };
  const proxy = drizzle(async (sql) => execute(sql, outside), { schema });
  const tx = drizzle(async (sql) => execute(sql, inside), { schema });
  const transaction = vi
    .spyOn(proxy, "transaction")
    .mockImplementation(async (callback) => {
      lifecycle.push("begin");
      try {
        const result = await callback(
          tx as unknown as Parameters<typeof callback>[0],
        );
        lifecycle.push("commit");
        return result;
      } catch (error) {
        lifecycle.push("rollback");
        throw error;
      }
    });
  return {
    db: proxy as unknown as Parameters<typeof applyBackupSnapshot>[0],
    outside,
    inside,
    lifecycle,
    transaction,
  };
}

function snapshot() {
  return {
    version: BACKUP_VERSION,
    settings: [
      { key: "log_level", value: "debug", hasValue: true },
      { key: "oauth_client_secret", value: null, hasValue: true },
    ],
    policies: [{ role: "issue_analysis", version: "restored", candidates: [] }],
    providers: ["not-imported"],
  };
}

describe("backup restore transaction", () => {
  it("applies every setting and policy write through the transaction handle", async () => {
    const { db, outside, inside, lifecycle, transaction } = restoreDatabase();
    expect(await applyBackupSnapshot(db, snapshot())).toEqual({
      settings: 1,
      policies: 1,
      skippedSecrets: ["oauth_client_secret"],
      skippedProviders: ["not-imported"],
    });
    expect(transaction).toHaveBeenCalledOnce();
    expect(outside).toEqual([]);
    expect(inside).toHaveLength(3);
    expect(inside[0]).toMatch(/^insert into "system_settings"/);
    expect(inside[1]).toMatch(/^delete from "model_role_policies"/);
    expect(inside[2]).toMatch(/^insert into "model_role_policies"/);
    expect(lifecycle).toEqual(["begin", "commit"]);
  });

  it("propagates a later policy failure to the transaction boundary", async () => {
    const { db, outside, inside, lifecycle } = restoreDatabase(true);
    await expect(applyBackupSnapshot(db, snapshot())).rejects.toThrow();
    expect(outside).toEqual([]);
    expect(inside).toHaveLength(3);
    expect(lifecycle).toEqual(["begin", "rollback"]);
  });

  it("rejects invalid snapshots before opening a transaction", async () => {
    const { db, outside, transaction } = restoreDatabase();
    await expect(
      applyBackupSnapshot(db, { version: "invalid" }),
    ).rejects.toThrow(/unsupported/);
    expect(transaction).not.toHaveBeenCalled();
    expect(outside).toEqual([]);
  });
});
