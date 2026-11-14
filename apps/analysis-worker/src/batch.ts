/**
 * 工作台批次：把已领取审查项交给真实任务队列，并把最终结果回写批次。
 *
 * @example
 * const dispatcher = createWorkbenchBatchDispatcher({ workbench, taskDb: db,
 *   githubProvider, workerId: "analysis-host-1" });
 * await dispatcher.tick(); // 主入口每五秒调用；同一实例自动合并重叠 tick。
 * await dispatcher.stop(); // 退出时停止心跳，再关闭数据库。
 *
 * 批次租约只负责“谁在协调这一项”，真正的模型执行仍由 analysis_tasks 的租约
 * 负责。稳定去重键不包含租约尝试次数，进程重启不会重复派发仍在执行的审查。
 */
import { asc, eq, isNotNull } from "drizzle-orm";
import type { DatabaseClient } from "../../../packages/database/src/client.js";
import {
  analysisTasks,
  repositories,
} from "../../../packages/database/src/schema.js";
import type {
  AnalysisTask,
  CreateTaskInput,
  TaskStatus,
} from "../../../packages/domain/src/index.js";
import type { GitHubClient } from "../../../packages/github-adapter/src/client.js";
import { ISSUE_ANALYSIS_POLICY_VERSION } from "../../../packages/issue-analysis/src/index.js";
import { PR_REVIEW_POLICY_VERSION } from "../../../packages/pr-review/src/index.js";
import {
  cancelTask,
  createAnalysisTask,
  resetTaskToQueued,
} from "../../../packages/task-engine/src/index.js";
import type {
  Actor,
  Batch,
  BatchItem,
  Workbench,
} from "../../../packages/review-workbench/src/types.js";

export type BatchGitHubProvider = {
  get: () => Promise<Pick<GitHubClient, "getIssue" | "getPullRequest"> | null>;
};
export type BatchRepository = {
  id: string;
  fullName: string;
  installationId: string;
  githubId: string;
};
export type BatchAnalysisTask = {
  id: string;
  repositoryId: string | null;
  status: TaskStatus;
  subjectRevision: string;
  payload: unknown;
  lastErrorCategory: string | null;
};
export type BatchTaskStore = {
  repositories: () => Promise<BatchRepository[]>;
  find: (dedupeKey: string) => Promise<BatchAnalysisTask | null>;
  create: (input: CreateTaskInput) => Promise<AnalysisTask>;
  retry: (taskId: string) => Promise<boolean>;
  cancel: (taskId: string, reason: string) => Promise<boolean>;
};
export type BatchDispatchSummary = {
  repositories: number;
  batches: number;
  claimed: number;
  dispatched: number;
  resumed: number;
  completed: number;
  failed: number;
  canceled: number;
  errors: number;
};
export type WorkbenchBatchDispatcher = {
  tick: () => Promise<BatchDispatchSummary>;
  stop: () => Promise<void>;
};
type Lease = { repository: string; batchId: string; itemId: string };

export class BatchDispatchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BatchDispatchError";
  }
}

/** 真正的 PostgreSQL 绑定；测试可替换相同接口验证重启和取消的时序。 */
export function createBatchTaskStore(db: DatabaseClient["db"]): BatchTaskStore {
  return {
    async repositories() {
      const rows = await db
        .select({
          id: repositories.id,
          owner: repositories.owner,
          name: repositories.name,
          installationId: repositories.installationId,
          githubId: repositories.githubId,
        })
        .from(repositories)
        .where(isNotNull(repositories.installationId))
        .orderBy(asc(repositories.id));
      return rows
        .filter((row) => row.installationId)
        .map((row) => ({
          id: row.id,
          fullName: `${row.owner}/${row.name}`,
          installationId: row.installationId!,
          githubId: row.githubId,
        }));
    },
    async find(dedupeKey) {
      const [row] = await db
        .select({
          id: analysisTasks.id,
          repositoryId: analysisTasks.repositoryId,
          status: analysisTasks.status,
          subjectRevision: analysisTasks.subjectRevision,
          payload: analysisTasks.payload,
          lastErrorCategory: analysisTasks.lastErrorCategory,
        })
        .from(analysisTasks)
        .where(eq(analysisTasks.dedupeKey, dedupeKey))
        .limit(1);
      return row ?? null;
    },
    async create(input) {
      return (await createAnalysisTask(db, input)).task;
    },
    retry: (taskId) => resetTaskToQueued(db, { taskId }),
    cancel: (taskId, reason) => cancelTask(db, { taskId, reason }),
  };
}

