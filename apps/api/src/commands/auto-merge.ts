/** 仓库自动合并：只读队列与共享仓库锁保护下的原子配置。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  AUTO_MERGE_SETTING_KEYS,
  MAX_AUTO_MERGE_CHECKS,
  MAX_AUTO_MERGE_CHECK_NAME,
  type PullRequestMergeMethod,
} from "../../../../packages/config/src/index.js";
import {
  repositories,
  repositorySettings,
  pullRequestAutoMerges,
} from "../../../../packages/database/src/index.js";
import { audit, canAccessRepo, isReadOnlyRequest } from "../identity.js";
import { database } from "../runtime.js";
import {
  HttpError,
  json,
  parseJsonObject,
  readBody,
  UUID_PATTERN,
} from "../utils/http.js";
import type { HttpRoute } from "../utils/routes.js";

/** null 表示删除该键的仓库覆盖，回到跟随全局默认。 */
export type AutoMergeSettingsInput = {
  enabled: boolean | null;
  method: PullRequestMergeMethod | null;
  requiredChecks: string[] | null;
};

/** 一次请求原子提交三个键；未改动的键传 null，不会被固化成仓库覆盖。 */
export function parseAutoMergeSettingsInput(
  input: Record<string, unknown>,
): AutoMergeSettingsInput {
  if (
    Object.keys(input).length !== 3 ||
    Object.keys(input).some(
      (key) => !["enabled", "method", "requiredChecks"].includes(key),
    ) ||
    (input.enabled !== null && typeof input.enabled !== "boolean") ||
    (input.method !== null &&
      (typeof input.method !== "string" ||
        !["merge", "squash", "rebase"].includes(input.method))) ||
    (input.requiredChecks !== null &&
      (!Array.isArray(input.requiredChecks) ||
        input.requiredChecks.length > MAX_AUTO_MERGE_CHECKS))
  ) {
    throw new HttpError(
      400,
      "enabled, method and requiredChecks are required and must be valid values or null; additional fields are not allowed",
    );
  }
  let requiredChecks: string[] | null = null;
  if (input.requiredChecks !== null) {
    requiredChecks = [];
    for (const value of input.requiredChecks) {
      if (
        typeof value !== "string" ||
        /\p{Cc}/u.test(value) ||
        !value.trim() ||
        value.trim().length > MAX_AUTO_MERGE_CHECK_NAME
      ) {
        throw new HttpError(
          400,
          `requiredChecks names must contain 1-${MAX_AUTO_MERGE_CHECK_NAME} characters without control characters`,
        );
      }
      requiredChecks.push(value.trim());
    }
    requiredChecks = [...new Set(requiredChecks)];
  }
  return {
    enabled: input.enabled as boolean | null,
    method: input.method as PullRequestMergeMethod | null,
    requiredChecks,
  };
}

function repositoryIdFromRequest(request: IncomingMessage): string {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  let id: string;
  try {
    id = decodeURIComponent(pathname.split("/")[2] ?? "");
  } catch {
    throw new HttpError(400, "invalid repository id");
  }
  if (!UUID_PATTERN.test(id)) throw new HttpError(400, "invalid repository id");
  return id;
}

/** 只选取 UI 所需字段，安装凭据及其他仓库的数据不进入返回值。 */
export async function handleRepositoryAutoMerges(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const repositoryId = repositoryIdFromRequest(request);
  if (!(await canAccessRepo(request, repositoryId, "view")))
    throw new HttpError(403, "view access required");
  const raw = new URL(request.url ?? "/", "http://localhost").searchParams.get(
    "limit",
  );
  const limit = raw === null ? 20 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new HttpError(400, "limit must be an integer between 1 and 100");
  const [repository] = await database.db
    .select({ id: repositories.id })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);
  if (!repository) throw new HttpError(404, "repository_not_found");
  const [items, manages, readOnly] = await Promise.all([
    database.db
      .select({
        id: pullRequestAutoMerges.id,
        taskId: pullRequestAutoMerges.taskId,
        repositoryId: pullRequestAutoMerges.repositoryId,
        pullNumber: pullRequestAutoMerges.pullNumber,
        headSha: pullRequestAutoMerges.headSha,
        method: pullRequestAutoMerges.method,
        status: pullRequestAutoMerges.status,
        reason: pullRequestAutoMerges.reason,
        message: pullRequestAutoMerges.message,
        mergeCommitSha: pullRequestAutoMerges.mergeCommitSha,
        attempts: pullRequestAutoMerges.attempts,
        nextAttemptAt: pullRequestAutoMerges.nextAttemptAt,
        createdAt: pullRequestAutoMerges.createdAt,
        updatedAt: pullRequestAutoMerges.updatedAt,
        completedAt: pullRequestAutoMerges.completedAt,
      })
      .from(pullRequestAutoMerges)
      .where(eq(pullRequestAutoMerges.repositoryId, repositoryId))
      .orderBy(
        desc(pullRequestAutoMerges.createdAt),
        desc(pullRequestAutoMerges.id),
      )
      .limit(limit),
    canAccessRepo(request, repositoryId, "manage"),
    isReadOnlyRequest(request),
  ]);
  json(response, 200, { items, canManage: manages && !readOnly }, requestId);
}

