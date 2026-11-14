/**
 * 分析入口：创建Issue/PR工作流，驱动租约循环和持久outbox交付。
 * 调用示例：node dist/apps/analysis-worker/src/main.js。
 * 仅拆分内部实现；任务与数据契约保持兼容，依赖在下方显式列出。
 */
import { and, eq, like } from "drizzle-orm";
import { createCredentialCipher } from "../../../packages/config/src/index.js";
import {
  createGithubAppProvider,
  providerAccounts,
  resolveGithubAppCredentials,
  systemSettings,
} from "../../../packages/database/src/index.js";
import {
  ModelInvocationError,
  type ModelProviderAdapter,
} from "../../../packages/domain/src/index.js";
import { createGitHubClient } from "../../../packages/github-adapter/src/index.js";
import { createOpenAICompatibleAdapter } from "../../../packages/model-router/src/index.js";
import { withCorrelation } from "../../../packages/observability/src/index.js";
import { type TaskHandler, runWorkerLoop } from "./loop.js";
import { isExpertTeamEnabled, loadCandidates } from "./models.js";
import {
  config,
  database,
  heartbeatIntervalMs,
  idleDelayMs,
  logger,
  reviewWorkbench,
  reviewAutomation,
  shutdown,
  workerId,
} from "./runtime.js";
import { engine } from "./task.js";
import { replayReviewWorkbenchSync } from "./workbench.js";
import { createIssueWorkflow } from "./issue.js";
import { createPullRequestWorkflow } from "./pull-request.js";
import { createWorkbenchBatchDispatcher } from "./batch.js";

