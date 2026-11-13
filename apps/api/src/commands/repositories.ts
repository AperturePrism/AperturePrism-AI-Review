/**
 * 仓库：安装同步、Issue 列表、仓库设置与发布撤回。
 * 调用示例：handleRevokeSubject(request, response, requestId)。
 * HTTP 路径保持兼容；跨文件依赖在下方显式列出。
 */
import { parseJsonObject } from "../utils/http.js";
import type { HttpRoute } from "../utils/routes.js";
import { getSettingSpec } from "../../../../packages/config/src/index.js";
import {
  repositories,
  subjectResults,
  externalPublications,
  systemSettings,
  upsertInstalledRepositories,
  pruneRepositories,
  isRepositorySettingKey,
  setRepositorySetting,
  getRepositorySettings,
  REPOSITORY_SETTING_KEYS,
} from "../../../../packages/database/src/index.js";
import { GitHubApiError } from "../../../../packages/github-adapter/src/index.js";
import { repositoryOwnerName } from "../../../../packages/issue-analysis/src/index.js";
import {
  startTimer,
  metrics,
} from "../../../../packages/observability/src/index.js";
import { githubClientPromise } from "../github.js";
import {
  visibleRepoScope,
  canAccessRepo,
  audit,
  isAdminRequest,
} from "../identity.js";
import { runtimeSettings } from "../preferences.js";
import { database, logger } from "../runtime.js";
import { readBody, json, UUID_PATTERN, HttpError } from "../utils/http.js";
import { settingDefaultValue } from "./settings.js";
import { and, eq, desc, asc, isNotNull, inArray } from "drizzle-orm";
import { type IncomingMessage, type ServerResponse } from "node:http";

/**
 * One-click revoke of a published AI analysis / review (D-stage interaction).
 * Removes the artifacts this app published for a given issue/PR: review is
 * dismissed, comments deleted, and the suggested labels removed. Best-effort:
 * a single artifact failing to revoke never blocks the rest.
 */
