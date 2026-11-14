import { asc } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
import { redactBackupSetting } from "./backup-redact.js";

export const BACKUP_VERSION = "apertureprism-backup/v1";

/** Non-secret settings that an import may restore. */
const IMPORTABLE_SETTING_KEYS = new Set(["github_webhook_enabled", "log_level"]);
/** Roles the restore path may re-create (avoids importing arbitrary rows). */
const IMPORTABLE_POLICY_ROLES = new Set([
  "issue_analysis",
  "pr_review",
  "duplicate_judgment",
]);

type Database = PostgresJsDatabase<typeof schema>;

export type BackupSetting = {
  key: string;
  value: string | null;
  hasValue: boolean;
};

export type BackupPolicy = {
  role: string;
  version: string;
  candidates: unknown;
};

export type BackupSnapshot = {
  version: string;
  exportedAt: string;
  settings: BackupSetting[];
  policies: BackupPolicy[];
  providers: string[];
};

export type BackupApplyResult = {
  settings: number;
  policies: number;
  skippedSecrets: string[];
  skippedProviders: string[];
};

/**
 * Captures the runtime configuration: hot-overridable settings (secrets
 * masked), model role policies and provider account names. This is a
 * configuration backup — provider credentials stay in the database and are
 * never exported.
 */
export async function buildBackupSnapshot(db: Database): Promise<BackupSnapshot> {
  const [settings, policies, providers] = await Promise.all([
    db
      .select({ key: schema.systemSettings.key, value: schema.systemSettings.value })
      .from(schema.systemSettings)
      .orderBy(asc(schema.systemSettings.key)),
    db
      .select({
        role: schema.modelRolePolicies.role,
        version: schema.modelRolePolicies.version,
        candidates: schema.modelRolePolicies.candidates,
      })
      .from(schema.modelRolePolicies)
      .orderBy(asc(schema.modelRolePolicies.role)),
    db
      .select({ name: schema.providerAccounts.name })
      .from(schema.providerAccounts)
      .orderBy(asc(schema.providerAccounts.name)),
  ]);
  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    // 默认拒绝：只有白名单里的非密钥项导出明文，其余只报告「有没有值」。
    settings: settings.map(redactBackupSetting),
    policies,
    providers: providers.map((row) => row.name),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBackupPolicy(value: unknown): value is BackupPolicy {
  if (!isRecord(value)) return false;
  if (typeof value.role !== "string" || value.role.length === 0) return false;
  if (typeof value.version !== "string" || value.version.length === 0) return false;
  return Array.isArray(value.candidates);
}

/**
 * Restores a previously exported snapshot. Only non-secret settings and the
 * known model role policies are applied; provider accounts are informational
 * (their encrypted credentials live in the database and are never restored
 * from a backup). Returns a per-section count plus what was skipped.
 */
export async function applyBackupSnapshot(
  db: Database,
  snapshot: unknown,
): Promise<BackupApplyResult> {
  if (!isRecord(snapshot)) throw new Error("backup snapshot must be an object");
  if (snapshot.version !== BACKUP_VERSION)
    throw new Error(`unsupported backup version: ${String(snapshot.version)}`);
  if (!Array.isArray(snapshot.settings) || !Array.isArray(snapshot.policies))
    throw new Error("backup snapshot is missing settings/policies arrays");

  const settings = snapshot.settings;
  const savedPolicies = snapshot.policies;
  // Settings and the replacement policy set form one configuration change.
  // A failed policy insert must not leave updated settings or an empty table.
  return db.transaction(async (tx) => {
    const skippedSecrets: string[] = [];
    let settingsApplied = 0;
    for (const entry of settings) {
      if (!isRecord(entry) || typeof entry.key !== "string") continue;
      // 导入侧的闸口一直是 IMPORTABLE_SETTING_KEYS（只恢复非密钥项）。这里单独
      // 记录「导出时被脱敏过」的条目，好让界面如实说明哪些值需要手工重填。
      if (entry.value === null && entry.hasValue === true) {
        skippedSecrets.push(entry.key);
        continue;
      }
      if (!IMPORTABLE_SETTING_KEYS.has(entry.key)) continue;
      const value = typeof entry.value === "string" ? entry.value : "";
      await tx
        .insert(schema.systemSettings)
        .values({ key: entry.key, value })
        .onConflictDoUpdate({
          target: schema.systemSettings.key,
          set: { value, updatedAt: new Date() },
        });
      settingsApplied += 1;
    }

    const policies = savedPolicies.filter(isBackupPolicy);
    const imported = policies.filter((policy) =>
      IMPORTABLE_POLICY_ROLES.has(policy.role),
    );
    await tx.delete(schema.modelRolePolicies);
    for (const policy of imported) {
      await tx.insert(schema.modelRolePolicies).values({
        role: policy.role,
        version: policy.version,
        candidates: policy.candidates,
      });
    }

    const providers = Array.isArray(snapshot.providers)
      ? snapshot.providers.filter(
          (name): name is string => typeof name === "string",
        )
      : [];

    return {
      settings: settingsApplied,
      policies: imported.length,
      skippedSecrets,
      skippedProviders: providers,
    };
  });
}
