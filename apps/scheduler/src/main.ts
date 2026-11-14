/**
 * 调度入口：登记四个明确的维护动作，再等待停止信号。
 * 各动作的并发、防重叠和运行快照由 maintenance.ts 统一保管。
 * 运行：node apps/scheduler/dist/apps/scheduler/src/main.js
 */
import { hostname } from "node:os";
import {
  createCredentialCipher,
  loadConfig,
} from "../../../packages/config/src/index.js";
import {
  createDatabaseClient,
  createGithubAppProvider,
  resolveGithubAppCredentials,
} from "../../../packages/database/src/index.js";
import { createGitHubClient } from "../../../packages/github-adapter/src/index.js";
import { createLogger } from "../../../packages/observability/src/index.js";
import {
  recoverExpiredLeases,
  releaseDueRetries,
} from "../../../packages/task-engine/src/index.js";
import { reconcileCheckRuns } from "./check-runs.js";
import { memoryConsolidationSweep } from "./consolidation.js";
import {
  createMaintenance,
  maintenanceHealth,
  waitForMaintenance,
} from "./maintenance.js";
import { loadTaskRuntimePolicy } from "../../../packages/task-engine/src/runtime-policy.js";

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);
const database = createDatabaseClient(config.databaseUrl);
const workerId = `${hostname()}:${process.pid}`;
const shutdown = new AbortController();
const githubProvider = createGithubAppProvider({
  logger,
  resolve: () =>
    resolveGithubAppCredentials(database.db, {
      opener: config.credentialMasterKey
        ? createCredentialCipher(config.credentialMasterKey)
        : null,
      env: {
        appId: config.githubAppId,
        privateKeyPath: config.githubAppPrivateKeyPath,
      },
    }),
  createClient: (credentials) =>
    createGitHubClient({
      appId: credentials.appId,
      privateKeyPem: credentials.privateKeyPem,
      ...(config.githubApiBaseUrl
        ? { apiBaseUrl: config.githubApiBaseUrl }
        : {}),
    }),
});
// 启动时校验可选队列与重试配置，拼错字段不等到领取时才暴露。
loadTaskRuntimePolicy();

const maintenance = createMaintenance({
  jobs: [
    {
      name: "lease-recovery",
      intervalMs: 10_000,
      run: () => recoverExpiredLeases(database.db),
    },
    {
      name: "retry-release",
      intervalMs: 10_000,
      run: () => releaseDueRetries(database.db),
    },
    {
      name: "check-runs",
      intervalMs: 10_000,
      run: async (signal) => {
        const github = await githubProvider.get();
        if (!github || signal.aborted) return 0;
        return reconcileCheckRuns({
          db: database.db,
          github,
          signal,
          onError: (error, publicationId) =>
            logger.warn(
              { err: error, publicationId },
              "Check Run completion pending; will retry",
            ),
        });
      },
    },
    {
      name: "memory-consolidation",
      intervalMs: 10 * 60_000,
      run: (signal) => memoryConsolidationSweep(database, logger, { signal }),
    },
  ],
  onEvent(event) {
    if (event.type === "failed")
      logger.warn(
        { err: event.error, job: event.name, durationMs: event.durationMs },
        "maintenance job failed",
      );
    if (event.type === "completed" && event.result)
      logger.info(
        { job: event.name, result: event.result, durationMs: event.durationMs },
        "maintenance job completed",
      );
  },
});

async function loop(): Promise<void> {
  logger.info({ workerId }, "scheduler starting");
  let lastHealth = Date.now();
  try {
    while (!shutdown.signal.aborted) {
      await maintenance.tick();
      if (Date.now() - lastHealth >= 60_000) {
        lastHealth = Date.now();
        const states = maintenance.snapshot();
        logger.info(
          { workerId, ...maintenanceHealth(states), jobs: states },
          "scheduler health",
        );
      }
      await waitForMaintenance(1_000, shutdown.signal);
    }
  } finally {
    await maintenance.stop(); // 等待正在运行的维护结束，再关闭共用数据库连接。
    await database.close();
  }
  logger.info({ workerId }, "scheduler stopped");
}

function requestShutdown(signal: string): void {
  logger.info({ signal, workerId }, "shutting down");
  shutdown.abort();
}

process.once("SIGINT", () => requestShutdown("SIGINT"));
process.once("SIGTERM", () => requestShutdown("SIGTERM"));

void loop().catch((error: unknown) => {
  logger.error({ err: error }, "scheduler failed");
  process.exitCode = 1;
});
