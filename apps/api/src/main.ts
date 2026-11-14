/**
 * HTTP 入口：来源限额 → 身份与权限 → 主体指令 → 统一错误回复。
 * 启动：node dist/apps/api/src/main.js。
 * 加业务接口只需在 commands/ 放一个导出 routes 的文件，入口不维护业务路径表。
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { closeRedisClient } from "../../../packages/database/src/index.js";
import {
  metrics,
  startTimer,
  withCorrelation,
} from "../../../packages/observability/src/index.js";
import { refreshAlerts } from "./commands/metrics.js";
import {
  syncInstallations,
  REPOSITORY_SYNC_INTERVAL_MS,
} from "./commands/repositories.js";
import { startEventStream, stopEventStream } from "./events.js";
import { isAuthorized, isReadOnlyRequest, isAdminRequest } from "./identity.js";
import {
  authenticationReady,
  startRuntimeSettings,
  stopRuntimeSettings,
} from "./preferences.js";
import { config, database, logger, redis } from "./runtime.js";
import { clientIp, HttpError, json, requestIdOf } from "./utils/http.js";
import { rateLimited } from "./utils/rate-limit.js";
import {
  dispatch,
  discoveryRoutes,
  orderRoutes,
  loadRoutes,
  type HttpRoute,
} from "./utils/routes.js";

/** 只有登录、引导状态、健康探针和签名 webhook 可在登录前访问。 */
const publicPaths = new Set([
  "/health/live",
  "/health/ready",
  "/github/webhook",
  "/auth/status",
  "/auth/login",
  "/auth/callback",
  "/auth/register",
  "/setup/status",
]);

let routes: readonly HttpRoute[] = [];
let repositorySyncTimer: ReturnType<typeof setInterval> | null = null;
let alertTimer: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;

/** 统一请求边界：校验一次外部输入，主体指令只处理自己的业务。 */
async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestId = requestIdOf(request);
  const requestLogger = withCorrelation(logger, { requestId });
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const ip = clientIp(request);
  const isPublic = publicPaths.has(path);
  const known = routes.some((route) => {
    if (route.path instanceof RegExp) {
      route.path.lastIndex = 0;
      return route.path.test(path);
    }
    return (
      route.path === path || (route.prefix && path.startsWith(`${route.path}/`))
    );
  });
  if (!known) {
    json(
      response,
      request.method === "GET" ? 404 : 405,
      {
        status: "error",
        reason: request.method === "GET" ? "not found" : "method not allowed",
      },
      requestId,
    );
    return;
  }
  if (!isPublic && !authenticationReady()) {
    json(
      response,
      503,
      { status: "error", reason: "authentication_not_ready" },
      requestId,
    );
    return;
  }
  const webhook = path === "/github/webhook";
  const limit = webhook ? config.webhookRateLimit : config.apiRateLimit;
  if (
    (!isPublic || webhook) &&
    rateLimited(`${webhook ? "webhook" : "api"}:${ip}`, limit, Date.now())
  ) {
    response.setHeader("retry-after", "60");
    json(response, 429, { status: "error", reason: "rate_limited" }, requestId);
    requestLogger.warn({ ip, path }, "request rate limited");
    return;
  }
  if (!isPublic && !(await isAuthorized(request))) {
    json(response, 401, { status: "error", reason: "unauthorized" }, requestId);
    return;
  }
  const personal =
    path === "/auth/me" ||
    path === "/auth/logout" ||
    path === "/auth/password" ||
    path === "/auth/sessions" ||
    path.startsWith("/auth/sessions/");
  if (
    !isPublic &&
    !personal &&
    path !== "/api/automation" &&
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    path !== "/auth/me" &&
    (await isReadOnlyRequest(request))
  ) {
    json(
      response,
      403,
      { status: "error", reason: "read_only_operator" },
      requestId,
    );
    requestLogger.warn(
      { path, method: request.method },
      "read-only operator write denied",
    );
    return;
  }

  if (
    await dispatch(routes, request, response, requestId, {
      isAdmin: () => isAdminRequest(request),
    })
  )
    return;
  json(
    response,
    request.method === "GET" ? 404 : 405,
    {
      status: "error",
      reason: request.method === "GET" ? "not found" : "method not allowed",
    },
    requestId,
  );
  requestLogger.debug({ path }, "request not found");
}

const server = createServer((request, response) => {
  metrics.increment("http.requests");
  const timer = startTimer();
  response.once("finish", () => {
    metrics.recordDuration("http.request_ms", timer());
    if (response.statusCode >= 500) metrics.increment("http.errors_5xx");
  });
  void handleRequest(request, response).catch((error: unknown) => {
    const requestId = requestIdOf(request);
    const status = error instanceof HttpError ? error.status : 500;
    const reason =
      error instanceof HttpError ? error.message : "internal server error";
    if (status >= 500)
      logger.error({ err: error, requestId }, "request failed");
    if (!response.headersSent)
      json(response, status, { status: "error", reason }, requestId);
    else response.destroy();
  });
});
server.requestTimeout = 60_000; // 限制慢速上传占住连接的时间。
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;

/** 停止接收新请求，再关闭事件流和共享连接；重复信号只关闭一次。 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  stopRuntimeSettings();
  if (repositorySyncTimer) clearInterval(repositorySyncTimer);
  if (alertTimer) clearInterval(alertTimer);
  await stopEventStream();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeRedisClient(redis);
  await database.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
void loadRoutes()
  .then(async (loaded) => {
    routes = orderRoutes([
      ...loaded,
      ...discoveryRoutes(() => routes, publicPaths),
    ]);
    await startEventStream();
    await startRuntimeSettings();
    void refreshAlerts();
    alertTimer = setInterval(() => void refreshAlerts(), 60_000);
    server.listen(config.port, config.host, () =>
      logger.info({ host: config.host, port: config.port }, "API listening"),
    );
    repositorySyncTimer = setInterval(() => {
      void syncInstallations()
        .then((result) =>
          logger.info(result, "installation repository sync completed"),
        )
        .catch((error: unknown) =>
          logger.warn({ err: error }, "installation repository sync failed"),
        );
    }, REPOSITORY_SYNC_INTERVAL_MS);
  })
  .catch((error: unknown) => {
    logger.error({ err: error }, "failed to start API");
    process.exitCode = 1;
  });

// 既有模块调用方仍可从入口导入这些函数，内部路径拆分不改变外部契约。
export {
  openAiApiRoot,
  openAiModelsEndpoint,
  providerBaseUrlSettingKey,
} from "./commands/providers.js";
