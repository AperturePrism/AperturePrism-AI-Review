import { eq } from "drizzle-orm";
import type { PgDatabase,PgQueryResultHKT } from "drizzle-orm/pg-core";
import { externalPublications } from "../../../packages/database/src/schema.js";
import type { GitHubClient } from "../../../packages/github-adapter/src/index.js";

interface BeginCheckRunInput {
  db: Pick<PgDatabase<PgQueryResultHKT>, "select" | "insert">;
  github: Pick<GitHubClient, "createCheckRun" | "updateCheckRun">;
  taskId: string;
  installationId: string;
  owner: string;
  name: string;
  pullNumber: number;
  revision: string;
}

export function checkRunIdempotencyKey(
  owner: string,
  name: string,
  pullNumber: number,
  revision: string,
): string {
  return `check-run:${owner}/${name}#${pullNumber}:${revision}`;
}

/**
 * Reuses a Check Run only if GitHub accepts the transition to in_progress.
 * Keep one canonical publication row so terminal reconciliation and live
 * status both address the current run.
 * Errors propagate to the handler's best-effort Check Run boundary.
 */
export async function beginCheckRun(input: BeginCheckRunInput): Promise<void> {
  const key = checkRunIdempotencyKey(
    input.owner,
    input.name,
    input.pullNumber,
    input.revision,
  );
  const rows = await input.db
    .select({ externalObjectId: externalPublications.externalObjectId })
    .from(externalPublications)
    .where(eq(externalPublications.idempotencyKey, key))
    .limit(1);
  let runId = rows[0]?.externalObjectId ?? null;
  // Check support is best-effort: an unresponsive GitHub/token exchange must
  // not hold the review (and its lease heartbeat) open indefinitely.
  const signal = AbortSignal.timeout(15_000);
  const progress = {
    installationId: input.installationId,
    owner: input.owner,
    name: input.name,
    status: "in_progress" as const,
    title: "AI 代码审查进行中",
    summary: "正在分析 PR 的变更与上下文，请稍候…",
  };

  if (runId !== null) {
    try {
      await input.github.updateCheckRun(
        { ...progress, checkRunId: Number(runId) },
        signal,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      // A completed/deleted run may reject restoration. Do not reuse it.
      runId = null;
    }
  }
  if (runId === null) {
    const run = await input.github.createCheckRun(
      {
        ...progress,
        headSha: input.revision,
        runName: "AperturePrism AI Review",
      },
      signal,
    );
    runId = String(run.id);
  }

  // Unlike immutable review/comment publications, a rejected restore replaces
  // the external object. Upsert both identities together, also rebinding a
  // successfully restored run when another task shares this repo/PR/SHA key.
  // Keep persistence outside the restore catch: a DB error must not create a
  // duplicate run, and creation failure must leave the prior mapping intact.
  const publication = {
    taskId: input.taskId,
    externalObjectId: runId,
    channel: "check_run",
    // Reopening/creating a run starts a new lifecycle. Terminal reconciliation
    // must acknowledge it again, even when the prior task/run was completed.
    checkRunCompletedAt: null,
  };
  await input.db
    .insert(externalPublications)
    .values({ ...publication, idempotencyKey: key })
    .onConflictDoUpdate({
      target: externalPublications.idempotencyKey,
      set: { ...publication, updatedAt: new Date() },
    });
}