export async function handleRevokeSubject(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const body = await readBody(request);
  let parsed: {
    repositoryFullName?: unknown;
    number?: unknown;
    type?: unknown;
  };
  try {
    parsed = parseJsonObject(body);
  } catch {
    json(response, 400, { status: "error", reason: "invalid JSON" }, requestId);
    return;
  }
  const repositoryFullName =
    typeof parsed.repositoryFullName === "string"
      ? parsed.repositoryFullName.trim()
      : "";
  const subjectNumber = Number(parsed.number);
  const type = parsed.type === "pr" ? "pr" : "issue";
  if (
    !repositoryFullName ||
    !Number.isInteger(subjectNumber) ||
    subjectNumber <= 0
  ) {
    json(
      response,
      400,
      { status: "error", reason: "需要仓库（owner/name）与正整数编号" },
      requestId,
    );
    return;
  }
  const [owner, name] = repositoryFullName.split("/");
  if (!owner || !name) {
    json(
      response,
      400,
      { status: "error", reason: "仓库格式应为 owner/name" },
      requestId,
    );
    return;
  }

  const repoRows = await database.db
    .select({ installationId: repositories.installationId })
    .from(repositories)
    .where(and(eq(repositories.owner, owner), eq(repositories.name, name)))
    .limit(1);
  const installationId = repoRows[0]?.installationId;
  if (!installationId) {
    json(
      response,
      404,
      { status: "error", reason: "repository_not_installed" },
      requestId,
    );
    return;
  }

  const subject = await database.db
    .select({ taskId: subjectResults.taskId, result: subjectResults.result })
    .from(subjectResults)
    .where(
      and(
        eq(subjectResults.subjectType, type),
        eq(subjectResults.subjectNumber, subjectNumber),
        eq(subjectResults.repositoryFullName, repositoryFullName),
      ),
    )
    .orderBy(desc(subjectResults.createdAt))
    .limit(1);
  if (!subject[0] || !subject[0].taskId) {
    json(
      response,
      404,
      { status: "error", reason: "未找到该对象的分析结果" },
      requestId,
    );
    return;
  }

  const publications = await database.db
    .select({
      channel: externalPublications.channel,
      externalObjectId: externalPublications.externalObjectId,
    })
    .from(externalPublications)
    .where(eq(externalPublications.taskId, subject[0].taskId));

  const github = await githubClientPromise;
  if (!github) {
    json(
      response,
      503,
      { status: "error", reason: "github_not_configured" },
      requestId,
    );
    return;
  }

  const revoked = { comments: 0, reviews: 0, labels: 0 };
  for (const pub of publications) {
    if (pub.externalObjectId === null) continue;
    const externalId = Number(pub.externalObjectId);
    if (!Number.isInteger(externalId)) continue;
    try {
      if (pub.channel === "github_issue_comment") {
        await github.deleteIssueComment({
          installationId,
          owner,
          name,
          commentId: externalId,
        });
        revoked.comments += 1;
      } else if (pub.channel === "github_pull_request_review") {
        const reviews = await github.listPullRequestReviews({
          installationId,
          owner,
          name,
          pullNumber: subjectNumber,
        });
        const review = reviews.find((item) => item.id === externalId);
        if (review && review.state !== "DISMISSED") {
          await github.dismissPullRequestReview({
            installationId,
            owner,
            name,
            pullNumber: subjectNumber,
            reviewId: externalId,
            message: "已由管理员在 WebUI 撤回本次 AI 审查",
          });
          revoked.reviews += 1;
        }
      }
      // check_run 无法由 App 删除，保留用于追溯。
    } catch (error) {
      void error; // 单个撤回失败不阻塞其他
    }
  }

  // Issue 标签：移除该次分析结果建议的标签。
  if (type === "issue") {
    const result = subject[0].result as { suggestedLabels?: unknown } | null;
    const labels = Array.isArray(result?.suggestedLabels)
      ? result.suggestedLabels.filter(
          (label): label is string => typeof label === "string",
        )
      : [];
    if (labels.length > 0) {
      try {
        await github.removeIssueLabels({
          installationId,
          owner,
          name,
          number: subjectNumber,
          labels,
        });
        revoked.labels += labels.length;
      } catch (error) {
        void error;
      }
    }
  }

  json(response, 200, { status: "ok", revoked }, requestId);
}

/** Installed GitHub repositories with per-repo task/result counts. */
export async function handleRepositories(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  // githubConfigured 以「能否真的实例化出客户端」为准（含 DB 覆盖），
  // 前端据此区分「App 没配」与「配了但还没有仓库」两种空态。
  const [github, repos, taskCounts, resultCounts] = await Promise.all([
    githubClientPromise,
    database.db
      .select({
        id: repositories.id,
        githubId: repositories.githubId,
        owner: repositories.owner,
        name: repositories.name,
        createdAt: repositories.createdAt,
      })
      .from(repositories)
      .orderBy(asc(repositories.name)),
    database.sql<{ repository_id: string; c: number }[]>`
      SELECT repository_id, count(*)::int AS c FROM analysis_tasks
      WHERE repository_id IS NOT NULL GROUP BY repository_id
    `,
    database.sql<{ repository_full_name: string; c: number }[]>`
      SELECT repository_full_name, count(*)::int AS c FROM subject_results GROUP BY repository_full_name
    `,
  ]);
  const taskByRepo = new Map(
    taskCounts.map((r) => [r.repository_id, Number(r.c)]),
  );
  const resultByName = new Map(
    resultCounts.map((r) => [r.repository_full_name, Number(r.c)]),
  );
  // 仓库可见性（方向七）：admin/bearer 全可见；其它用户仅可见被授权的仓库。
  // grants 为空 → 用户没有授权 → 不列任何仓库（除非是 admin）。
  const scope = await visibleRepoScope(request);
  const visibleIds = scope ? scope.ids : null;
  // A repo may have been ingested more than once (different GitHub ids from
  // separate webhook deliveries); merge by full name for a clean list.
  const byName = new Map<
    string,
    {
      id: string;
      owner: string;
      taskCount: number;
      resultCount: number;
      createdAt: Date;
    }
  >();
  for (const repo of repos) {
    // 非 admin 且该仓库不在授权集内 → 跳过（不展示）。
    if (visibleIds !== null && !visibleIds.has(repo.id)) continue;
    const fullName = `${repo.owner}/${repo.name}`;
    const existing = byName.get(fullName);
    const taskCount = taskByRepo.get(repo.id) ?? 0;
    const resultCount = resultByName.get(fullName) ?? 0;
    if (!existing) {
      byName.set(fullName, {
        id: repo.id,
        owner: repo.owner,
        taskCount,
        resultCount,
        createdAt: repo.createdAt,
      });
    } else {
      existing.taskCount += taskCount;
      existing.resultCount = Math.max(existing.resultCount, resultCount);
    }
  }
  json(
    response,
    200,
    {
      githubConfigured: github !== null,
      items: [...byName.entries()].map(([fullName, info]) => ({
        id: info.id,
        owner: info.owner,
        name: fullName.split("/")[1] ?? fullName,
        fullName,
        taskCount: info.taskCount,
        resultCount: info.resultCount,
        createdAt: info.createdAt,
      })),
    },
    requestId,
  );
}

