import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../../../packages/database/src/schema.js";

const HISTORY_SETTING_KEY = "update_history";
const HISTORY_LIMIT = 50;
const PENDING_TIMEOUT_MS = 3 * 60_000;
const RUNNING_TIMEOUT_MS = 30 * 60_000;
const VERSION_PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?![\s\S])/;

type UpdateDatabase = PostgresJsDatabase<typeof schema>;

export interface UpdateHistoryEntry {
  at: string;
  from: string;
  to: string;
  ok: boolean;
  reason?: string;
  id?: string;
  status?: "running" | "pending" | "success" | "failed";
  updatedAt?: string;
}

export function normalizeUpdateVersion(version: string): string | null {
  return VERSION_PATTERN.test(version) ? version.replace(/^v/, "") : null;
}

/** Only the newest attempt is current; never reinterpret bool-only history. */
export function reconcileUpdateHistory(
  items: UpdateHistoryEntry[],
  bakedVersion: string,
  now: Date,
): { items: UpdateHistoryEntry[]; inProgress: boolean } {
  const entry = items[0];
  if (entry?.status !== "running" && entry?.status !== "pending") {
    return { items, inProgress: false };
  }

  const target = normalizeUpdateVersion(entry.to);
  let status: "success" | "failed" | undefined;
  let reason: string | undefined;
  // A matching runtime is evidence even if the first read is much later. A
  // running script is NOT evidence: it must durably finish its script stage.
  if (
    entry.status === "pending" &&
    target !== null &&
    target === normalizeUpdateVersion(bakedVersion)
  ) {
    status = "success";
  } else {
    const startedAt = Date.parse(entry.updatedAt ?? entry.at);
    const timeout = entry.status === "pending" ? PENDING_TIMEOUT_MS : RUNNING_TIMEOUT_MS;
    if (!Number.isFinite(startedAt) || now.getTime() - startedAt >= timeout) {
      status = "failed";
      reason = entry.status === "pending" ? "confirmation_timeout" : "script_timeout";
    }
  }

  if (!status) return { items, inProgress: true };
  const { reason: _previousReason, ...previous } = entry;
  return {
    items: [
      {
        ...previous,
        status,
        ok: status === "success",
        updatedAt: now.toISOString(),
        ...(reason ? { reason } : {}),
      },
      ...items.slice(1),
    ],
    inProgress: false,
  };
}

function parseHistory(value: string | undefined): UpdateHistoryEntry[] {
  if (value === undefined) return [];
  const items: unknown = JSON.parse(value);
  if (
    !Array.isArray(items) ||
    !items.every((item: unknown) => {
      if (!item || typeof item !== "object") return false;
      const entry = item as Record<string, unknown>;
      return (
        typeof entry.at === "string" &&
        typeof entry.from === "string" &&
        typeof entry.to === "string" &&
        typeof entry.ok === "boolean" &&
        (entry.id === undefined || typeof entry.id === "string") &&
        (entry.reason === undefined || typeof entry.reason === "string") &&
        (entry.updatedAt === undefined || typeof entry.updatedAt === "string") &&
        (entry.status === undefined ||
          entry.status === "running" ||
          entry.status === "pending" ||
          entry.status === "success" ||
          entry.status === "failed")
      );
    })
  ) {
    throw new Error("Invalid update history");
  }
  return items as UpdateHistoryEntry[];
}

/**
 * Serialize only bounded DB work, including the initially absent settings row.
 * Transaction-scoped advisory locks release on commit/rollback/process exit;
 * registry requests and the update script never run inside this transaction.
 */
async function changeHistory<T>(
  db: UpdateDatabase,
  change: (items: UpdateHistoryEntry[]) => { items: UpdateHistoryEntry[]; result: T },
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${HISTORY_SETTING_KEY}))`);
    const rows = await tx
      .select({ value: schema.systemSettings.value })
      .from(schema.systemSettings)
      .where(eq(schema.systemSettings.key, HISTORY_SETTING_KEY))
      .limit(1);
    const existing = parseHistory(rows[0]?.value);
    const next = change(existing);
    if (next.items !== existing) {
      const value = JSON.stringify(next.items);
      await tx
        .insert(schema.systemSettings)
        .values({ key: HISTORY_SETTING_KEY, value })
        .onConflictDoUpdate({
          target: schema.systemSettings.key,
          set: { value, updatedAt: new Date() },
        });
    }
    return next.result;
  });
}

export async function readUpdateHistory(
  db: UpdateDatabase,
  bakedVersion: string,
): Promise<{ items: UpdateHistoryEntry[]; inProgress: boolean }> {
  return changeHistory(db, (items) => {
    const state = reconcileUpdateHistory(items, bakedVersion, new Date());
    return { items: state.items, result: state };
  });
}

export async function reserveUpdate(
  db: UpdateDatabase,
  previous: string,
  target: string,
  bakedVersion: string,
): Promise<(UpdateHistoryEntry & { id: string }) | null> {
  return changeHistory(db, (items) => {
    const now = new Date();
    const state = reconcileUpdateHistory(items, bakedVersion, now);
    if (state.inProgress) return { items: state.items, result: null };
    const entry: UpdateHistoryEntry & { id: string } = {
      id: randomUUID(),
      at: now.toISOString(),
      updatedAt: now.toISOString(),
      from: previous,
      to: target,
      status: "running",
      ok: false,
    };
    return {
      items: [entry, ...state.items].slice(0, HISTORY_LIMIT),
      result: entry,
    };
  });
}

export async function finishUpdate(
  db: UpdateDatabase,
  id: string,
  scriptOk: boolean,
  reason?: string,
): Promise<UpdateHistoryEntry> {
  return changeHistory(db, (items) => {
    const current = items[0];
    if (!current || current.id !== id) throw new Error("Update attempt is no longer current");
    // A late script result must not resurrect a timed-out attempt.
    if (current.status !== "running") return { items, result: current };
    const entry: UpdateHistoryEntry = {
      ...current,
      status: scriptOk ? "pending" : "failed",
      ok: false,
      updatedAt: new Date().toISOString(),
      ...(reason ? { reason } : {}),
    };
    return { items: [entry, ...items.slice(1)], result: entry };
  });
}
