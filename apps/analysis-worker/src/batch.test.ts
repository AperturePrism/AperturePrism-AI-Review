import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkbench } from "../../../packages/review-workbench/src/index.js";
import type {
  Actor,
  Batch,
  Workbench,
} from "../../../packages/review-workbench/src/types.js";
import type { TaskType } from "../../../packages/domain/src/index.js";
import type {
  GitHubIssue,
  GitHubPullRequest,
} from "../../../packages/github-adapter/src/client.js";
import {
  createWorkbenchBatchDispatcher,
  parseBatchSubject,
  workbenchBatchTaskKey,
  type BatchAnalysisTask,
  type BatchTaskStore,
  type WorkbenchBatchDispatcher,
} from "./batch.js";

const repository = {
  id: "repository-id",
  fullName: "owner/repo",
  installationId: "42",
  githubId: "123",
};
const sha = "a".repeat(40);
const admin: Actor = {
  userId: "admin",
  isAdmin: true,
  canAccessRepository: () => true,
};

describe("batch subject boundaries", () => {
  it.each([
    ["pr#12", "current", "pr_review", 12],
    ["PR:12", "latest", "pr_review", 12],
    ["issue#7", "head", "issue_analysis", 7],
    ["issue:7", "https://github.com/owner/repo/issues/7", "issue_analysis", 7],
    ["https://github.com/owner/repo/pull/9", "current", "pr_review", 9],
    [
      "审查这个问题",
      "https://github.com/OWNER/REPO/issues/3",
      "issue_analysis",
      3,
    ],
  ])("parses %s with reference %s", (subject, reference, taskType, number) => {
    expect(parseBatchSubject("owner/repo", subject, reference)).toEqual({
      taskType,
      number,
      expectedRevision: null,
    });
  });
  it("accepts explicit immutable SHA and issue timestamp references", () => {
    expect(parseBatchSubject("owner/repo", "pr#1", sha).expectedRevision).toBe(
      sha,
    );
    expect(
      parseBatchSubject("owner/repo", "issue#1", "2026-11-13T12:00:00Z")
        .expectedRevision,
    ).toBe("2026-11-13T12:00:00Z");
  });
  it.each([
    ["pr#0", "current"],
    ["pr#9007199254740993", "current"],
    ["#12", "current"],
    ["pr#1", "https://github.com/other/repo/pull/1"],
    ["pr#1", "https://github.com/owner/repo/issues/1"],
    ["pr#1", "https://github.com/owner/repo/pull/2"],
    ["http://github.com/owner/repo/pull/1", "current"],
    ["https://github.com.evil.test/owner/repo/pull/1", "current"],
    ["https://user:secret@github.com/owner/repo/pull/1", "current"],
    ["https://127.0.0.1/owner/repo/pull/1", "current"],
    ["https://github.com/owner/repo/actions", "current"],
    ["pr#1", "branch/main"],
  ])("rejects subject %s reference %s", (subject, reference) => {
    expect(() => parseBatchSubject("owner/repo", subject, reference)).toThrow();
  });
  it("keeps one task identity across coordination retries but changes explicit run generations", () => {
    const batch = { id: "batch" };
    expect(workbenchBatchTaskKey(batch, { id: "item" })).toBe(
      workbenchBatchTaskKey(batch, { id: "item", generation: 0 }),
    );
    expect(
      workbenchBatchTaskKey(batch, { id: "item", generation: 1 }),
    ).not.toBe(workbenchBatchTaskKey(batch, { id: "item" }));
  });
});