/**
 * GET /repositories/issues?fullName=owner/name&type=issue|pr&limit=N — lists
 * recent open issues / pull requests for an installed repository. Lets the
 * WebUI manual-trigger form offer a pickable dropdown instead of guessing a
 * numeric subject id. Read-only; any authenticated user may use it.
 */
export async function handleRepositoryIssues(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  const fullName = url.searchParams.get("fullName")?.trim() ?? "";
  const type = url.searchParams.get("type") === "pr" ? "pr" : "issue";
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.trunc(limitRaw), 1), 50)
    : 20;
  const identity = repositoryOwnerName(fullName);
  if (!identity) {
    json(
      response,
      400,
      { status: "error", reason: "fullName must be owner/repo" },
      requestId,
    );
    return;
  }
  const rows = await database.db
    .select({
      id: repositories.id,
      installationId: repositories.installationId,
    })
    .from(repositories)
    .where(
      and(
        eq(repositories.owner, identity.owner),
        eq(repositories.name, identity.name),
      ),
    )
    .limit(1);
  const repo = rows[0];
  if (!repo || !repo.installationId) {
    json(
      response,
      404,
      { status: "error", reason: "repository_not_installed" },
      requestId,
    );
    return;
  }
  const github = await githubClientPromise;
  if (!github) {
    json(
      response,
      503,
      { status: "error", reason: "github_not_configured" },
      requestId,
    );
    return;
  }
  try {
    const base = {
      installationId: repo.installationId,
      owner: identity.owner,
      name: identity.name,
      state: "open" as const,
      perPage: limit,
      page: 1,
    };
    const items =
      type === "pr"
        ? await github.listPullRequests(base)
        : await github.listIssues(base);
    json(
      response,
      200,
      {
        type,
        items: items.map((item) => ({
          number: item.number,
          title: item.title,
        })),
      },
      requestId,
    );
  } catch (error) {
    if (error instanceof GitHubApiError) {
      json(
        response,
        400,
        { status: "error", reason: error.category },
        requestId,
      );
      return;
    }
    throw error;
  }
}

/* ---------- GitHub App installation repository sync ---------- */

export const REPOSITORY_SYNC_INTERVAL_MS = 12 * 60 * 60 * 1_000;

// 每 12 小时自动同步
let repositorySyncRunning = false;