export type BatchSubject = {
  taskType: "issue_analysis" | "pr_review";
  number: number;
  expectedRevision: string | null;
};

/**
 * 接受 issue#12、issue:12、pr#12、pr:12 或同仓库 GitHub URL。reference 可提供
 * URL、PR SHA、Issue 更新时间，或 current/latest；它从不被用作网络目标。
 */
export function parseBatchSubject(
  repository: string,
  subject: string,
  reference: string,
): BatchSubject {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new BatchDispatchError("invalid_repository", "批次仓库名无效");
  const parse = (
    value: string,
  ): Omit<BatchSubject, "expectedRevision"> | null => {
    const short = /^(issue|pr)\s*[#:]\s*(\d+)$/i.exec(value.trim());
    if (short) {
      const number = Number(short[2]);
      if (!Number.isSafeInteger(number) || number < 1)
        throw new BatchDispatchError(
          "invalid_subject",
          "Issue 或 PR 编号必须是正整数",
        );
      return {
        taskType:
          short[1]!.toLowerCase() === "pr" ? "pr_review" : "issue_analysis",
        number,
      };
    }
    if (!/^https?:/i.test(value.trim())) return null;
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      throw new BatchDispatchError("invalid_subject", "GitHub 链接格式不正确");
    }
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.username ||
      url.password ||
      url.port
    )
      throw new BatchDispatchError(
        "invalid_subject",
        "批次只接受 github.com 的 HTTPS Issue 或 PR 链接",
      );
    const match = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)\/?$/.exec(
      url.pathname,
    );
    if (!match)
      throw new BatchDispatchError(
        "invalid_subject",
        "GitHub 链接必须指向一个 Issue 或 PR",
      );
    if (`${match[1]}/${match[2]}`.toLowerCase() !== repository.toLowerCase())
      throw new BatchDispatchError(
        "repository_mismatch",
        "链接中的仓库必须与批次仓库相同",
      );
    const number = Number(match[4]);
    if (!Number.isSafeInteger(number) || number < 1)
      throw new BatchDispatchError(
        "invalid_subject",
        "Issue 或 PR 编号必须是正整数",
      );
    return {
      taskType: match[3] === "pull" ? "pr_review" : "issue_analysis",
      number,
    };
  };
  const primary = parse(subject);
  const linked = parse(reference);
  if (
    primary &&
    linked &&
    (primary.taskType !== linked.taskType || primary.number !== linked.number)
  )
    throw new BatchDispatchError(
      "subject_mismatch",
      "subject 与 reference 指向不同的审查对象",
    );
  const parsed = primary ?? linked;
  if (!parsed)
    throw new BatchDispatchError(
      "invalid_subject",
      "请填写 issue#编号、pr#编号或同仓库 GitHub 链接",
    );
  const hint = reference.trim();
  const expectedRevision =
    linked || !hint || /^(current|latest|head)$/i.test(hint) ? null : hint;
  const validRevision =
    expectedRevision === null ||
    (parsed.taskType === "pr_review"
      ? /^[0-9a-f]{7,64}$/i.test(expectedRevision)
      : /^\d{4}-\d{2}-\d{2}T/.test(expectedRevision) &&
        Number.isFinite(Date.parse(expectedRevision)));
  if (!validRevision)
    throw new BatchDispatchError(
      "invalid_revision",
      "reference 应为 GitHub 链接、PR 提交 SHA、Issue 更新时间或 current",
    );
  return { ...parsed, expectedRevision };
}

/**
 * 跨批次去重：同一仓库、审查对象、版本与策略只对应一个真实任务；
 * 批次关联记录在任务 payload 的 metadata 中，不参与去重键。
 */
export function workbenchTaskDedupeKey(input: {
  repositoryId: string;
  taskType: "issue_analysis" | "pr_review";
  number: number;
  revision: string;
  policyVersion: string;
}): string {
  const prefix =
    input.taskType === "pr_review" ? "pr-review" : "issue-analysis";
  return `${prefix}:${input.repositoryId}:${input.number}:${input.revision}:${input.policyVersion}`;
}

function taskPayload(task: BatchAnalysisTask): Record<string, unknown> {
  return typeof task.payload === "object" && task.payload !== null
    ? (task.payload as Record<string, unknown>)
    : {};
}

/**
 * 构造批次派发器。system actor 每次只允许一个已经安装的仓库，不能借 worker
 * 身份查询其它工作台仓库；用户请求永远不能覆盖这个授权函数。
 */
