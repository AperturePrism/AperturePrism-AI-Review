import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

type Database = PostgresJsDatabase<typeof schema>;

export type RepoMemoryKind = "reflection" | "rule" | "knowledge";

export type RepoMemoryRow = {
  id: string;
  repositoryId: string | null;
  kind: RepoMemoryKind;
  title: string;
  content: string;
  sourceType: string | null;
  sourceRef: string | null;
  consolidated: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const rowColumns = {
  id: schema.repoMemory.id,
  repositoryId: schema.repoMemory.repositoryId,
  kind: schema.repoMemory.kind,
  title: schema.repoMemory.title,
  content: schema.repoMemory.content,
  sourceType: schema.repoMemory.sourceType,
  sourceRef: schema.repoMemory.sourceRef,
  consolidated: schema.repoMemory.consolidated,
  createdAt: schema.repoMemory.createdAt,
  updatedAt: schema.repoMemory.updatedAt,
} as const;

/**
 * Appends a memory row. `repositoryId` is optional so system-wide knowledge
 * can live without a repo; reflections carry it whenever the repo is known.
 * `consolidated` defaults to false（自动沉淀的反思）；手动创建的规则/知识应传
 * true，使其立即进入 getRepoMemorySummary 的分析上下文（issue #32）。
 */
export async function writeRepoMemory(
  db: Database,
  input: {
    repositoryId?: string | undefined;
    kind: RepoMemoryKind;
    title: string;
    content: string;
    sourceType?: string | undefined;
    sourceRef?: string | undefined;
    consolidated?: boolean;
  },
): Promise<void> {
  await db.insert(schema.repoMemory).values({
    repositoryId: input.repositoryId ?? null,
    kind: input.kind,
    title: input.title,
    content: input.content,
    sourceType: input.sourceType ?? null,
    sourceRef: input.sourceRef ?? null,
    consolidated: input.consolidated ?? false,
  });
}

/** Lists memory rows newest first, optionally filtered by repo/kind. */
export async function listRepoMemory(
  db: Database,
  options: {
    repositoryId?: string | undefined;
    kind?: RepoMemoryKind | undefined;
    limit?: number;
    offset?: number;
  } = {},
): Promise<RepoMemoryRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const filters = [];
  if (options.repositoryId !== undefined)
    filters.push(eq(schema.repoMemory.repositoryId, options.repositoryId));
  if (options.kind !== undefined)
    filters.push(eq(schema.repoMemory.kind, options.kind));
  const rows = await db
    .select(rowColumns)
    .from(schema.repoMemory)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(schema.repoMemory.createdAt), desc(schema.repoMemory.id))
    .limit(limit)
    .offset(offset);
  return rows.map((row) => ({ ...row, kind: row.kind as RepoMemoryKind }));
}

/**
 * Reflections that still await consolidation, oldest first so the agent merges
 * them in the order they were produced. Optionally scoped to one repository.
 */
export async function listUnconsolidatedReflections(
  db: Database,
  options: { repositoryId?: string | undefined; limit?: number } = {},
): Promise<RepoMemoryRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const filters = [
    eq(schema.repoMemory.kind, "reflection"),
    eq(schema.repoMemory.consolidated, false),
  ];
  if (options.repositoryId !== undefined)
    filters.push(eq(schema.repoMemory.repositoryId, options.repositoryId));
  const rows = await db
    .select(rowColumns)
    .from(schema.repoMemory)
    .where(and(...filters))
    .orderBy(asc(schema.repoMemory.createdAt), asc(schema.repoMemory.id))
    .limit(limit);
  return rows.map((row) => ({ ...row, kind: row.kind as RepoMemoryKind }));
}

/** Marks the given reflection ids as consolidated (idempotent; empty no-op). */
export async function markReflectionsConsolidated(
  db: Database,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(schema.repoMemory)
    .set({ consolidated: true, updatedAt: new Date() })
    .where(inArray(schema.repoMemory.id, ids));
}

/**
 * Returns the merged `rule`/`knowledge` memory of a repository as readable
 * text, oldest-first. Used to backfill the analysis/review context so the
 * model learns from the repo's own accumulated experience. Returns "" when
 * the repository has no consolidated memory.
 */
export async function getRepoMemorySummary(
  db: Database,
  repositoryId: string,
): Promise<string> {
  const rows = await db
    .select({
      kind: schema.repoMemory.kind,
      title: schema.repoMemory.title,
      content: schema.repoMemory.content,
      createdAt: schema.repoMemory.createdAt,
    })
    .from(schema.repoMemory)
    .where(
      and(
        eq(schema.repoMemory.repositoryId, repositoryId),
        // Raw reflections remain history even after they are consolidated.
        inArray(schema.repoMemory.kind, ["rule", "knowledge"]),
        or(
          eq(schema.repoMemory.consolidated, true),
          // Older schedulers omitted consolidated=true on derived entries.
          eq(schema.repoMemory.sourceType, "consolidation"),
        ),
      ),
    )
    .orderBy(asc(schema.repoMemory.createdAt))
    .limit(50);
  if (rows.length === 0) return "";
  const blocks = rows.map((row) => {
    const tag = row.kind === "rule" ? "规则" : "知识";
    return `- [${tag}] ${row.title}\n  ${row.content}`;
  });
  return blocks.join("\n\n");
}

/** Deletes a single memory row; returns whether a row was actually removed. */
export async function deleteRepoMemory(
  db: Database,
  id: string,
): Promise<boolean> {
  const deleted = await db
    .delete(schema.repoMemory)
    .where(eq(schema.repoMemory.id, id))
    .returning({ id: schema.repoMemory.id });
  return deleted.length > 0;
}