/** 命中 GitHub 限流后的「暂停直至重置」时间戳（进程内）；期间自动/手动同步直接跳过。 */
let repositorySyncRateLimitResetAt = 0;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 写一个 worker 消费的触发键（scan_trigger / index_trigger）。 */
async function setTriggerSetting(key: string): Promise<void> {
  await database.db
    .insert(systemSettings)
    .values({ key, value: new Date().toISOString() })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: new Date().toISOString(), updatedAt: new Date() },
    });
}

/** 把 github-adapter 的稳定错误类别映射成 WebUI 能解释的 reason 码。 */
function reasonOfSyncError(error: unknown): string {
  if (error instanceof GitHubApiError) {
    if (error.category === "rate_limited") return "rate_limited";
    if (error.category === "authentication_failed") return "github_auth_failed";
    if (error.category === "not_found") return "github_not_found";
    if (error.category === "network" || error.category === "server_error")
      return "github_unavailable";
  }
  return error instanceof Error ? error.message : "unknown";
}

/**
 * Pulls every installed repository from the GitHub App for each known
 * installation and upserts them into the `repositories` table. Each
 * installation is retried with exponential backoff on transient failures;
 * hitting the GitHub rate limit aborts the whole pass (every installation
 * would fail identically). `details` carries the per-installation failure
 * reason so the WebUI can show why a sync failed.
 */
