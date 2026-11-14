import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../../packages/database/src/index.js";
import type { GitHubClient } from "../../../packages/github-adapter/src/index.js";
import { resetTaskToQueued } from "../../../packages/task-engine/src/index.js";
import { reconcileCheckRuns } from "./check-runs.js";

const databaseUrl = process.env.APERTUREPRISM_INTEGRATION_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("Check Run reconciliation PostgreSQL fencing", () => {
  let client: DatabaseClient;
  const tasks: string[] = [];
  beforeAll(() => {
    if (!databaseUrl) throw new Error("integration database required");
    client = createDatabaseClient(databaseUrl);
  });
  afterAll(async () => {
    if (!client) return;
    if (tasks.length) {
      await client.sql`delete from external_publications where task_id in ${client.sql(tasks)}`;
      await client.sql`delete from task_events where task_id in ${client.sql(tasks)}`;
      await client.sql`delete from task_attempts where task_id in ${client.sql(tasks)}`;
      await client.sql`delete from analysis_tasks where id in ${client.sql(tasks)}`;
    }
    await client.close();
  });

  async function seed() {
    const id = randomUUID();
    tasks.push(id);
    const payload = {
      installationId: "42",
      repositoryFullName: "owner/repo",
      subjectNumber: 7,
      subjectRevision: id,
    };
    await client.sql`insert into analysis_tasks (id,task_type,subject_revision,policy_version,dedupe_key,status,payload)
      values (${id},'pr_review',${id},'test',${id},'canceled',${JSON.stringify(payload)}::jsonb)`;
    await client.sql`insert into external_publications (task_id,idempotency_key,external_object_id,channel)
      values (${id},${id},'101','check_run')`;
    return id;
  }
  function github() {
    const getCheckRun = vi.fn<GitHubClient["getCheckRun"]>().mockResolvedValue({
      id: 101,
      status: "in_progress",
      conclusion: null,
      title: null,
      htmlUrl: null,
    });
    const updateCheckRun = vi
      .fn<GitHubClient["updateCheckRun"]>()
      .mockResolvedValue({ id: 101, htmlUrl: "https://github.test/check/101" });
    return { getCheckRun, updateCheckRun };
  }

  it("holds the terminal task until GitHub acknowledges, then lets rerun reset the marker", async () => {
    const taskId = await seed();
    const remote = github();
    let finish!: () => void;
    const response = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    remote.updateCheckRun.mockImplementationOnce(async () => {
      started();
      await response;
      return { id: 101, htmlUrl: "https://github.test/check/101" };
    });
    const errors: unknown[] = [];
    const sweep = reconcileCheckRuns({
      db: client.db,
      github: remote,
      signal: new AbortController().signal,
      onError: (error) => errors.push(error),
    });
    await requestStarted;
    let rerunFinished = false;
    const rerun = resetTaskToQueued(client.db, { taskId }).then((value) => {
      rerunFinished = true;
      return value;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(rerunFinished).toBe(false);
    } finally {
      finish();
    }
    await sweep;
    await expect(rerun).resolves.toBe(true);
    const [row] =
      await client.sql`select t.status,p.check_run_completed_at from analysis_tasks t join external_publications p on p.task_id=t.id where t.id=${taskId}`;
    expect(row?.status).toBe("queued");
    expect(row?.check_run_completed_at).toBeNull();
    expect(errors).toEqual([]);
  });

  it("skips a candidate locked by another scheduler instead of sending a second completion", async () => {
    await seed();
    const remote = github();
    let finish!: () => void;
    const response = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    remote.updateCheckRun.mockImplementationOnce(async () => {
      started();
      await response;
      return { id: 101, htmlUrl: "https://github.test/check/101" };
    });
    const args = {
      db: client.db,
      github: remote,
      signal: new AbortController().signal,
      onError: (error: unknown) => {
        throw error;
      },
    };
    const first = reconcileCheckRuns(args);
    await requestStarted;
    try {
      await reconcileCheckRuns(args);
      expect(remote.updateCheckRun).toHaveBeenCalledOnce();
    } finally {
      finish();
    }
    await first;
  });
});