export function createWorkbenchBatchDispatcher(options: {
  workbench: Workbench;
  taskDb?: DatabaseClient["db"];
  taskStore?: BatchTaskStore;
  githubProvider: BatchGitHubProvider;
  workerId: string;
  signal?: AbortSignal;
  leaseMs?: number;
  requestTimeoutMs?: number;
  maxDispatchPerTick?: number;
  onError?: (
    error: unknown,
    context: { repository?: string; batchId?: string; itemId?: string },
  ) => void;
}): WorkbenchBatchDispatcher {
  const workerId = options.workerId.trim();
  if (!workerId || workerId.length > 200)
    throw new TypeError("workerId must contain 1 to 200 characters");
  if (!options.taskStore && !options.taskDb)
    throw new TypeError("taskDb or taskStore is required");
  const tasks = options.taskStore ?? createBatchTaskStore(options.taskDb!);
  const leaseMs = options.leaseMs ?? 60_000;
  const timeoutMs = options.requestTimeoutMs ?? 15_000;
  const maxDispatch = options.maxDispatchPerTick ?? 25;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 3_000 || leaseMs > 3_600_000)
    throw new RangeError("leaseMs must be between 3000 and 3600000");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs >= leaseMs)
    throw new RangeError(
      "requestTimeoutMs must be positive and shorter than leaseMs",
    );
  if (
    !Number.isSafeInteger(maxDispatch) ||
    maxDispatch < 1 ||
    maxDispatch > 1_000
  )
    throw new RangeError("maxDispatchPerTick must be between 1 and 1000");
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const leases = new Map<string, Lease>();
  let flight: Promise<BatchDispatchSummary> | undefined;
  let renewal: Promise<void> | undefined;
  const actor = (repository: string): Actor => ({
    userId: `batch:${workerId}`.slice(0, 200),
    isAdmin: false,
    canAccessRepository: (requested) =>
      requested.toLowerCase() === repository.toLowerCase(),
  });
  const execute = <T>(
    repository: string,
    action: string,
    input: Record<string, unknown>,
  ): Promise<T> =>
    options.workbench.execute(actor(repository), {
      action,
      input: { ...input, repository },
    }) as Promise<T>;
  const leaseKey = (lease: Lease) =>
    JSON.stringify([lease.repository, lease.batchId, lease.itemId]);
  const forget = (lease: Lease) => {
    leases.delete(leaseKey(lease));
  };
  const remember = (lease: Lease) => {
    leases.set(leaseKey(lease), lease);
  };
  const heartbeat = (lease: Lease) =>
    execute<BatchItem>(lease.repository, "batches.heartbeat", {
      id: lease.batchId,
      itemId: lease.itemId,
      worker: workerId,
      leaseMs,
    });
  const reportError = (
    error: unknown,
    context: { repository?: string; batchId?: string; itemId?: string },
  ) => {
    try {
      options.onError?.(error, context);
    } catch {
      /* 日志回调不能终止批次协调。 */
    }
  };
  const timer = setInterval(
    () => {
      if (renewal || signal.aborted || !leases.size) return;
      renewal = (async () => {
        for (const lease of leases.values()) {
          if (signal.aborted) break;
          try {
            await heartbeat(lease);
          } catch (error) {
            forget(lease);
            reportError(error, {
              repository: lease.repository,
              batchId: lease.batchId,
              itemId: lease.itemId,
            });
          }
        }
      })().finally(() => {
        renewal = undefined;
      });
    },
    Math.max(1_000, Math.floor(leaseMs / 3)),
  );
  timer.unref();

  const finish = async (
    repository: string,
    batch: Batch,
    item: BatchItem,
    task: BatchAnalysisTask | null,
    error?: string,
  ) => {
    const lease = { repository, batchId: batch.id, itemId: item.id };
    const outcome =
      !error && task?.status === "completed" ? "completed" : "failed";
    await execute(repository, "batches.complete", {
      id: batch.id,
      itemId: item.id,
      worker: workerId,
      outcome,
      ...(outcome === "failed"
        ? {
            error:
              error ??
              task?.lastErrorCategory ??
              `任务状态为 ${task?.status ?? "unknown"}`,
          }
        : {}),
      result: {
        taskId: task?.id ?? null,
        taskStatus: task?.status ?? "not_created",
        revision: task?.subjectRevision ?? null,
        dispatchAttempt: item.attempts,
      },
    });
    forget(lease);
    return outcome;
  };

  const resolveRevision = async (
    repository: BatchRepository,
    item: BatchItem,
  ): Promise<{
    parsed: BatchSubject;
    revision: string;
    policyVersion: string;
  }> => {
    const parsed = parseBatchSubject(
      repository.fullName,
      item.subject,
      item.reference,
    );
    const github = await options.githubProvider.get();
    if (!github)
      throw new BatchDispatchError(
        "github_not_configured",
        "GitHub App 尚未配置，不能派发批次审查",
      );
    const [owner, name] = repository.fullName.split("/") as [string, string];
    const identity = {
      installationId: repository.installationId,
      owner,
      name,
      number: parsed.number,
    };
    const requestSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(timeoutMs),
    ]);
    requestSignal.throwIfAborted();
    const revision =
      parsed.taskType === "pr_review"
        ? (await github.getPullRequest(identity, requestSignal)).headSha
        : (await github.getIssue(identity, requestSignal)).updatedAt;
    if (
      !revision ||
      (parsed.taskType === "pr_review"
        ? !/^[0-9a-f]{7,64}$/i.test(revision)
        : !Number.isFinite(Date.parse(revision)))
    )
      throw new BatchDispatchError(
        "invalid_github_revision",
        "GitHub 没有返回有效的不可变版本标识",
      );
    if (parsed.expectedRevision) {
      const matches =
        parsed.taskType === "pr_review"
          ? revision
              .toLowerCase()
              .startsWith(parsed.expectedRevision.toLowerCase())
          : Date.parse(revision) === Date.parse(parsed.expectedRevision);
      if (!matches)
        throw new BatchDispatchError(
          "revision_changed",
          "审查对象已不在批次指定版本，请确认后新建或重试批次",
        );
    }
    return {
      parsed,
      revision,
      policyVersion:
        parsed.taskType === "pr_review"
          ? PR_REVIEW_POLICY_VERSION
          : ISSUE_ANALYSIS_POLICY_VERSION,
    };
  };

  const createTask = async (
    repository: BatchRepository,
    batch: Batch,
    item: BatchItem,
    parsed: BatchSubject,
    revision: string,
    policyVersion: string,
    dedupeKey: string,
  ): Promise<BatchAnalysisTask> => {
    // 外部读取可能很慢；提交真实任务前再次检查磁盘租约，取消后不会继续派发。
    await heartbeat({
      repository: repository.fullName,
      batchId: batch.id,
      itemId: item.id,
    });
    signal.throwIfAborted();
    const payload = {
      installationId: repository.installationId,
      repositoryExternalId: repository.githubId,
      repositoryFullName: repository.fullName,
      subjectNumber: parsed.number,
      subjectRevision: revision,
      sourceEvent: "workbench_batch",
      sourceRevision: revision,
      workbenchBatchId: batch.id,
      workbenchItemId: item.id,
      workbenchGeneration:
        (item as BatchItem & { generation?: number }).generation ?? 0,
      workbenchDispatchAttempt: item.attempts,
    };
    const created = await tasks.create({
      taskType: parsed.taskType,
      repositoryId: repository.id,
      subjectNumber: parsed.number,
      subjectRevision: revision,
      policyVersion,
      dedupeKey,
      payload,
    });
    return {
      id: created.id,
      repositoryId: repository.id,
      status: created.status,
      subjectRevision: revision,
      payload,
      lastErrorCategory: null,
    };
  };

  const dispatchOwned = async (
    repository: BatchRepository,
    batch: Batch,
    item: BatchItem,
    summary: BatchDispatchSummary,
  ): Promise<void> => {
    const lease = {
      repository: repository.fullName,
      batchId: batch.id,
      itemId: item.id,
    };
    remember(lease);
    try {
      await heartbeat(lease);
      // 版本需要在建立任务去重键前从 GitHub 读取；跨批次共享同一真实任务。
      const { parsed, revision, policyVersion } = await resolveRevision(
        repository,
        item,
      );
      const key = workbenchTaskDedupeKey({
        repositoryId: repository.id,
        taskType: parsed.taskType,
        number: parsed.number,
        revision,
        policyVersion,
      });
      let task = await tasks.find(key);
      if (task) {
        const payload = taskPayload(task);
        if (
          task.repositoryId !== repository.id ||
          payload.subjectNumber !== parsed.number ||
          payload.subjectRevision !== revision
        )
          throw new BatchDispatchError(
            "task_identity_conflict",
            "批次关联的任务身份与已安装仓库不符",
          );
        // 同一任务可能已由其它批次或 webhook 创建；批次关联只记录在 metadata。
        const previousAttempt =
          typeof item.result?.dispatchAttempt === "number"
            ? item.result.dispatchAttempt
            : 1;
        const generation = item.generation ?? 0;
        const recordedGeneration = Number(payload.workbenchGeneration ?? 0);
        if (
          ["failed", "canceled"].includes(task.status) &&
          (previousAttempt < item.attempts || generation > recordedGeneration)
        ) {
          if (await tasks.retry(task.id)) {
            summary.resumed += 1;
            task = { ...task, status: "queued", lastErrorCategory: null };
          } else task = (await tasks.find(key)) ?? task;
        }
      } else {
        task = await createTask(
          repository,
          batch,
          item,
          parsed,
          revision,
          policyVersion,
          key,
        );
        summary.dispatched += 1;
      }
      await execute(repository.fullName, "batches.link", {
        id: batch.id,
        itemId: item.id,
        worker: workerId,
        result: {
          taskId: task.id,
          dispatchAttempt: item.attempts,
          revision: task.subjectRevision,
        },
      });
      if (["completed", "failed", "canceled"].includes(task.status)) {
        const outcome = await finish(repository.fullName, batch, item, task);
        summary[outcome] += 1;
      }
    } catch (error) {
      forget(lease);
      if (signal.aborted) return;
      summary.errors += 1;
      reportError(error, {
        repository: repository.fullName,
        batchId: batch.id,
        itemId: item.id,
      });
      if (error instanceof BatchDispatchError) {
        try {
          await finish(repository.fullName, batch, item, null, error.message);
          summary.failed += 1;
        } catch (finishError) {
          reportError(finishError, {
            repository: repository.fullName,
            batchId: batch.id,
            itemId: item.id,
          });
        }
      }
      // 网络/磁盘故障保留原租约和任务，下一周期恢复；不把暂时 IO 故障当成模型失败。
    }
  };

  const run = async (): Promise<BatchDispatchSummary> => {
    const summary: BatchDispatchSummary = {
      repositories: 0,
      batches: 0,
      claimed: 0,
      dispatched: 0,
      resumed: 0,
      completed: 0,
      failed: 0,
      canceled: 0,
      errors: 0,
    };
    if (signal.aborted) return summary;
    const installed = await tasks.repositories();
    for (const repository of installed) {
      if (signal.aborted) break;
      summary.repositories += 1;
      let offset = 0;
      while (!signal.aborted) {
        const page = await execute<{ items: Batch[]; total: number }>(
          repository.fullName,
          "batches.list",
          { limit: 1_000, offset },
        );
        for (const batch of page.items) {
          summary.batches += 1;
          if (batch.status === "canceled") {
            for (const item of batch.items) {
              forget({
                repository: repository.fullName,
                batchId: batch.id,
                itemId: item.id,
              });
              const task = await tasks.find(workbenchBatchTaskKey(batch, item));
              if (
                task &&
                task.repositoryId === repository.id &&
                (await tasks.cancel(task.id, "workbench batch canceled"))
              )
                summary.canceled += 1;
            }
            continue;
          }
          for (const item of batch.items) {
            if (item.status === "running" && item.worker === workerId)
              await dispatchOwned(repository, batch, item, summary);
          }
          if (
            !["queued", "running"].includes(batch.status) ||
            summary.claimed >= maxDispatch
          )
            continue;
          while (!signal.aborted && summary.claimed < maxDispatch) {
            const claimed = await execute<{
              batch: Batch;
              item: BatchItem | null;
            }>(repository.fullName, "batches.claim", {
              id: batch.id,
              worker: workerId,
              leaseMs,
            });
            if (!claimed.item) break;
            summary.claimed += 1;
            await dispatchOwned(
              repository,
              claimed.batch,
              claimed.item,
              summary,
            );
          }
        }
        offset += page.items.length;
        if (offset >= page.total || page.items.length === 0) break;
      }
    }
    return summary;
  };

  return {
    tick() {
      if (flight) return flight;
      flight = run().finally(() => {
        flight = undefined;
      });
      return flight;
    },
    async stop() {
      clearInterval(timer);
      controller.abort();
      await Promise.allSettled(
        [flight, renewal].filter(
          (promise): promise is Promise<BatchDispatchSummary> | Promise<void> =>
            promise !== undefined,
        ),
      );
      leases.clear();
    },
  };
}