export async function syncInstallations(): Promise<{
  installations: number;
  synced: number;
  errors: number;
  skipped?: boolean;
  removed?: number;
  details?: { installationId: string; reason: string }[];
  reason?: string;
  rateLimitedUntil?: string;
  scope?: string;
  scanned?: boolean;
}> {
  if (repositorySyncRunning)
    return { installations: 0, synced: 0, errors: 0, skipped: true };
  // 限流感知：GitHub 429 后暂停至 reset，避免明知会再被限流还硬打一轮。
  if (Date.now() < repositorySyncRateLimitResetAt) {
    return {
      installations: 0,
      synced: 0,
      errors: 0,
      skipped: true,
      reason: "rate_limited_until",
      rateLimitedUntil: new Date(repositorySyncRateLimitResetAt).toISOString(),
    };
  }
  repositorySyncRunning = true;
  try {
    const github = await githubClientPromise;
    if (!github)
      return {
        installations: 0,
        synced: 0,
        errors: 1,
        details: [{ installationId: "-", reason: "github_not_configured" }],
      };
    // 权威安装列表来自 GitHub（App JWT）；本地表只是缓存。若只读本地表，
    // 新用户安装 App 后本地没有对应安装，同步永远发现不了新仓库（用户反馈
    // 「同步显示 0 个仓库」的根因）。
    let ids: string[];
    try {
      const installations = await github.listInstallations();
      ids = installations.map((installation) => installation.id);
    } catch (error) {
      // 凭据失效预检：App JWT 认证失败 / App 不存在时本地回退毫无意义（本地
      // 也是这些安装来的，重试只会再撞同一面墙），直接给「App 凭据失效」。
      if (
        error instanceof GitHubApiError &&
        (error.category === "authentication_failed" ||
          error.category === "not_found")
      ) {
        logger.warn(
          { err: error },
          "repository sync aborted: GitHub App credentials invalid",
        );
        return {
          installations: 0,
          synced: 0,
          errors: 1,
          details: [{ installationId: "-", reason: "github_auth_failed" }],
        };
      }
      if (
        error instanceof GitHubApiError &&
        error.category === "rate_limited"
      ) {
        repositorySyncRateLimitResetAt =
          Date.now() + (error.retryAfterMs ?? 60_000);
        return {
          installations: 0,
          synced: 0,
          errors: 1,
          reason: "rate_limited",
          rateLimitedUntil: new Date(
            repositorySyncRateLimitResetAt,
          ).toISOString(),
          details: [{ installationId: "-", reason: "rate_limited" }],
        };
      }
      // 网络/服务端抖动：回退到本地已知安装，至少维持存量仓库的同步。
      logger.warn(
        { err: error },
        "listInstallations failed, falling back to local installation ids",
      );
      const rows = await database.db
        .select({ installationId: repositories.installationId })
        .from(repositories)
        .where(isNotNull(repositories.installationId));
      ids = [
        ...new Set(
          rows
            .map((row) => row.installationId)
            .filter((value): value is string => Boolean(value)),
        ),
      ];
    }
    let synced = 0;
    let errors = 0;
    const details: { installationId: string; reason: string }[] = [];
    // 本次成功拉取到的「安装 → 仓库 id 集合」，供同步后清理已取消授权/已移除的仓库。
    const installedByInstallation = new Map<string, Set<string>>();
    for (const installationId of ids) {
      // Exponential backoff (400ms → 1600ms): GitHub App token minting is
      // occasionally flaky and a short backoff recovers the vast majority of
      // transient failures without hammering the API.
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const repos =
            await github.listInstallationRepositories(installationId);
          installedByInstallation.set(
            installationId,
            new Set(repos.map((repo) => String(repo.id))),
          );
          synced += await upsertInstalledRepositories(
            database.db,
            installationId,
            repos,
          );
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          // Rate limit is global, not per-installation: abort the whole pass
          // and pause until the reset window passes.
          if (
            error instanceof GitHubApiError &&
            error.category === "rate_limited"
          ) {
            repositorySyncRateLimitResetAt =
              Date.now() + (error.retryAfterMs ?? 60_000);
            errors += 1;
            details.push({ installationId, reason: "rate_limited" });
            logger.warn(
              { installationId, retryAfterMs: error.retryAfterMs },
              "repository sync aborted: GitHub rate limit reached",
            );
            return {
              installations: ids.length,
              synced,
              errors,
              details,
              reason: "rate_limited",
              rateLimitedUntil: new Date(
                repositorySyncRateLimitResetAt,
              ).toISOString(),
            };
          }
          if (attempt < 2) {
            logger.warn(
              { err: error, installationId, attempt: attempt + 1 },
              "installation repository sync failed, retrying with backoff",
            );
            await sleep(500 * 2 ** attempt);
          }
        }
      }
      if (lastError) {
        errors += 1;
        const reason = reasonOfSyncError(lastError);
        details.push({ installationId, reason });
        logger.warn(
          { err: lastError, installationId },
          "installation repository sync failed",
        );
      }
    }
    // 同步后清理：删除「安装已移除」或「仓库已取消授权」的本地行（仅在拿到权威
    // 列表后执行，避免一次失败误删仍在授权的仓库）。
    const removed = await pruneRepositories(
      database.db,
      ids,
      installedByInstallation,
    );
    if (removed > 0) {
      logger.info({ removed }, "pruned repositories no longer installed");
    }
    // 同步范围：按全局设置决定同步后拉多深的数据。metadata 之外的新仓库由
    // scan/index 触发键让 worker 下一轮 pass 自动补数据 —— 比等 12h 自动扫描及时。
    const scope = runtimeSettings.get("repo_sync_scope") || "metadata";
    if (scope === "issues_pr" || scope === "full") {
      await setTriggerSetting("scan_trigger");
    }
    if (scope === "full") {
      await setTriggerSetting("index_trigger");
    }
    return {
      installations: ids.length,
      synced,
      errors,
      details,
      removed,
      scope,
      scanned: scope !== "metadata",
    };
  } finally {
    repositorySyncRunning = false;
  }
}

/**
 * GET/PUT /repositories/:id/settings — 仓库级分析行为覆盖。
 *
 * 同一实例常同时接入个人项目与协作项目：自动改标题在后者未必受欢迎，所以这些
 * 开关要能按仓库分别控制（issue #54）。语义与全局设置一致 —— 有值则覆盖，
 * 无值跟随全局，因此 PUT 接受 `value: null` 作为「删除覆盖」。
 *
 * 白名单只放与单仓库相关的键：日志级别、访问令牌、OAuth 这些是进程级或账户级
 * 的，按仓库覆盖不会生效，只会给出「我改了却没用」的错觉。
 */