describe("batch dispatcher with durable workbench records", () => {
  let directory: string;
  let now: Date;
  let workbench: Workbench;
  let tasks: Map<
    string,
    BatchAnalysisTask & { taskType: TaskType; dedupeKey: string }
  >;
  let taskStore: BatchTaskStore;
  let creates: number;
  let retries: number;
  let dispatchers: WorkbenchBatchDispatcher[];
  const getPullRequest =
    vi.fn<
      (input: unknown, signal?: AbortSignal) => Promise<GitHubPullRequest>
    >();
  const getIssue =
    vi.fn<(input: unknown, signal?: AbortSignal) => Promise<GitHubIssue>>();
  const call = <T>(
    action: string,
    input: Record<string, unknown> = {},
    name = "owner/repo",
  ) =>
    workbench.execute(admin, {
      action,
      input: { repository: name, ...input },
    }) as Promise<T>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "aperture-batch-dispatch-"));
    now = new Date("2026-11-13T12:00:00Z");
    workbench = createWorkbench({ dataDirectory: directory, now: () => now });
    tasks = new Map();
    creates = 0;
    retries = 0;
    dispatchers = [];
    getPullRequest.mockReset().mockResolvedValue({
      number: 7,
      title: "review",
      body: "",
      state: "open",
      headSha: sha,
      headRef: "main",
      changedFiles: 1,
      additions: 1,
      deletions: 0,
    });
    getIssue.mockReset().mockResolvedValue({
      number: 7,
      title: "issue",
      body: "body",
      state: "open",
      htmlUrl: "https://github.com/owner/repo/issues/7",
      author: "author",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      labels: [],
    });
    taskStore = {
      repositories: async () => [repository],
      find: async (key) => structuredClone(tasks.get(key) ?? null),
      async create(input) {
        const existing = tasks.get(input.dedupeKey);
        if (existing)
          return {
            id: existing.id,
            status: existing.status,
            taskType: existing.taskType,
            dedupeKey: input.dedupeKey,
          };
        creates += 1;
        const task = {
          id: `task-${creates}`,
          repositoryId: input.repositoryId ?? null,
          taskType: input.taskType,
          dedupeKey: input.dedupeKey,
          status: "queued" as const,
          subjectRevision: input.subjectRevision,
          payload: structuredClone(input.payload),
          lastErrorCategory: null,
        };
        tasks.set(input.dedupeKey, task);
        return {
          id: task.id,
          taskType: task.taskType,
          status: task.status,
          dedupeKey: task.dedupeKey,
        };
      },
      async retry(id) {
        const task = [...tasks.values()].find((item) => item.id === id);
        if (!task || !["failed", "canceled"].includes(task.status))
          return false;
        retries += 1;
        task.status = "queued";
        return true;
      },
      async cancel(id) {
        const task = [...tasks.values()].find((item) => item.id === id);
        if (!task || ["completed", "failed", "canceled"].includes(task.status))
          return false;
        task.status = "canceled";
        return true;
      },
    };
  });
  afterEach(async () => {
    await Promise.all(dispatchers.map((dispatcher) => dispatcher.stop()));
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  });
  const dispatcher = (
    extra: Partial<Parameters<typeof createWorkbenchBatchDispatcher>[0]> = {},
  ) => {
    const result = createWorkbenchBatchDispatcher({
      workbench,
      taskStore,
      githubProvider: { get: async () => ({ getIssue, getPullRequest }) },
      workerId: "dispatcher-1",
      ...extra,
    });
    dispatchers.push(result);
    return result;
  };
  const create = async (
    items = [
      {
        id: "first",
        subject: "pr#7",
        reference: "current",
        dependencies: [] as string[],
      },
    ],
    concurrency = 1,
  ) => {
    const batch = await call<Batch>("batches.create", {
      name: "release",
      items,
      concurrency,
    });
    await call("batches.start", { id: batch.id });
    return batch;
  };
  const read = (batch: Batch) => call<Batch>("batches.get", { id: batch.id });

  it("creates a real analysis request using installed identity and a fetched immutable PR SHA", async () => {
    const batch = await create();
    const result = await dispatcher().tick();
    expect(result).toMatchObject({ claimed: 1, dispatched: 1, errors: 0 });
    expect(creates).toBe(1);
    const task = [...tasks.values()][0]!;
    expect(task).toMatchObject({
      repositoryId: repository.id,
      subjectRevision: sha,
      taskType: "pr_review",
      payload: {
        installationId: "42",
        repositoryExternalId: "123",
        repositoryFullName: "owner/repo",
        subjectNumber: 7,
        workbenchBatchId: batch.id,
        workbenchItemId: "first",
        sourceEvent: "workbench_batch",
      },
    });
    expect((await read(batch)).items[0]?.result).toMatchObject({
      taskId: task.id,
      dispatchAttempt: 1,
      revision: sha,
    });
    expect(getPullRequest).toHaveBeenCalledWith(
      { installationId: "42", owner: "owner", name: "repo", number: 7 },
      expect.any(AbortSignal),
    );
  });

  it("waits for the real task to finish before releasing dependent work", async () => {
    const batch = await create(
      [
        {
          id: "first",
          subject: "pr#7",
          reference: "current",
          dependencies: [],
        },
        {
          id: "second",
          subject: "issue#8",
          reference: "current",
          dependencies: ["first"],
        },
      ],
      2,
    );
    const worker = dispatcher();
    await worker.tick();
    expect(creates).toBe(1);
    await worker.tick();
    expect(creates).toBe(1);
    [...tasks.values()][0]!.status = "completed";
    const next = await worker.tick();
    expect(next.completed).toBe(1);
    expect(next.dispatched).toBe(1);
    expect(creates).toBe(2);
    expect([...tasks.values()][1]?.taskType).toBe("issue_analysis");
    [...tasks.values()][1]!.status = "completed";
    await worker.tick();
    expect((await read(batch)).status).toBe("completed");
    expect(
      (await read(batch)).items.every((item) => item.status === "completed"),
    ).toBe(true);
  });

  it("respects the batch concurrency window even when several items are ready", async () => {
    await create(
      [
        { id: "a", subject: "pr#1", reference: "current", dependencies: [] },
        { id: "b", subject: "pr#2", reference: "current", dependencies: [] },
        { id: "c", subject: "pr#3", reference: "current", dependencies: [] },
      ],
      2,
    );
    await dispatcher().tick();
    expect(creates).toBe(2);
  });

  it("merges overlapping tick calls instead of duplicating coordination", async () => {
    await create();
    const worker = dispatcher();
    const [left, right] = await Promise.all([worker.tick(), worker.tick()]);
    expect(left).toEqual(right);
    expect(creates).toBe(1);
  });

  it("recovers after a crash between real task creation and durable linking without duplicate dispatch", async () => {
    const batch = await create();
    let broken = true;
    const wrapped: Workbench = {
      execute: async (actor, command) => {
        if (command.action === "batches.link" && broken) {
          broken = false;
          throw new Error("disk unavailable");
        }
        return workbench.execute(actor, command);
      },
    };
    const first = dispatcher({ workbench: wrapped });
    expect((await first.tick()).errors).toBe(1);
    expect(creates).toBe(1);
    await first.stop();
    now = new Date(now.getTime() + 61_000);
    const replacement = dispatcher({ workerId: "dispatcher-2" });
    await replacement.tick();
    expect(creates).toBe(1);
    expect(getPullRequest).toHaveBeenCalledOnce();
    const current = await read(batch);
    expect(current.items[0]).toMatchObject({
      attempts: 2,
      worker: "dispatcher-2",
      result: { taskId: "task-1", dispatchAttempt: 2 },
    });
  });

  it("retries a failed real task once per new batch coordination attempt", async () => {
    const batch = await create();
    const worker = dispatcher();
    await worker.tick();
    const task = [...tasks.values()][0]!;
    task.status = "failed";
    task.lastErrorCategory = "timeout";
    await worker.tick();
    expect(creates).toBe(1);
    expect(retries).toBe(1);
    expect(task.status).toBe("queued");
    expect((await read(batch)).items[0]).toMatchObject({
      status: "running",
      attempts: 2,
    });
  });

  it("creates a new generation only after an explicit user retry of exhausted work", async () => {
    const batch = await call<Batch>("batches.create", {
      name: "one attempt",
      concurrency: 1,
      items: [
        { id: "first", subject: "pr#7", reference: "current", maxAttempts: 1 },
      ],
    });
    await call("batches.start", { id: batch.id });
    const worker = dispatcher();
    await worker.tick();
    [...tasks.values()][0]!.status = "failed";
    await worker.tick();
    expect((await read(batch)).items[0]?.status).toBe("failed");
    await call("batches.retry", { id: batch.id });
    await worker.tick();
    expect(creates).toBe(2);
    expect([...tasks.keys()]).toHaveLength(2);
  });

  it("stops new dispatch on pause but continues synchronizing already running tasks", async () => {
    const batch = await create([
      { id: "a", subject: "pr#1", reference: "current", dependencies: [] },
      { id: "b", subject: "pr#2", reference: "current", dependencies: [] },
    ]);
    const worker = dispatcher();
    await worker.tick();
    await call("batches.pause", { id: batch.id });
    [...tasks.values()][0]!.status = "completed";
    await worker.tick();
    expect(creates).toBe(1);
    expect((await read(batch)).items[0]?.status).toBe("completed");
    await call("batches.resume", { id: batch.id });
    await worker.tick();
    expect(creates).toBe(2);
  });

  it("cancels real task leases when the workbench batch is canceled", async () => {
    const batch = await create();
    const worker = dispatcher();
    await worker.tick();
    await call("batches.cancel", { id: batch.id });
    expect((await worker.tick()).canceled).toBe(1);
    expect([...tasks.values()][0]?.status).toBe("canceled");
    await worker.tick();
    expect(creates).toBe(1);
  });

  it("does not dispatch workbench repositories outside the installed repository set", async () => {
    const hidden = await call<Batch>(
      "batches.create",
      { name: "hidden", items: [{ subject: "pr#1", reference: "current" }] },
      "other/repo",
    );
    await call("batches.start", { id: hidden.id }, "other/repo");
    await dispatcher().tick();
    expect(creates).toBe(0);
    expect(getPullRequest).not.toHaveBeenCalled();
  });

  it("rejects a cross-repository URL before making any network request", async () => {
    await create([
      {
        id: "a",
        subject: "pr#1",
        reference: "https://github.com/other/private/pull/1",
        dependencies: [],
      },
    ]);
    const result = await dispatcher().tick();
    expect(result.errors).toBeGreaterThan(0);
    expect(creates).toBe(0);
    expect(getPullRequest).not.toHaveBeenCalled();
  });

  it("does not run a changed revision under a pinned reference", async () => {
    await create([
      { id: "a", subject: "pr#1", reference: "b".repeat(40), dependencies: [] },
    ]);
    await dispatcher().tick();
    expect(creates).toBe(0);
  });

  it("never trusts a caller-supplied task ID to locate another task", async () => {
    const batch = await create();
    const worker = dispatcher();
    await worker.tick();
    await expect(
      call("batches.link", {
        id: batch.id,
        itemId: "first",
        worker: "dispatcher-1",
        result: { taskId: "foreign-task", dispatchAttempt: 1 },
      }),
    ).rejects.toThrow("批次项已关联另一个执行结果");
    await worker.tick();
    expect((await read(batch)).items[0]?.result?.taskId).toBe("task-1");
    expect(creates).toBe(1);
  });

  it("renews workbench leases independently of the five-second dispatch tick", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const batch = await create();
    const worker = dispatcher({ leaseMs: 3_000, requestTimeoutMs: 500 });
    await worker.tick();
    const previous = (await read(batch)).items[0]!.leaseUntil!;
    now = new Date(now.getTime() + 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(async () =>
      expect((await read(batch)).items[0]!.leaseUntil).not.toBe(previous),
    );
  });

  it("stops without creating new work after a shutdown signal", async () => {
    await create();
    const controller = new AbortController();
    const worker = dispatcher({ signal: controller.signal });
    controller.abort();
    expect((await worker.tick()).dispatched).toBe(0);
    expect(creates).toBe(0);
  });
});
