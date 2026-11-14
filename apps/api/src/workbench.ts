/**
 * 审查工作台入口：沿用现有账号和仓库授权，只给通过鉴权的 HTTP 请求调用。
 * 调用示例：await handleWorkbench(request, response, requestId)。
 * 数据目录独立于代码目录；部署升级不会覆盖审查策略和基线。
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq, sql } from "drizzle-orm";
import { repositories } from "../../../packages/database/src/index.js";
import {
  canAccessRepo,
  isAdminRequest,
  isReadOnlyRequest,
  sessionLogin,
} from "./identity.js";
import { database, logger } from "./runtime.js";
import type {
  Actor,
  Workbench,
} from "../../../packages/review-workbench/src/types.js";
import { UUID_PATTERN } from "./utils/http.js";

let workbench: Promise<Workbench> | null = null;

/** API 与自动化共享同一个工作台配置，不另建一份数据目录。 */
export async function getWorkbench(): Promise<Workbench> {
  workbench ??= (async () => {
    const dataDirectory =
      process.env.WORKBENCH_DATA_DIRECTORY ??
      process.env.APERTURE_WORKBENCH_DATA_DIR ??
      join(homedir(), ".apertureprism", "workbench");
    if (!isAbsolute(dataDirectory))
      throw new Error("WORKBENCH_DATA_DIRECTORY must be an absolute path");
    const { createWorkbench } =
      await import("../../../packages/review-workbench/src/index.js");
    return createWorkbench({ dataDirectory });
  })().catch((error: unknown) => {
    workbench = null;
    throw error;
  });
  return workbench;
}

async function createHttp() {
  const { createWorkbenchHttp } =
    await import("../../../packages/review-workbench/src/http.js");
  return createWorkbenchHttp(await getWorkbench(), {
    onError: (error) =>
      logger.error({ err: error }, "workbench request failed"),
  });
}

let http: ReturnType<typeof createHttp> | null = null;

/** 已通过认证后才建立工作台，健康检查不依赖它的磁盘数据可用性。 */
export async function handleWorkbench(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<boolean> {
  http ??= createHttp().catch((error: unknown) => {
    http = null;
    throw error;
  });
  const handle = await http;
  response.setHeader("x-request-id", requestId);
  return handle(request, response, await workbenchActor(request));
}

/** 工作台与自动化共用 actor 适配，Bearer、会话及仓库 manage/view 判断只有一个来源。 */
export async function workbenchActor(
  request: IncomingMessage,
): Promise<Actor & { isReadOnly: boolean }> {
  const isAdmin = await isAdminRequest(request);
  const isReadOnly = await isReadOnlyRequest(request);
  return {
    userId: sessionLogin(request) ?? "bearer",
    isAdmin,
    isReadOnly,
    canAccessRepository: async (repository: string, write: boolean) => {
      if (write && isReadOnly) return false;
      if (isAdmin) return true;
      const [owner, name] = repository.split("/");
      if (!UUID_PATTERN.test(repository) && (!owner || !name)) return false;
      const [row] = await database.db
        .select({ id: repositories.id })
        .from(repositories)
        .where(
          UUID_PATTERN.test(repository)
            ? eq(repositories.id, repository)
            : and(
                sql`lower(${repositories.owner}) = ${owner!.toLowerCase()}`,
                sql`lower(${repositories.name}) = ${name!.toLowerCase()}`,
              ),
        )
        .limit(1);
      return row
        ? canAccessRepo(request, row.id, write ? "manage" : "view")
        : false;
    },
  };
}