export async function handleRepositorySettings(
  request: IncomingMessage,
  response: ServerResponse,
  repositoryId: string,
  requestId: string,
): Promise<void> {
  // 先确认仓库存在：否则 PUT 会因外键失败抛 500，而真实原因是 id 打错了。
  const repoRows = await database.db
    .select({
      id: repositories.id,
      owner: repositories.owner,
      name: repositories.name,
    })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);
  const repo = repoRows[0];
  if (!repo) {
    json(
      response,
      404,
      { status: "error", reason: "repository_not_found" },
      requestId,
    );
    return;
  }

  if (request.method === "PUT") {
    // 方向七：写仓库设置需 admin 或该仓库 manage 授权。
    if (!(await canAccessRepo(request, repositoryId, "manage"))) {
      json(
        response,
        403,
        { status: "error", reason: "admin or manage access required" },
        requestId,
      );
      return;
    }
    const body = await readBody(request);
    let parsed: { key?: unknown; value?: unknown };
    try {
      parsed = parseJsonObject(body);
    } catch {
      json(
        response,
        400,
        { status: "error", reason: "invalid JSON" },
        requestId,
      );
      return;
    }
    const key = typeof parsed.key === "string" ? parsed.key : null;
    if (!key || !isRepositorySettingKey(key)) {
      json(
        response,
        400,
        { status: "error", reason: "unsupported_setting_key" },
        requestId,
      );
      return;
    }
    // null 表示删除覆盖、回到跟随全局；不接受这个动作的话，一旦设过值就再也
    // 回不去了，只能在仓库上留一份全局值的副本。
    const value =
      parsed.value === null || parsed.value === undefined
        ? null
        : String(parsed.value);
    await setRepositorySetting(database.db, {
      repositoryId,
      key,
      value,
    });
    audit(request, "repository_settings.update", `${repo.owner}/${repo.name}`, {
      key,
      cleared: value === null,
    });
    json(
      response,
      200,
      { status: "ok", key, cleared: value === null },
      requestId,
    );
    return;
  }

  if (request.method !== "GET") {
    json(
      response,
      405,
      { status: "error", reason: "method not allowed" },
      requestId,
    );
    return;
  }

  // 方向七：读仓库设置需 admin 或该仓库 view（含 manage）授权。
  if (!(await canAccessRepo(request, repositoryId, "view"))) {
    json(
      response,
      403,
      { status: "error", reason: "view access required" },
      requestId,
    );
    return;
  }

  const [overrides, globalRows] = await Promise.all([
    getRepositorySettings(database.db, repositoryId),
    database.db
      .select({ key: systemSettings.key, value: systemSettings.value })
      .from(systemSettings)
      .where(inArray(systemSettings.key, [...REPOSITORY_SETTING_KEYS])),
  ]);
  const globals = new Map(globalRows.map((row) => [row.key, row.value]));
  json(
    response,
    200,
    {
      repository: {
        id: repositoryId,
        fullName: `${repo.owner}/${repo.name}`,
      },
      // globalValue 一并回给前端：界面要能显示「跟随全局（当前：已开启）」，
      // 否则用户看不出不覆盖时到底是什么行为。
      // 元数据同样由注册表提供，前端不再维护第二份字段文案。
      items: [...REPOSITORY_SETTING_KEYS].map((key) => {
        const spec = getSettingSpec(key);
        return {
          key,
          label: spec?.label ?? key,
          hint: spec?.hint ?? "",
          kind: spec?.kind ?? "string",
          secret: spec?.secret ?? false,
          ...(spec?.options ? { options: spec.options } : {}),
          overridden: overrides.has(key),
          value: overrides.get(key) ?? "",
          globalValue: globals.get(key) ?? "",
          /** 两边都没配时的应用默认，界面显示「跟随全局」时要用它。 */
          defaultValue: settingDefaultValue(key),
        };
      }),
    },
    requestId,
  );
}

