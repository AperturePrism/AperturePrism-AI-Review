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
let checkRunSweep: Promise<void> | undefined;

function checkRunTick(): void {
  if (checkRunSweep) return;
  checkRunSweep = (async () => {
    const github = await githubProvider.get();
    if (!github || shutdown.signal.aborted) return;
    const finalized = await reconcileCheckRuns({
      db: database.db,
      github,
      signal: shutdown.signal,
      onError: (error, publicationId) =>
        logger.warn(
          { err: error, publicationId },
          "Check Run completion pending; will retry",
        ),
    });
    if (finalized > 0)
      logger.info({ finalized }, "Check Run reconciliation sweep");
  })()
    .catch((error: unknown) => {
      logger.warn({ err: error }, "Check Run reconciliation sweep failed");
    })
    .finally(() => {
      checkRunSweep = undefined;
    });
}

/** How often lease recovery and retry-release sweep runs. */
const SWEEP_INTERVAL_MS = 10_000;
/** How often the memory-consolidation agent merges pending reflections. */
const CONSOLIDATION_INTERVAL_MS = 10 * 60 * 1_000;

/** Runs one maintenance sweep over the task table. */
async function sweep(): Promise<void> {
  const [recovered, released] = await Promise.all([
    recoverExpiredLeases(database.db).catch((error: unknown) => {
      logger.warn({ err: error }, "lease recovery sweep failed");
      return 0;
    }),
    releaseDueRetries(database.db).catch((error: unknown) => {
      logger.warn({ err: error }, "retry release sweep failed");
      return 0;
    }),
  ]);
  if (recovered > 0 || released > 0) {
    logger.info({ recovered, released }, "task maintenance sweep");
  }
}

/**
 * Runs one memory-consolidation pass. Fire-and-forget from the caller so a
 * slow model call never blocks lease recovery; failures are logged inside.
 */
async function consolidationTick(): Promise<void> {
  const result = await memoryConsolidationSweep(database, logger).catch(
    (error: unknown) => {
      logger.warn({ err: error }, "memory consolidation sweep failed");
      return null;
    },
  );
  if (result && (result.repositories > 0 || result.rules > 0)) {
    logger.info(result, "memory consolidation sweep");
  }
}

async function loop(): Promise<void> {
  logger.info({ workerId }, "scheduler starting");
  await sweep();
  checkRunTick();
  void consolidationTick();
  let lastConsolidation = Date.now();
  while (!shutdown.signal.aborted) {
    await sleep(SWEEP_INTERVAL_MS, shutdown.signal);
    if (shutdown.signal.aborted) break;
    await sweep();
    checkRunTick();
    if (Date.now() - lastConsolidation >= CONSOLIDATION_INTERVAL_MS) {
      lastConsolidation = Date.now();
      void consolidationTick();
    }
  }
  await checkRunSweep;
  await database.close();
  logger.info({ workerId }, "scheduler stopped");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
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