/** 与 worker 的 repository → task → request 锁序一致；逐键覆盖/清除与禁用取消原子提交。 */
export async function handleRepositoryAutoMergeSettings(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const repositoryId = repositoryIdFromRequest(request);
  if (
    !(await canAccessRepo(request, repositoryId, "manage")) ||
    (await isReadOnlyRequest(request))
  )
    throw new HttpError(403, "writable manage access required");
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonObject(await readBody(request, 128 * 1024));
  } catch (error) {
    if (error instanceof SyntaxError) throw new HttpError(400, "invalid JSON");
    throw error;
  }
  const settings = parseAutoMergeSettingsInput(parsed);
  const now = new Date();
  const repository = await database.db.transaction(async (tx) => {
    const [repo] = await tx
      .select({
        id: repositories.id,
        owner: repositories.owner,
        name: repositories.name,
      })
      .from(repositories)
      .where(eq(repositories.id, repositoryId))
      .for("update")
      .limit(1);
    if (!repo) throw new HttpError(404, "repository_not_found");
    const values: (string | null)[] = [
      settings.enabled === null ? null : String(settings.enabled),
      settings.method,
      settings.requiredChecks === null
        ? null
        : JSON.stringify(settings.requiredChecks),
    ];
    // null 键删除仓库覆盖，逐键回到全局默认；其余键原子写入。
    const cleared = AUTO_MERGE_SETTING_KEYS.filter(
      (_key, index) => values[index] === null,
    );
    const upserts = AUTO_MERGE_SETTING_KEYS.flatMap((key, index) => {
      const value = values[index];
      return value === null || value === undefined
        ? []
        : [{ repositoryId, key, value, updatedAt: now }];
    });
    if (cleared.length)
      await tx
        .delete(repositorySettings)
        .where(
          and(
            eq(repositorySettings.repositoryId, repositoryId),
            inArray(repositorySettings.key, cleared),
          ),
        );
    if (upserts.length)
      await tx
        .insert(repositorySettings)
        .values(upserts)
        .onConflictDoUpdate({
          target: [repositorySettings.repositoryId, repositorySettings.key],
          set: { value: sql`excluded.value`, updatedAt: now },
        });
    if (settings.enabled === false) {
      await tx
        .update(pullRequestAutoMerges)
        .set({
          status: "canceled",
          reason: "configuration_disabled",
          message: "仓库已关闭自动合并。",
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(pullRequestAutoMerges.repositoryId, repositoryId),
            inArray(pullRequestAutoMerges.status, [
              "pending",
              "waiting",
              "blocked",
            ]),
          ),
        );
    }
    return repo;
  });
  audit(
    request,
    "repository_auto_merge.update",
    `${repository.owner}/${repository.name}`,
    settings,
  );
  json(response, 200, { status: "ok", settings }, requestId);
}

export const routes = [
  {
    path: /^\/repositories\/[^/]+\/auto-merge$/,
    methods: ["GET"],
    handle: handleRepositoryAutoMerges,
  },
  {
    path: /^\/repositories\/[^/]+\/auto-merge\/settings$/,
    methods: ["PUT"],
    handle: handleRepositoryAutoMergeSettings,
  },
] satisfies readonly HttpRoute[];