/** POST /repositories/sync — admin-triggered installation repository sync. */
export async function handleRepositorySync(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  if (!(await isAdminRequest(request))) {
    json(
      response,
      403,
      { status: "error", reason: "admin required" },
      requestId,
    );
    return;
  }
  const syncTimer = startTimer();
  const result = await syncInstallations();
  metrics.recordDuration("repositories.sync_ms", syncTimer());
  metrics.increment("repositories.sync_runs");
  if (result.removed)
    metrics.increment("repositories.sync_removed", result.removed);
  audit(request, "repositories.sync", undefined, result);
  // 限流暂停窗口内再次点同步：显式 429，前端据此提示「GitHub 限流中，稍后再试」。
  if (
    result.reason === "rate_limited_until" ||
    result.reason === "rate_limited"
  ) {
    json(
      response,
      429,
      {
        status: "error",
        reason: result.reason,
        rateLimitedUntil: result.rateLimitedUntil ?? null,
        detail:
          result.reason === "rate_limited_until"
            ? "GitHub 限流暂停窗口内，请等待重置后再同步"
            : "GitHub 限流，同步已中止",
      },
      requestId,
    );
    return;
  }
  // 已有同步在进行（进程内锁）：显式返回 409，前端据此提示「正在同步中」，
  // 而不是收到一个静默的 0 结果让用户以为同步没生效。
  if (result.skipped) {
    json(
      response,
      409,
      { status: "error", reason: "sync_in_progress" },
      requestId,
    );
    return;
  }
  // App 凭据失效：502 + 可操作提示（去 GitHub 接入更换），不要落到 200 让用户以为成功。
  // 不用 401 —— 401 在 WebUI 语义是「会话失效」，会触发全局登出。
  if (result.details?.[0]?.reason === "github_auth_failed") {
    json(
      response,
      502,
      {
        status: "error",
        reason: "github_auth_failed",
        detail: "GitHub App 凭据无效，请到「GitHub 接入」重新配置后重试",
      },
      requestId,
    );
    return;
  }
  json(response, 200, { status: "ok", ...result }, requestId);
}

// HTTP 入口与业务放在同一处：新增同类入口只修改本文件。
export const routes = [
  {
    path: /^\/repositories\/[^/]+\/queue$/,
    methods: ["GET"],
    handle: handleRepositoryQueue,
  },
  { path: "/repositories", methods: ["GET"], handle: handleRepositories },
  {
    path: "/repositories/issues",
    methods: ["GET"],
    handle: handleRepositoryIssues,
  },
  {
    path: "/repositories/sync",
    methods: ["POST"],
    handle: handleRepositorySync,
  },
  {
    path: "/repos/revoke",
    methods: ["POST"],
    admin: true,
    handle: handleRevokeSubject,
  },
  {
    path: /^\/repositories\/[^/]+\/settings$/,
    methods: ["GET", "PUT"],
    handle: (request, response, id) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      const repositoryId = decodeURIComponent(
        path.slice("/repositories/".length, -"/settings".length),
      ).trim();
      if (!repositoryId) {
        json(
          response,
          400,
          { status: "error", reason: "repository id required" },
          id,
        );
        return;
      }
      return handleRepositorySettings(request, response, repositoryId, id);
    },
  },
] satisfies readonly HttpRoute[];

/**
 * GET /repositories/:id/queue：在一个仓库内定位排队、重试和租约失效。
 * 只返回汇总与失败类别，不读取任务正文、模型提示词或账号凭据。
 */
