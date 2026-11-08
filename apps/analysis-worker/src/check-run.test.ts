import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it, vi } from "vitest";
import { externalPublications } from "../../../packages/database/src/schema.js";
import {
  GitHubApiError,
  type GitHubClient,
} from "../../../packages/github-adapter/src/index.js";
import { beginCheckRun, checkRunIdempotencyKey } from "./check-run.js";

type Publication = Pick<
  typeof externalPublications.$inferSelect,
  "taskId" | "idempotencyKey" | "externalObjectId" | "channel"
>;

const input = {
  taskId: "task-2",
  installationId: "42",
  owner: "owner",
  name: "repo",
  pullNumber: 9,
  revision: "rev-1",
};
const key = "check-run:owner/repo#9:rev-1";
const progress = {
  installationId: "42",
  owner: "owner",
  name: "repo",
  status: "in_progress",
  title: "AI 代码审查进行中",
  summary: "正在分析 PR 的变更与上下文，请稍候…",
};

function publication(externalObjectId: string | null = "101"): Publication {
  return {
    taskId: "task-1",
    idempotencyKey: key,
    externalObjectId,
    channel: "check_run",
  };
}

function githubClient() {
  return {
    createCheckRun: vi.fn<GitHubClient["createCheckRun"]>().mockResolvedValue({
      id: 202,
      htmlUrl: "https://github.test/checks/202",
    }),
    updateCheckRun: vi.fn<GitHubClient["updateCheckRun"]>().mockResolvedValue({
      id: 101,
      htmlUrl: "https://github.test/checks/101",
    }),
  };
}

/**
 * Use the real Drizzle query builder so a do-nothing conflict handler or an
 * upsert that forgets task_id cannot pass the orchestration tests. Only the
 * driver is in-memory; no PostgreSQL service is required for these regressions.
 */
function publicationDatabase(seed: Publication[] = []) {
  const publications = new Map(seed.map((row) => [row.idempotencyKey, row]));
  const read = vi.fn(async () => {});
  const write = vi.fn(async () => {});
  const query = vi.fn(
    async (sql: string, params: unknown[], method: "all" | "execute") => {
      if (method === "all") {
        await read();
        expect(sql).toContain(
          'select "external_object_id" from "external_publications"',
        );
        const row = sql.includes(
          '"external_publications"."idempotency_key" = $1',
        )
          ? publications.get(String(params[0]))
          : [...publications.values()].find(
              (entry) =>
                entry.taskId === params[0] && entry.channel === params[1],
            );
        return { rows: row ? [[row.externalObjectId]] : [] };
      }

      // Both identities must be written in the same statement, to the original
      // unique key, rather than deleting it or inserting a task-specific key.
      expect(sql).toContain('insert into "external_publications"');
      expect(sql).toContain(
        'on conflict ("idempotency_key") do update set "task_id" = $5, "external_object_id" = $6, "channel" = $7, "updated_at" = $8',
      );
      const [taskId, idempotencyKey, externalObjectId, channel] = params;
      expect(params.slice(4, 7)).toEqual([taskId, externalObjectId, channel]);
      if (
        typeof taskId !== "string" ||
        typeof idempotencyKey !== "string" ||
        typeof externalObjectId !== "string" ||
        channel !== "check_run"
      ) {
        throw new Error("unexpected check-run publication values");
      }
      await write();
      publications.set(idempotencyKey, {
        taskId,
        idempotencyKey,
        externalObjectId,
        channel,
      });
      return { rows: [] };
    },
  );
  const db = drizzle(query);
  const findByKey = async (idempotencyKey: string) => {
    const rows = await db
      .select({ externalObjectId: externalPublications.externalObjectId })
      .from(externalPublications)
      .where(eq(externalPublications.idempotencyKey, idempotencyKey))
      .limit(1);
    return rows[0]?.externalObjectId ?? null;
  };
  const findByTask = async (taskId: string) => {
    const rows = await db
      .select({ externalObjectId: externalPublications.externalObjectId })
      .from(externalPublications)
      .where(
        and(
          eq(externalPublications.taskId, taskId),
          eq(externalPublications.channel, "check_run"),
        ),
      )
      .limit(1);
    return rows[0]?.externalObjectId ?? null;
  };
  return { db, publications, read, write, query, findByKey, findByTask };
}