async function main(): Promise<void> {
  logger.info({ workerId }, "analysis worker starting");

  // GitHub App 凭据优先取 WebUI 保存到数据库的那份，env 兜底；换 App 不必重启。
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
  // 首次解析：拿到初始客户端，同时把「未配置」尽早记进日志。
  await githubProvider.get();

  const cipher = config.credentialMasterKey
    ? createCredentialCipher(config.credentialMasterKey)
    : null;
  const resolveApiKey = async (
    provider: string,
    accountName: string,
  ): Promise<string> => {
    if (!cipher)
      throw new ModelInvocationError(
        "authentication_failed",
        "provider credentials are not configured",
      );
    const rows = await database.db
      .select({ encryptedCredential: providerAccounts.encryptedCredential })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.provider, provider),
          eq(providerAccounts.name, accountName),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row)
      throw new ModelInvocationError(
        "authentication_failed",
        `no provider credential for account ${accountName}`,
      );
    return cipher.open(row.encryptedCredential);
  };

  const adapters = new Map<string, ModelProviderAdapter>();
  // 环境变量提供初始基址，WebUI 里保存的 provider 基址覆盖同名项 ——
  // 否则界面新增的 provider 没有 adapter，路由会判为 model_not_found。
  const baseUrls = new Map<string, string>(
    Object.entries(config.modelProviderBaseUrls),
  );
  try {
    const rows = await database.db
      .select({ key: systemSettings.key, value: systemSettings.value })
      .from(systemSettings)
      .where(like(systemSettings.key, "model_provider_base_url:%"));
    for (const row of rows) {
      const provider = row.key.slice("model_provider_base_url:".length);
      if (provider && row.value.trim())
        baseUrls.set(provider, row.value.trim());
    }
  } catch (error) {
    logger.warn(
      { err: error },
      "runtime provider base urls unavailable; using environment only",
    );
  }
  for (const [provider, baseUrl] of baseUrls) {
    adapters.set(
      provider,
      createOpenAICompatibleAdapter({
        provider,
        baseUrl,
        resolveApiKey: (accountName) => resolveApiKey(provider, accountName),
      }),
    );
  }

  const issueCandidates = await loadCandidates("issue_analysis");
  if (issueCandidates.length === 0)
    logger.warn(
      "no issue_analysis model candidates configured in the database",
    );
  // 图片多模态专用候选：仅当某 Issue 携带图片时使用（视觉模型），纯文本走
  // issueCandidates。未配置时回退到 issueCandidates（保持可用）。
  const issueVisionCandidates = await loadCandidates("issue_analysis_vision");
  // Ad/spam detection uses its own role when configured, else issue_analysis.
  const spamCandidates = await loadCandidates("spam_detection");
  const reviewCandidates = await loadCandidates("pr_review");
  if (reviewCandidates.length === 0)
    logger.warn("no pr_review model candidates configured in the database");
  const expertTeamEnabled = await isExpertTeamEnabled(database);
  const expertReviewCandidates = expertTeamEnabled
    ? await loadCandidates("expert_review")
    : [];
  if (adapters.size === 0)
    logger.warn("MODEL_PROVIDER_BASE_URLS is empty; model calls will fail");

  logger.info(
    {
      expertTeamEnabled,
      expertCandidates: expertReviewCandidates.length,
      reviewCandidates: reviewCandidates.length,
    },
    "agent expert team status",
  );

  const handler: TaskHandler = async (task, signal, execution) => {
    // 每个任务开始前刷新一次凭据：用户在 WebUI 换了 GitHub App 之后，worker
    // 不该必须重启才认新凭据。指纹未变时这只是一次轻量查询。
    const github = await githubProvider.get();
    if (task.taskType === "pr_review")
      return createPullRequestWorkflow({
        github,
        adapters,
        expertTeamEnabled,
        expertReviewCandidates,
        reviewCandidates,
      })(task, signal, execution);
    return createIssueWorkflow({
      github,
      adapters,
      issueCandidates,
      issueVisionCandidates,
      spamCandidates,
    })(task, signal, execution);
  };

  const batchDispatcher = createWorkbenchBatchDispatcher({
    workbench: reviewWorkbench,
    taskDb: database.db,
    githubProvider,
    workerId,
    signal: shutdown.signal,
    onError: (error) =>
      logger.warn({ err: error }, "workbench batch dispatch deferred"),
  });
  let replayRunning: Promise<unknown> | null = null;
  const replay = () => {
    if (replayRunning || shutdown.signal.aborted) return;
    replayRunning = Promise.all([
      batchDispatcher.tick(),
      replayReviewWorkbenchSync(database.sql, reviewWorkbench, {
        automation: reviewAutomation,
        signal: shutdown.signal,
        onError: (error) =>
          logger.warn({ err: error }, "review workbench sync deferred"),
      }),
    ])
      .catch((error: unknown) =>
        logger.warn({ err: error }, "workbench maintenance unavailable"),
      )
      .finally(() => {
        replayRunning = null;
      });
  };
  replay();
  const replayTimer = setInterval(replay, 5_000);
  replayTimer.unref();
  try {
    await runWorkerLoop({
      engine,
      handler,
      heartbeatIntervalMs,
      idleDelayMs,
      shutdownSignal: shutdown.signal,
      onEvent: (event) => {
        if (event.type === "idle") return;
        const taskLogger =
          "taskId" in event
            ? withCorrelation(logger, { taskId: event.taskId })
            : logger;
        if (event.type === "failed") {
          // A failed attempt must leave a diagnosable trace: log the surfaced
          // error (already sanitized/truncated by the loop) at error level.
          taskLogger.error(
            {
              event: event.type,
              errorCategory: event.errorCategory,
              error: event.error,
            },
            "worker event failed",
          );
          return;
        }
        taskLogger.info({ event: event.type }, "worker event");
      },
    });
  } finally {
    clearInterval(replayTimer);
    await replayRunning;
    await batchDispatcher.stop();
    await database.close();
  }
  logger.info({ workerId }, "analysis worker stopped");
}

function requestShutdown(signal: string): void {
  logger.info({ signal, workerId }, "shutting down");
  shutdown.abort();
}

process.once("SIGINT", () => requestShutdown("SIGINT"));

process.once("SIGTERM", () => requestShutdown("SIGTERM"));

void main().catch((error: unknown) => {
  logger.error({ err: error }, "analysis worker failed");
  process.exitCode = 1;
});