export async function handleRepositoryQueue(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const repositoryId = decodeURIComponent(path.split("/")[2] ?? "").trim();
  if (!UUID_PATTERN.test(repositoryId))
    throw new HttpError(400, "repository id must be a UUID");
  if (!(await canAccessRepo(request, repositoryId, "view"))) {
    json(
      response,
      404,
      { status: "error", reason: "repository not found" },
      requestId,
    );
    return;
  }
  const [repository] = await database.db
    .select({
      id: repositories.id,
      owner: repositories.owner,
      name: repositories.name,
    })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);
  if (!repository) {
    json(
      response,
      404,
      { status: "error", reason: "repository not found" },
      requestId,
    );
    return;
  }
  const [statuses, priorities, failures] = await Promise.all([
    database.sql<
      {
        status: string;
        task_type: string;
        count: number;
        expired: number;
        oldest: Date | null;
      }[]
    >`
      SELECT status, task_type, count(*)::int AS count,
        count(*) FILTER (WHERE lease_expires_at < now() AND status IN ('leased','running','publishing'))::int AS expired,
        min(created_at) AS oldest
      FROM analysis_tasks WHERE repository_id = ${repositoryId}
      GROUP BY status, task_type ORDER BY status, task_type`,
    database.sql<{ priority: number; count: number }[]>`
      SELECT priority, count(*)::int AS count FROM analysis_tasks
      WHERE repository_id = ${repositoryId} AND status IN ('queued','retry_wait')
      GROUP BY priority ORDER BY priority DESC LIMIT 100`,
    database.sql<{ category: string; count: number }[]>`
      SELECT coalesce(a.error_category, 'none') AS category, count(*)::int AS count
      FROM task_attempts a INNER JOIN analysis_tasks t ON t.id = a.task_id
      WHERE t.repository_id = ${repositoryId} AND a.started_at >= now() - interval '24 hours'
        AND a.error_category IS NOT NULL
      GROUP BY a.error_category ORDER BY count DESC LIMIT 30`,
  ]);
  const totals = {
    queued: 0,
    retryWait: 0,
    inflight: 0,
    failed: 0,
    completed: 0,
    canceled: 0,
    expiredLeases: 0,
  };
  let oldestPendingAt: Date | null = null;
  for (const row of statuses) {
    if (row.status === "queued") totals.queued += row.count;
    if (row.status === "retry_wait") totals.retryWait += row.count;
    if (["leased", "running", "publishing"].includes(row.status))
      totals.inflight += row.count;
    if (row.status === "failed") totals.failed += row.count;
    if (row.status === "completed") totals.completed += row.count;
    if (row.status === "canceled") totals.canceled += row.count;
    totals.expiredLeases += row.expired;
    if (
      ["queued", "retry_wait"].includes(row.status) &&
      row.oldest &&
      (!oldestPendingAt || row.oldest < oldestPendingAt)
    )
      oldestPendingAt = row.oldest;
  }
  const snapshotAt = new Date();
  const hints: string[] = [];
  if (totals.expiredLeases)
    hints.push("存在已过期但尚未回收的任务租约，请检查 scheduler 是否运行。");
  if (totals.queued > 0 && totals.inflight === 0)
    hints.push(
      "已有任务排队但当前没有执行中的任务，请检查 analysis-worker 连接与运行状态。",
    );
  if (failures.some((failure) => failure.category === "rate_limited"))
    hints.push("过去 24 小时出现模型限流，请检查供应商额度或降低任务并发。");
  if (failures.some((failure) => failure.category === "authentication_failed"))
    hints.push("过去 24 小时出现模型认证失败，请检查 Provider 账户设置。");
  json(
    response,
    200,
    {
      repository: {
        id: repository.id,
        fullName: `${repository.owner}/${repository.name}`,
      },
      snapshotAt,
      summary: {
        ...totals,
        oldestPendingAt,
        oldestPendingAgeMs: oldestPendingAt
          ? Math.max(0, snapshotAt.getTime() - oldestPendingAt.getTime())
          : null,
      },
      byStatusAndType: statuses,
      byPriority: priorities,
      recentFailures: failures,
      hints,
    },
    requestId,
  );
}