describe("checkRunIdempotencyKey", () => {
  it("keeps the canonical repo/PR/revision key independent of task or attempt", () => {
    expect(checkRunIdempotencyKey("owner", "repo", 9, "rev-1")).toBe(key);
    const keys = [
      key,
      checkRunIdempotencyKey("other", "repo", 9, "rev-1"),
      checkRunIdempotencyKey("owner", "other", 9, "rev-1"),
      checkRunIdempotencyKey("owner", "repo", 10, "rev-1"),
      checkRunIdempotencyKey("owner", "repo", 9, "rev-2"),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("beginCheckRun", () => {
  it.each([
    { label: "missing publication", seed: [] },
    { label: "publication without a run ID", seed: [publication(null)] },
  ])("creates an in-progress run for a $label", async ({ seed }) => {
    const store = publicationDatabase(seed);
    const github = githubClient();

    await beginCheckRun({ ...input, db: store.db, github });

    expect(github.updateCheckRun).not.toHaveBeenCalled();
    expect(github.createCheckRun).toHaveBeenCalledExactlyOnceWith({
      ...progress,
      headSha: input.revision,
      runName: "AperturePrism AI Review",
    });
    expect(store.publications.size).toBe(1);
    expect(await store.findByKey(key)).toBe("202");
    expect(await store.findByTask(input.taskId)).toBe("202");
  });

  it("restores the existing run without creating another, rebinding its task", async () => {
    const store = publicationDatabase([publication()]);
    const github = githubClient();

    await beginCheckRun({ ...input, db: store.db, github });

    expect(github.updateCheckRun).toHaveBeenCalledExactlyOnceWith({
      ...progress,
      checkRunId: 101,
    });
    expect(github.createCheckRun).not.toHaveBeenCalled();
    expect(store.write).toHaveBeenCalledOnce();
    expect(store.publications.size).toBe(1);
    expect(await store.findByKey(key)).toBe("101");
    expect(await store.findByTask(input.taskId)).toBe("101");
    expect(await store.findByTask("task-1")).toBeNull();
  });

  it.each([
    new GitHubApiError("invalid_request", "completed run cannot restart", 422),
    new GitHubApiError("not_found", "run was deleted", 404),
    new Error("restore request failed"),
  ])("replaces the canonical run when restoration fails: %s", async (error) => {
    const store = publicationDatabase([publication()]);
    const github = githubClient();
    github.updateCheckRun.mockRejectedValueOnce(error);

    await beginCheckRun({ ...input, db: store.db, github });

    expect(github.updateCheckRun).toHaveBeenCalledExactlyOnceWith({
      ...progress,
      checkRunId: 101,
    });
    expect(github.createCheckRun).toHaveBeenCalledExactlyOnceWith({
      ...progress,
      headSha: input.revision,
      runName: "AperturePrism AI Review",
    });
    expect(store.write).toHaveBeenCalledOnce();
    expect(store.publications.size).toBe(1);
    // Completion/final failure use the key; API cancel/live status use task ID.
    expect(await store.findByKey(key)).toBe("202");
    expect(await store.findByTask(input.taskId)).toBe("202");
    expect(await store.findByTask("task-1")).toBeNull();
  });

  it.each([
    { label: "initial creation", seed: [] },
    { label: "replacement", seed: [publication()] },
  ])("does not change publications if $label fails", async ({ seed }) => {
    const store = publicationDatabase(seed);
    const github = githubClient();
    const error = new GitHubApiError("authentication_failed", "denied", 403);
    github.updateCheckRun.mockRejectedValueOnce(new Error("cannot restart"));
    github.createCheckRun.mockRejectedValueOnce(error);

    await expect(
      beginCheckRun({ ...input, db: store.db, github }),
    ).rejects.toBe(error);

    expect(github.createCheckRun).toHaveBeenCalledOnce();
    expect(store.write).not.toHaveBeenCalled();
    expect([...store.publications.values()]).toEqual(seed);
    expect(await store.findByTask(input.taskId)).toBeNull();
  });

  it("does not contact GitHub when the publication lookup fails", async () => {
    const store = publicationDatabase([publication()]);
    const github = githubClient();
    const error = new Error("database read failed");
    store.read.mockRejectedValueOnce(error);

    await expect(
      beginCheckRun({ ...input, db: store.db, github }),
    ).rejects.toMatchObject({ cause: error });

    expect(github.updateCheckRun).not.toHaveBeenCalled();
    expect(github.createCheckRun).not.toHaveBeenCalled();
    expect(store.write).not.toHaveBeenCalled();
    expect(store.publications.get(key)).toEqual(publication());
  });

  it("does not mistake a persistence failure after restore for a rejected restore", async () => {
    const store = publicationDatabase([publication()]);
    const github = githubClient();
    const error = new Error("database write failed");
    store.write.mockRejectedValueOnce(error);

    await expect(
      beginCheckRun({ ...input, db: store.db, github }),
    ).rejects.toMatchObject({ cause: error });

    expect(github.updateCheckRun).toHaveBeenCalledOnce();
    expect(github.createCheckRun).not.toHaveBeenCalled();
    expect(store.write).toHaveBeenCalledOnce();
    expect(store.publications.get(key)).toEqual(publication());
  });

  it.each([
    { label: "initial creation", seed: [] },
    { label: "replacement", seed: [publication()] },
  ])(
    "does not retry creation if persistence after $label fails",
    async ({ seed }) => {
      const store = publicationDatabase(seed);
      const github = githubClient();
      const error = new Error("database write failed");
      github.updateCheckRun.mockRejectedValueOnce(new Error("cannot restart"));
      store.write.mockRejectedValueOnce(error);

      await expect(
        beginCheckRun({ ...input, db: store.db, github }),
      ).rejects.toMatchObject({ cause: error });

      expect(github.createCheckRun).toHaveBeenCalledOnce();
      expect(store.write).toHaveBeenCalledOnce();
      expect([...store.publications.values()]).toEqual(seed);
      expect(await store.findByTask(input.taskId)).toBeNull();
    },
  );

  it("reuses the replacement on subsequent attempts and leaves other publications alone", async () => {
    const otherPublications: Publication[] = [
      {
        ...publication("301"),
        idempotencyKey: "check-run:owner/repo#9:rev-2",
      },
      {
        ...publication("401"),
        idempotencyKey: "pr-comment:owner/repo#9:rev-1",
        channel: "github_issue_comment",
      },
      {
        ...publication("501"),
        idempotencyKey: "pr-review:owner/repo#9:rev-1",
        channel: "github_pull_request_review",
      },
    ];
    const store = publicationDatabase([publication(), ...otherPublications]);
    const github = githubClient();
    github.updateCheckRun.mockRejectedValueOnce(new Error("cannot restart"));

    await beginCheckRun({ ...input, db: store.db, github });
    await beginCheckRun({ ...input, db: store.db, github });
    await beginCheckRun({ ...input, taskId: "task-3", db: store.db, github });

    expect(
      github.updateCheckRun.mock.calls.map(([call]) => call.checkRunId),
    ).toEqual([101, 202, 202]);
    expect(github.createCheckRun).toHaveBeenCalledOnce();
    expect(store.write).toHaveBeenCalledTimes(3);
    expect(store.publications.size).toBe(4);
    expect(await store.findByKey(key)).toBe("202");
    expect(await store.findByTask("task-3")).toBe("202");
    expect(await store.findByTask(input.taskId)).toBeNull();
    for (const row of otherPublications) {
      expect(store.publications.get(row.idempotencyKey)).toEqual(row);
    }
  });
});
