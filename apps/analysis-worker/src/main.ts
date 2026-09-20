import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { and, desc, eq, inArray, like } from "drizzle-orm";
import {
  BOOLEAN_DEFAULTS,
  createCredentialCipher,
  loadConfig,
  parseBool,
  parseSpamHandling,
} from "../../../packages/config/src/index.js";
import {
  createDatabaseClient,
  externalPublications,
  createGithubAppProvider,
  getRepoMemorySummary,
  getRepositorySettingsFor,
  loadSettings,
  labelsForAnalysis,
  listLabelRules,
  syncAppliedLabels,
  modelRolePolicies,
  providerAccounts,
  repositories,
  resolveGithubAppCredentials,
  subjectResults,
  systemSettings,
  writeAuditLog,
  writeRepoMemory,
  type DatabaseClient,
} from "../../../packages/database/src/index.js";
import {
  ModelInvocationError,
  type ModelCandidate,
  type ModelMessage,
  type ModelProviderAdapter,
  type ModelRole,
} from "../../../packages/domain/src/index.js";
import { createGitHubClient, ensureRepoRulesDir, EXAMPLE_RULES_FILE, fetchRepoRules, GitHubApiError } from "../../../packages/github-adapter/src/index.js";
import {
  formatSuggestedTitle,
  type IssueAnalysisResult,
  type ProposedChange,
} from "../../../packages/contracts/src/index.js";
import {
  analyzeIssue,
  buildIssueAnalysisComment,
  buildIssueContext,
  buildFailureComment,
  buildPlaceholderComment,
  CODE_ACCESS_UNKNOWN_PATH,
  collectIssueImages,
  decideReanalysis,
  detectSpamIssue,
  DEFAULT_MIN_CHANGE_RATIO,
  isIssueEditEvent,
  ISSUE_RESULT_SECTIONS,
  issueCommentIdempotencyKey,
  parseIssueResultSections,
  parseIssueTaskPayload,
  parseMinChangeRatio,
  publishIssueComment,
  repositoryOwnerName,
  type IssueContext,
  type IssueResultSection,
  type PublicationStore,
} from "../../../packages/issue-analysis/src/index.js";
import {
  buildPrContext,
  parsePrReviewTaskPayload,
  publishAssessment,
  renderPrContextText,
  renderReviewBody,
  reviewPullRequest,
  type PrReviewContext,
} from "../../../packages/pr-review/src/index.js";
import {
  createOpenAICompatibleAdapter,
  routeModelInvocation,
} from "../../../packages/model-router/src/index.js";
import {
  runExpertReview,
  selectSkills,
} from "../../../packages/agent-capabilities/src/index.js";
import {
  extractIssueSignals,
  getIndexedIssueText,
  judgeDuplicates,
  normalizedIndexText,
  recallCandidatesWithRepos,
  type RelatedIssueRow,
  type SqlTag,
} from "../../../packages/duplicate-detection/src/index.js";
import {
  createLogger,
  withCorrelation,
} from "../../../packages/observability/src/index.js";
import {
  beginPublishing,
  claimTask,
  completeTask,
  failTask,
  heartbeatTask,
  recordAttemptUsage,
  startTask,
} from "../../../packages/task-engine/src/index.js";
import { createIssueAnalysisHandler } from "./handler.js";
import { createPrReviewHandler } from "./pr-review-handler.js";
import {
  runWorkerLoop,
  type TaskEngineOperations,
  type TaskHandler,
} from "./loop.js";

const leaseDurationMs = 60_000;
const heartbeatIntervalMs = 20_000;
const idleDelayMs = 2_000;
const retryDelayMs = 30_000;
/** Shared logical deadline for the main analysis call and the bounded repair.
 *  2026-08 提到 10min：图片多模态（视觉模型）的处理耗时可超 5min。 */
const analysisDeadlineMs = 600_000;
/**
 * 深读（读仓 + 工具循环多轮）单独预算：每轮工具循环携带已读源码的大上下文，
 * reasoning 模型单轮推理可能耗时 1-3 分钟，4 轮 + 主分析在 600s 内跑不完导致
 * `candidate exceeded deadline` 超时（issue #71/#73 深读现场）。给 15 分钟。
 */
const deepAnalysisDeadlineMs = 900_000;
const analysisRetryPolicy = {
  maxAttemptsPerCandidate: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  // The newapi CDN gateway intermittently answers 401 under load; bounded
  // retries let a flaky response recover instead of failing the whole task.
  retryAuthentication: true,
};
const reviewDeadlineMs = 300_000;
const reviewRetryPolicy = analysisRetryPolicy;

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);
const database = createDatabaseClient(config.databaseUrl);
const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const shutdown = new AbortController();

const engine: TaskEngineOperations = {
  claim: () => claimTask(database.db, { workerId, leaseDurationMs }),
  start: (task) => startTask(database.db, { taskId: task.id, workerId }),
  heartbeat: async (task) =>
    (await heartbeatTask(database.db, {
      taskId: task.id,
      workerId,
      leaseDurationMs,
    })) !== null,
  beginPublishing: (task) =>
    beginPublishing(database.db, { taskId: task.id, workerId }),
  complete: (task) => completeTask(database.db, { taskId: task.id, workerId }),
  fail: async (task, errorCategory, errorMessage) => {
    await failTask(database.db, {
      taskId: task.id,
      workerId,
      errorCategory,
      retryDelayMs,
      ...(errorMessage === undefined ? {} : { errorMessage }),
    });
  },
};

/** A model role policy row; `expert_review` is an optional agent-team role. */
type PolicyRole =
  | ModelRole
  | "expert_review"
  | "spam_detection"
  | "issue_analysis_vision";

async function loadCandidates(role: PolicyRole): Promise<ModelCandidate[]> {
  const rows = await database.db
    .select({ candidates: modelRolePolicies.candidates })
    .from(modelRolePolicies)
    .where(eq(modelRolePolicies.role, role))
    .orderBy(desc(modelRolePolicies.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row || !Array.isArray(row.candidates)) return [];
  const candidates: ModelCandidate[] = [];
  for (const entry of row.candidates) {
    if (typeof entry !== "object" || entry === null) continue;
    const value = entry as Record<string, unknown>;
    if (
      typeof value.provider === "string" &&
      typeof value.model === "string" &&
      typeof value.accountName === "string"
    ) {
      candidates.push({
        provider: value.provider,
        model: value.model,
        accountName: value.accountName,
      });
    }
  }
  return candidates;
}

/**
 * Whether the Agent 专家团队 pipeline is active: the `agent_team_enabled`
 * runtime setting must be "true" AND an `expert_review` model role policy with
 * candidates must exist. A database failure degrades to "disabled" rather than
 * breaking the worker.
 */
async function isExpertTeamEnabled(db: DatabaseClient): Promise<boolean> {
  try {
    const [flag, policy] = await Promise.all([
      loadSettings(db.db, ["agent_team_enabled"]),
      db.db
        .select({ candidates: modelRolePolicies.candidates })
        .from(modelRolePolicies)
        .where(eq(modelRolePolicies.role, "expert_review"))
        .orderBy(desc(modelRolePolicies.createdAt))
        .limit(1),
    ]);
    if (
      !parseBool(
        flag.get("agent_team_enabled"),
        BOOLEAN_DEFAULTS.agent_team_enabled ?? false,
      )
    )
      return false;
    const candidates = policy[0]?.candidates;
    return Array.isArray(candidates) && candidates.length > 0;
  } catch (error) {
    logger.warn({ err: error }, "expert team flag check failed; disabled");
    return false;
  }
}

function issueIdentity(task: { payload: unknown }) {
  const payload = parseIssueTaskPayload(task.payload);
  if (!payload) throw new Error("task payload is missing issue identity");
  const identity = repositoryOwnerName(payload.repositoryFullName);
  if (!identity)
    throw new Error(
      `invalid repository name in payload: ${payload.repositoryFullName}`,
    );
  return { payload, identity };
}

/** Looks up the internal repository id for an owner/name pair, if ingested. */
async function resolveRepositoryId(fullName: string): Promise<string | null> {
  const identity = repositoryOwnerName(fullName);
  if (!identity) return null;
  const rows = await database.db
    .select({ id: repositories.id })
    .from(repositories)
    .where(
      and(
        eq(repositories.owner, identity.owner),
        eq(repositories.name, identity.name),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Consolidated repo memory of a repository as reference text, or undefined
 * when the repo is unknown / has no consolidated memory yet. Best-effort: a
 * database failure degrades to "no memory" instead of breaking the analysis.
 */
async function repoMemoryText(fullName: string): Promise<string | undefined> {
  try {
    const repositoryId = await resolveRepositoryId(fullName);
    if (!repositoryId) return undefined;
    const text = await getRepoMemorySummary(database.db, repositoryId);
    return text.length > 0 ? text : undefined;
  } catch (error) {
    logger.warn({ err: error, fullName }, "repo memory backfill skipped");
    return undefined;
  }
}

/**
 * 仓库审核规则是否启用（`repo_rules_enabled`）。仓库级覆盖优先，其次全局，
 * 缺省开启（遵循 BOOLEAN_DEFAULTS.repo_rules_enabled）。读取失败按开启处理。
 */
async function repoRulesEnabled(repositoryFullName: string | null): Promise<boolean> {
  try {
    const settings = await resolveIssueSettings(repositoryFullName, [
      "repo_rules_enabled",
    ]);
    return parseBool(
      settings.get("repo_rules_enabled"),
      BOOLEAN_DEFAULTS.repo_rules_enabled ?? true,
    );
  } catch {
    return true;
  }
}

/**
 * 读取仓库审核规则文本：开关关闭时返回 undefined；开启时先读 `.apertureprism/rules/`
 * 目录，目录不存在则自动创建示例规则文件（best-effort，创建失败不阻断分析）。
 * 目录已有时直接读取真实规则并返回合并文本。
 */
async function loadRepoRules(
  github: ReturnType<typeof createGitHubClient>,
  repoFullName: string,
  input: {
    installationId: string;
    owner: string;
    name: string;
  },
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (github === undefined) return undefined;
  const enabled = await repoRulesEnabled(repoFullName).catch(() => true);
  if (!enabled) return undefined;
  const rules = await fetchRepoRules(
    github,
    {
      installationId: input.installationId,
      owner: input.owner,
      name: input.name,
    },
    signal,
  );
  if (rules !== undefined) return rules;
  // 首次分析：目录不存在 → 自动创建示例规则文件，供维护者参考。
  try {
    const seeded = await ensureRepoRulesDir(github, {
      installationId: input.installationId,
      owner: input.owner,
      name: input.name,
    }, signal);
    if (seeded)
      logger.warn(
        { repo: repoFullName, file: EXAMPLE_RULES_FILE },
        "seeded example review rules on first analysis",
      );
  } catch (error) {
    logger.warn({ err: error, repo: repoFullName }, "seed rules directory skipped");
  }
  return undefined;
}

const publicationStore: PublicationStore = {
  findExternalObjectId: async (idempotencyKey) => {
    const rows = await database.db
      .select({ externalObjectId: externalPublications.externalObjectId })
      .from(externalPublications)
      .where(eq(externalPublications.idempotencyKey, idempotencyKey))
      .limit(1);
    return rows[0]?.externalObjectId ?? null;
  },
  insert: async (input) => {
    await database.db
      .insert(externalPublications)
      .values({
        taskId: input.taskId,
        idempotencyKey: input.idempotencyKey,
        externalObjectId: input.externalObjectId,
        channel: input.channel,
      })
      .onConflictDoNothing({ target: externalPublications.idempotencyKey });
  },
  touch: async (idempotencyKey) => {
    await database.db
      .update(externalPublications)
      .set({ updatedAt: new Date() })
      .where(eq(externalPublications.idempotencyKey, idempotencyKey));
  },
};

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
  let github = await githubProvider.get();

  const cipher = config.credentialMasterKey
    ? createCredentialCipher(config.credentialMasterKey)
    : null;
  const resolveApiKey = async (accountName: string): Promise<string> => {
    if (!cipher)
      throw new ModelInvocationError(
        "authentication_failed",
        "provider credentials are not configured",
      );
    const rows = await database.db
      .select({ encryptedCredential: providerAccounts.encryptedCredential })
      .from(providerAccounts)
      .where(eq(providerAccounts.name, accountName))
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
      if (provider && row.value.trim()) baseUrls.set(provider, row.value.trim());
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
      createOpenAICompatibleAdapter({ provider, baseUrl, resolveApiKey }),
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

  const issueHandler = createIssueAnalysisHandler({
    buildContext: async (task, signal) => {
      if (!github) throw new Error("GitHub App is not configured");
      const { payload, identity } = issueIdentity(task);
      const [context, repoMemory, repoRules] = await Promise.all([
        buildIssueContext(
          github,
          {
            installationId: payload.installationId,
            owner: identity.owner,
            name: identity.name,
            number: payload.subjectNumber,
          },
          undefined,
          signal,
        ),
        repoMemoryText(payload.repositoryFullName),
        loadRepoRules(
          github,
          payload.repositoryFullName,
          {
            installationId: payload.installationId,
            owner: identity.owner,
            name: identity.name,
          },
          signal,
        ),
      ]);
      return {
        ...context,
        ...(repoMemory ? { repoMemory } : {}),
        ...(repoRules ? { repoRules } : {}),
      };
    },

    shouldReanalyze: (task, context) => shouldReanalyzeIssue(task, context),

    publishPlaceholder: async (task) => {
      const { payload, identity } = issueIdentity(task);
      await publishIssueComment({
        store: publicationStore,
        github: assertGithub(github),
        taskId: task.id,
        installationId: payload.installationId,
        owner: identity.owner,
        name: identity.name,
        issueNumber: payload.subjectNumber,
        idempotencyKey: issueCommentIdempotencyKey(
          payload.repositoryFullName,
          payload.subjectNumber,
        ),
        body: buildPlaceholderComment(),
      });
    },

    // 用同一幂等键原位改写占位评论，不新增评论。
    publishFailure: async (task, errorCategory) => {
      const { payload, identity } = issueIdentity(task);
      await publishIssueComment({
        store: publicationStore,
        github: assertGithub(github),
        taskId: task.id,
        installationId: payload.installationId,
        owner: identity.owner,
        name: identity.name,
        issueNumber: payload.subjectNumber,
        idempotencyKey: issueCommentIdempotencyKey(
          payload.repositoryFullName,
          payload.subjectNumber,
        ),
        body: buildFailureComment(errorCategory),
      });
    },

    analyze: async (context: IssueContext, signal) => {
      const repositoryFullName = `${context.repository.owner}/${context.repository.name}`;
      // 深度分析（读取仓库源码）默认关闭：会显著增加 token 消耗与耗时。
      const deep = await issueDeepAnalysisEnabled(repositoryFullName);
      // 决策留痕：tools 是否注入取决于 deep && (defect|feature|codeRef)，任一不成立
      // 都会导致模型读不到仓库（无 read_file/list_directory），深读挑错静默失效。
      // codeRef：deep 已开启且内容引用具体源码文件/扩展名时兜底读仓（#70），
      // 不依赖标题类型前缀或标签时序。
      const defect = isDefectIssue(context);
      const feature = isFeatureRequest(context);
      const codeRef = CODE_REFERENCE_HINT.test(
        `${context.issue.title ?? ""}\n${context.issue.body ?? ""}`,
      );
      const shouldReadRepo = defect || feature || (deep && codeRef);
      logger.info(
        {
          repo: repositoryFullName,
          subject: context.issue.number,
          deep,
          defect,
          feature,
          codeRef,
          toolsInjected: deep && shouldReadRepo,
        },
        "issue deep decision: tools injection",
      );
      // 方案B：审查/缺陷类及功能请求类主动预读被点名目标文件并注入上下文，保证模型无论是否
      // 调用工具都能看到源码（deepseek 的 function-calling 不稳定）。tools 仍保留。
      if (deep && shouldReadRepo) {
        try {
          const preload = await preloadTargetFiles(
            assertGithub(github),
            context,
            // 内容级检索：#62 方案2。仅当路径打分未命中（中文语义）时，由模型从
            // 仓库候选清单挑最相关源码，覆盖纯中文 enhancement 场景。
            async (candidatePaths, ctx) => {
              logger.info(
                {
                  repo: repositoryFullName,
                  subject: ctx.issue.number,
                  candidatePaths: candidatePaths.length,
                },
                "content retrieval: model file picker start",
              );
              const res = await routeModelInvocation(adapters, {
                candidates: issueCandidates,
                request: buildFilePickRequest(ctx, candidatePaths),
                deadlineMs: Math.min(analysisDeadlineMs, 30_000),
                retryPolicy: analysisRetryPolicy,
                ...(signal === undefined ? {} : { signal }),
              });
              const picked = parseFilePicks(res.response.content, candidatePaths);
              logger.info(
                {
                  repo: repositoryFullName,
                  subject: ctx.issue.number,
                  response: res.response.content.slice(0, 300),
                  picked,
                },
                "content retrieval: model picked files",
              );
              return picked;
            },
          );
          if (preload.length > 0) {
            context = { ...context, preloadedFiles: preload };
            logger.info(
              {
                repo: repositoryFullName,
                subject: context.issue.number,
                files: preload.map((f) => f.path),
              },
              "issue preload: target files injected",
            );
          }
        } catch (error) {
          logger.warn(
            { err: error, repo: repositoryFullName },
            "issue target file preload failed",
          );
        }
      }
      const promptVersion = await resolveIssuePromptVersion();
      const promptMode = await resolveIssuePromptMode();
      const issueSections = await resolveIssueSections(repositoryFullName);
      // 图片多模态：开启时下载 Issue 正文/评论里的图片并入上下文；任何图片失败
      // 都降级（记入 degraded）而非失败，文本分析总能继续（#545 Phase 1）。
      let ctx = context;
      if (await issueVisionEnabled(repositoryFullName)) {
        const collected = await collectIssueImages(context);
        logger.info(
          {
            repo: repositoryFullName,
            subject: context.issue.number,
            imagesCollected: collected.images.length,
            imagesDegraded: collected.degraded.length,
          },
          "issue vision: collected images attached to analysis request",
        );
        ctx = {
          ...context,
          images: collected.images,
          degraded: [...context.degraded, ...collected.degraded],
        };
      }
      // 文本 / 图片(多模态) 模型分流：携带图片时用 issue_analysis_vision 角色
      // （视觉模型），否则用 issue_analysis（快模型）。视觉角色未配置时回退到
      // issue_analysis，避免带图的文本分析也能跑。
      const useVisionModel = ctx.images.length > 0 && issueVisionCandidates.length > 0;
      if (useVisionModel)
        logger.info(
          { repo: repositoryFullName, subject: context.issue.number },
          "issue vision: routing to vision model candidates",
        );
      // 分析选项按候选模型参数化：视觉失败时复用同一套配置，仅换文本模型候选。
      // capDeadlineMs 允许分阶段限制时间——视觉阶段给短 budget，失败后把剩余时间留给文本。
      const buildAnalysisOptions = (
        candidates: ModelCandidate[],
        capDeadlineMs: number,
      ) => ({
        adapters,
        candidates,
        deadlineMs: capDeadlineMs,
        retryPolicy: analysisRetryPolicy,
        signal,
        // exactOptionalPropertyTypes：undefined 不能显式赋给可选属性，条件展开。
        ...(promptVersion === undefined ? {} : { promptVersion }),
        ...(promptMode === undefined ? {} : { promptMode }),
        ...(issueSections.sections === undefined
          ? {}
          : { sections: issueSections.sections }),
        ...(issueSections.sectionsByCategory.bug === undefined &&
        issueSections.sectionsByCategory.feature === undefined
          ? {}
          : {
              sectionsByCategory: {
                ...(issueSections.sectionsByCategory.bug === undefined
                  ? {}
                  : { bug: issueSections.sectionsByCategory.bug }),
                ...(issueSections.sectionsByCategory.feature === undefined
                  ? {}
                  : { feature: issueSections.sectionsByCategory.feature }),
              },
            }),
        // 缺陷类与功能请求类开启读仓定位（deep 由 issue_deep_analysis 开关控制）；
        // 开启后额外注入强制读仓，防止模型跳过工具直接以"无代码访问能力"逃避。
        ...(deep && shouldReadRepo
          ? {
              tools: {
                context: {
                  client: assertGithub(github),
                  installationId: context.installationId,
                  owner: context.repository.owner,
                  name: context.repository.name,
                  // 默认分支：Issue 不像 PR 那样绑定某个 commit。
                  ref: "HEAD",
                },
                maxRounds: 4,
                forceToolUse: true,
              },
            }
          : {}),
      });
      // 视觉模型优先；若视觉模型服务不可用导致分析失败，回退到文本模型重跑一次
      // （丢弃图片，保证带图 Issue 也能出分析，不因图片理解失败而整条失败）。
      if (useVisionModel) {
        // 视觉阶段用较短 budget：视觉模型不可用时快速失败，把剩余时间留给文本兜底。
        try {
          return await analyzeIssue(
            buildAnalysisOptions(
              issueVisionCandidates,
              Math.min(analysisDeadlineMs, 60_000),
            ),
            ctx,
          );
        } catch (error) {
          logger.warn(
            { err: error, repo: repositoryFullName, subject: context.issue.number },
            "issue vision: vision model failed, falling back to text analysis",
          );
          const fallback = await analyzeIssue(
            buildAnalysisOptions(issueCandidates, analysisDeadlineMs),
            { ...ctx, images: [] },
          );
          // 显示层标记：仅当文本分析产出有效结果时标注「视觉未参与」。
          if (fallback.outcome === "valid") {
            (
              fallback.analysis.result as IssueAnalysisResult & {
                _visionSkipped?: boolean;
              }
            )._visionSkipped = true;
          }
          return fallback;
        }
      }
      // 深读（读仓+工具循环）单独给更大 deadline，避免大上下文多轮推理超时。
      const deadlineMs =
        deep && shouldReadRepo ? deepAnalysisDeadlineMs : analysisDeadlineMs;
      return analyzeIssue(buildAnalysisOptions(issueCandidates, deadlineMs), ctx);
    },

    recallRelated: async (context) => {
      let recalled: RelatedIssueRow[] = [];
      try {
        recalled = await recallCandidatesWithRepos(
          database.sql as unknown as SqlTag,
          {
            title: context.issue.title,
            body: context.issue.body,
            signals: extractIssueSignals({
              title: context.issue.title,
              body: context.issue.body,
              labels: context.issue.labels,
            }),
            topK: 5,
            // 只在同一仓库内召回历史 Issue，避免把其他项目的 Issue 当作“相关”。
            repository: context.repository,
            // 当前 Issue 在召回前已入库，不排除会把自己列为最相关项。
            excludeIssueNumber: context.issue.number,
          },
        );
      } catch (error) {
        logger.warn({ err: error }, "related-issue recall skipped");
        return [];
      }
      if (recalled.length === 0) return [];

      // 让模型裁决召回候选，只保留确认相关/重复的，避免「文本相似但实际无关」
      // 的误关联（曾把提示词注入测试与获取模型失败这两个无关 issue 列在一起）。
      // 裁决失败或模型判定无关时一律不列出，而不是退回原始召回。
      try {
        const outcome = await judgeDuplicates(
          {
            adapters,
            candidates: issueCandidates,
            deadlineMs: analysisDeadlineMs,
            retryPolicy: analysisRetryPolicy,
          },
          {
            lead: {
              issueNumber: context.issue.number,
              title: context.issue.title,
              body: context.issue.body,
            },
            candidates: recalled.map((row) => ({
              issueNumber: row.issueNumber,
              title: row.title,
              body: row.body,
            })),
          },
        );
        if (outcome.outcome !== "valid") return [];
        if (
          outcome.judgment.decision === "not_duplicate" ||
          outcome.judgment.decision === "insufficient_evidence"
        )
          return [];
        const confirmed = new Set(outcome.judgment.relatedIssues);
        return recalled.filter((row) => confirmed.has(row.issueNumber));
      } catch (error) {
        logger.warn(
          { err: error },
          "related-issue adjudication failed; listing none",
        );
        return [];
      }
    },

    publishFinal: async (task, analysis, related) => {
      const { payload, identity } = issueIdentity(task);
      // #50：先做自动指派，并把「建议指派人」对齐到实际指派，再发布评论，
      // 避免模型输出的个人猜测与真实自动指派不一致。
      let assignedAssignees: string[] = [];
      try {
        assignedAssignees = await applyIssueEnhancements({
          github: assertGithub(github),
          installationId: payload.installationId,
          owner: identity.owner,
          name: identity.name,
          issueNumber: payload.subjectNumber,
          analysis: analysis.result,
        });
      } catch (error) {
        logger.warn({ err: error, taskId: task.id }, "issue enhancement skipped");
      }
      // #53：自动指派可多人，全部写回 suggestedAssignee（逗号分隔），
      // 评论与结果页逐个 @，不再只体现第一个。
      if (assignedAssignees.length > 0) {
        analysis.result.suggestedAssignee = assignedAssignees.join(", ");
      }
      // #57：发布前校验 proposedChanges.path 真实存在，移除编造的文件/文件夹路径。
      if ((analysis.result.proposedChanges ?? []).length > 0) {
        try {
          const verified = await verifyProposedChangePaths({
            reader: assertGithub(github),
            installationId: payload.installationId,
            owner: identity.owner,
            name: identity.name,
            changes: analysis.result.proposedChanges,
          });
          if (verified.length !== analysis.result.proposedChanges.length) {
            logger.warn(
              {
                repo: payload.repositoryFullName,
                subject: payload.subjectNumber,
                before: analysis.result.proposedChanges.length,
                after: verified.length,
              },
              "proposed change paths verified: dropped hallucinated paths",
            );
          }
          analysis.result.proposedChanges = verified;
        } catch (error) {
          // 校验整体失败（罕见）不阻断发布，保留原建议。
          logger.warn(
            { err: error, taskId: task.id },
            "proposed change path verification skipped",
          );
        }
      }
      await publishIssueComment({
        store: publicationStore,
        github: assertGithub(github),
        taskId: task.id,
        installationId: payload.installationId,
        owner: identity.owner,
        name: identity.name,
        issueNumber: payload.subjectNumber,
        idempotencyKey: issueCommentIdempotencyKey(
          payload.repositoryFullName,
          payload.subjectNumber,
        ),
        body: buildIssueAnalysisComment(analysis, related),
      });
      await persistSubjectResult({
        taskId: task.id,
        subjectType: "issue",
        subjectNumber: payload.subjectNumber,
        repositoryFullName: payload.repositoryFullName,
        revision: payload.subjectRevision,
        result:
          related.length > 0
            ? { ...analysis, related }
            : analysis,
      });
      // Apply configured label rules to the issue (best-effort, idempotent).
      await applyConfiguredLabels({
        github: assertGithub(github),
        installationId: payload.installationId,
        owner: identity.owner,
        name: identity.name,
        issueNumber: payload.subjectNumber,
        analysis: analysis.result,
      }).catch((error: unknown) =>
        logger.warn({ err: error, taskId: task.id }, "label application skipped"),
      );
    },

    recordUsage: async (task, outcome) => {
      const lastAttempt = outcome.attempts.at(-1);
      await recordAttemptUsage(database.db, {
        taskId: task.id,
        workerId,
        attemptNumber: task.attemptNumber,
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        durationMs: outcome.durationMs,
        provider: lastAttempt?.candidate.provider ?? "",
        model: lastAttempt?.candidate.model ?? "",
      });
    },

    recordMemory: async (task, analysis) => {
      try {
        const { payload } = issueIdentity(task);
        const repositoryId = await resolveRepositoryId(
          payload.repositoryFullName,
        );
        const result = analysis.result;
        const evidence = result.evidence
          .map((entry) => `[${entry.kind}] ${entry.excerpt}`)
          .join("\n");
        const content = [
          `摘要：${result.summary}`,
          `类别：${result.category}；严重度：${result.severity}；优先级：${result.priority}；质量：${result.quality}`,
          ...(evidence.length > 0 ? [`证据：\n${evidence}`] : []),
          ...(result.suggestedActions.length > 0
            ? [`建议动作：${result.suggestedActions.join("、")}`]
            : []),
        ].join("\n");
        await writeRepoMemory(database.db, {
          repositoryId: repositoryId ?? undefined,
          kind: "reflection",
          title: `Issue #${payload.subjectNumber} · ${result.category}/${result.severity} ${result.summary.slice(0, 50)}`,
          content,
          sourceType: "issue_analysis",
          sourceRef: `#${payload.subjectNumber}`,
        });
      } catch (error) {
        logger.warn(
          { err: error, taskId: task.id },
          "issue memory reflection skipped",
        );
      }
    },

    detectSpam: async (task, signal) => {
      try {
        if (!github) return null;
        const candidates =
          spamCandidates.length > 0 ? spamCandidates : issueCandidates;
        if (candidates.length === 0) return null;
        const { payload, identity } = issueIdentity(task);
        const context = await buildIssueContext(
          github,
          {
            installationId: payload.installationId,
            owner: identity.owner,
            name: identity.name,
            number: payload.subjectNumber,
          },
          undefined,
          signal,
        );
        const outcome = await detectSpamIssue(
          {
            adapters,
            candidates,
            deadlineMs: analysisDeadlineMs,
            retryPolicy: analysisRetryPolicy,
            signal,
          },
          context,
        );
        return outcome.outcome === "valid" ? outcome.verdict : null;
      } catch (error) {
        logger.warn({ err: error, taskId: task.id }, "spam detection skipped");
        return null;
      }
    },

    handleSpam: async (task, verdict) => {
      const { payload, identity } = issueIdentity(task);
      const githubClient = assertGithub(github);
      const target = `${payload.repositoryFullName}#${payload.subjectNumber}`;
      let action: "none" | "close" | "delete" = "none";
      try {
        action = await spamHandlingMode(payload.repositoryFullName);
        if (action === "close") {
          await closeSpamIssue(githubClient, payload, identity, verdict.reason);
        } else if (action === "delete") {
          try {
            await githubClient.deleteIssue({
              installationId: payload.installationId,
              owner: identity.owner,
              name: identity.name,
              number: payload.subjectNumber,
            });
          } catch (error) {
            if (
              error instanceof GitHubApiError &&
              error.category === "authentication_failed"
            ) {
              logger.warn(
                { err: error, target },
                "spam delete not permitted; falling back to close",
              );
              await closeSpamIssue(
                githubClient,
                payload,
                identity,
                verdict.reason,
              );
            } else {
              throw error;
            }
          }
        }
        // "none": no GitHub action; only the audit trail below.
      } catch (error) {
        logger.warn(
          { err: error, target, action },
          "spam handling failed",
        );
      }
      try {
        await writeAuditLog(database.db, {
          actor: "system",
          action: "issue.spam_handled",
          target,
          detail: {
            action,
            reason: verdict.reason,
            confidence: verdict.confidence,
          },
        });
      } catch (error) {
        logger.warn(
          { err: error, target },
          "spam audit log write failed",
        );
      }
    },
  });

  // --- 增量审查续跑：按仓库+PR 持久化最近的审查对话，供下一次 push 续跑 ---
  const REVIEW_HISTORY_PREFIX = "pr_review_history:";

  async function loadReviewHistory(
    repoFullName: string,
    number: number,
    currentRevision: string,
  ): Promise<readonly ModelMessage[] | undefined> {
    try {
      const rows = await database.db
        .select({ value: systemSettings.value })
        .from(systemSettings)
        .where(
          eq(
            systemSettings.key,
            `${REVIEW_HISTORY_PREFIX}${repoFullName}:${number}`,
          ),
        )
        .limit(1);
      const raw = rows[0]?.value;
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as {
        revision?: string;
        messages?: ModelMessage[];
      };
      // 已是同一 revision，无需续跑。
      if (parsed.revision === currentRevision) return undefined;
      if (!Array.isArray(parsed.messages) || parsed.messages.length === 0)
        return undefined;
      return parsed.messages;
    } catch {
      return undefined;
    }
  }

  async function persistReviewHistory(
    repoFullName: string,
    number: number,
    revision: string,
    messages: readonly ModelMessage[],
  ): Promise<void> {
    const capped = messages.slice(-40).map((m) => ({
      role: m.role,
      content:
        m.content.length > 4_000
          ? `${m.content.slice(0, 4_000)}…`
          : m.content,
    }));
    const key = `${REVIEW_HISTORY_PREFIX}${repoFullName}:${number}`;
    const value = JSON.stringify({ revision, messages: capped });
    await database.db
      .insert(systemSettings)
      .values({ key, value })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value, updatedAt: new Date() },
      });
  }

  const prReviewHandler = createPrReviewHandler({
    buildContext: async (task, signal) => {
      if (!github) throw new Error("GitHub App is not configured");
      const { payload, identity } = prIdentity(task);
      const [context, repoMemory, repoRules] = await Promise.all([
        buildPrContext(
          github,
          {
            installationId: payload.installationId,
            owner: identity.owner,
            name: identity.name,
            pullNumber: payload.subjectNumber,
          },
          undefined,
          signal,
        ),
        repoMemoryText(payload.repositoryFullName),
        loadRepoRules(
          github,
          payload.repositoryFullName,
          {
            installationId: payload.installationId,
            owner: identity.owner,
            name: identity.name,
          },
          signal,
        ),
      ]);
      const history = await loadReviewHistory(
        payload.repositoryFullName,
        payload.subjectNumber,
        payload.subjectRevision ?? "HEAD",
      );
      return {
        ...context,
        ...(repoMemory || repoRules
          ? {
              ...(repoMemory ? { repoMemory } : {}),
              ...(repoRules ? { repoRules } : {}),
              rendered: {
                ...context.rendered,
                ...(repoMemory ? { repoMemory } : {}),
                ...(repoRules ? { repoRules } : {}),
              },
            }
          : {}),
        ...(history ? { reviewHistory: history } : {}),
        toolsContext: {
          client: github,
          installationId: payload.installationId,
          owner: identity.owner,
          name: identity.name,
          ref: payload.subjectRevision ?? "HEAD",
        },
      };
    },

    review: async (context: PrReviewContext, signal) => {
      const renderedText = renderPrContextText(context.rendered);
      if (expertTeamEnabled) {
        return runExpertReview(
          {
            adapters,
            // Prefer expert_review candidates; fall back to pr_review's.
            candidates:
              expertReviewCandidates.length > 0
                ? expertReviewCandidates
                : reviewCandidates,
            deadlineMs: reviewDeadlineMs,
            retryPolicy: reviewRetryPolicy,
            signal,
          },
          {
            appliesTo: "pr",
            rendered: renderedText,
            skills: selectSkills("pr", renderedText),
          },
        );
      }
      const outcome = await reviewPullRequest(
        {
          adapters,
          candidates: reviewCandidates,
          deadlineMs: reviewDeadlineMs,
          retryPolicy: reviewRetryPolicy,
          signal,
          ...(context.toolsContext
            ? { tools: { context: context.toolsContext } }
            : {}),
          ...(context.reviewHistory
            ? { history: context.reviewHistory }
            : {}),
        },
        context.rendered,
      );
      // 持久化本次审查对话，供下一次 push 增量续跑。
      if (outcome.messages && context.toolsContext) {
        const { owner, name } = context.toolsContext;
        const revision = context.toolsContext.ref;
        void persistReviewHistory(
          `${owner}/${name}`,
          context.pullRequest.number,
          revision,
          outcome.messages,
        ).catch((error: unknown) =>
          logger.warn({ err: error }, "persist review history failed"),
        );
      }
      return outcome;
    },

    publishFinal: async (task, review) => {
      const { payload, identity } = prIdentity(task);
      const githubClient = assertGithub(github);
      const cfg = await prReviewConfig();
      if (cfg.autoReview) {
        // 正式 review（含行内 comments），幂等；行内锚点失败自动降级。
        await publishAssessment({
          store: publicationStore,
          github: {
            publishReview: ({
              installationId,
              owner,
              name,
              pullNumber,
              revision,
              body,
              event,
              comments,
            }) =>
              githubClient.createPullRequestReview({
                installationId,
                owner,
                name,
                pullNumber,
                commitId: revision,
                body,
                event,
                ...(comments && comments.length > 0 ? { comments } : {}),
              }),
          },
          taskId: task.id,
          installationId: payload.installationId,
          owner: identity.owner,
          name: identity.name,
          pullNumber: payload.subjectNumber,
          revision: payload.subjectRevision,
          review,
        });
      } else {
        // 自动审查关闭：不提交正式 review，只发一条摘要评论（幂等）。
        const key = `pr-comment:${identity.owner}/${identity.name}#${payload.subjectNumber}:${payload.subjectRevision}`;
        const existing = await publicationStore.findExternalObjectId(key);
        if (existing === null) {
          const comment = await githubClient.createIssueComment({
            installationId: payload.installationId,
            owner: identity.owner,
            name: identity.name,
            number: payload.subjectNumber,
            body: renderReviewBody(review),
          });
          await publicationStore.insert({
            taskId: task.id,
            idempotencyKey: key,
            externalObjectId: String(comment.id),
            channel: "github_issue_comment",
          });
        } else {
          await publicationStore.touch(key);
        }
      }
      await persistSubjectResult({
        taskId: task.id,
        subjectType: "pr",
        subjectNumber: payload.subjectNumber,
        repositoryFullName: payload.repositoryFullName,
        revision: payload.subjectRevision,
        result: review,
      });
    },

    beginCheckRun: async (task) => {
      const cfg = await prReviewConfig();
      if (!cfg.checkRun) return;
      const { payload, identity } = prIdentity(task);
      const githubClient = assertGithub(github);
      const key = `check-run:${identity.owner}/${identity.name}#${payload.subjectNumber}:${payload.subjectRevision}`;
      const existing = await publicationStore.findExternalObjectId(key);
      if (existing !== null) return;
      const run = await githubClient.createCheckRun({
        installationId: payload.installationId,
        owner: identity.owner,
        name: identity.name,
        headSha: payload.subjectRevision,
        runName: "AperturePrism AI Review",
        status: "in_progress",
        title: "AI 代码审查进行中",
        summary: "正在分析 PR 的变更与上下文，请稍候…",
      });
      await publicationStore.insert({
        taskId: task.id,
        idempotencyKey: key,
        externalObjectId: String(run.id),
        channel: "check_run",
      });
    },

    finishCheckRun: async (task, review) => {
      const cfg = await prReviewConfig();
      if (!cfg.checkRun) return;
      const { payload, identity } = prIdentity(task);
      const githubClient = assertGithub(github);
      const key = `check-run:${identity.owner}/${identity.name}#${payload.subjectNumber}:${payload.subjectRevision}`;
      const runId = await publicationStore.findExternalObjectId(key);
      if (runId === null) return;
      const findings = review.findings.length;
      const severe = review.findings.some((finding) =>
        finding.severity === "critical" || finding.severity === "high",
      );
      const conclusion = severe || findings > 0 ? "failure" : "success";
      await githubClient.updateCheckRun({
        installationId: payload.installationId,
        owner: identity.owner,
        name: identity.name,
        checkRunId: Number(runId),
        status: "completed",
        conclusion,
        title: findings > 0 ? `发现 ${findings} 个问题` : "未发现明显问题",
        summary: `结论：${review.overallTone}；变更 ${review.changedFileCount} 个文件（+${review.additions}/-${review.deletions}）；findings ${findings}。`,
      });
    },

    recordUsage: async (task, outcome) => {
      const lastAttempt = outcome.attempts.at(-1);
      await recordAttemptUsage(database.db, {
        taskId: task.id,
        workerId,
        attemptNumber: task.attemptNumber,
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        durationMs: outcome.durationMs,
        provider: lastAttempt?.candidate.provider ?? "",
        model: lastAttempt?.candidate.model ?? "",
      });
    },

    recordMemory: async (task, review) => {
      try {
        const { payload } = prIdentity(task);
        const repositoryId = await resolveRepositoryId(
          payload.repositoryFullName,
        );
        const findings = review.findings
          .slice(0, 3)
          .map(
            (finding) =>
              `- [${finding.severity}] ${finding.file}: ${finding.message.slice(0, 120)}`,
          )
          .join("\n");
        const content = [
          `总结：${review.summary.slice(0, 200)}`,
          `总体结论：${review.overallTone}；变更 ${review.changedFileCount} 文件（+${review.additions}/-${review.deletions}）`,
          ...(findings.length > 0 ? [`主要发现：\n${findings}`] : []),
        ].join("\n");
        await writeRepoMemory(database.db, {
          repositoryId: repositoryId ?? undefined,
          kind: "reflection",
          title: `PR #${payload.subjectNumber} · ${review.overallTone}`,
          content,
          sourceType: "pr_review",
          sourceRef: `#${payload.subjectNumber}`,
        });
      } catch (error) {
        logger.warn(
          { err: error, taskId: task.id },
          "pr memory reflection skipped",
        );
      }
    },
  });

  logger.info(
    {
      expertTeamEnabled,
      expertCandidates: expertReviewCandidates.length,
      reviewCandidates: reviewCandidates.length,
    },
    "agent expert team status",
  );

  const handler: TaskHandler = async (task, signal) => {
    // 每个任务开始前刷新一次凭据：用户在 WebUI 换了 GitHub App 之后，worker
    // 不该必须重启才认新凭据。指纹未变时这只是一次轻量查询。
    github = await githubProvider.get();
    if (task.taskType === "pr_review") return prReviewHandler(task, signal);
    return issueHandler(task, signal);
  };

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
          { event: event.type, errorCategory: event.errorCategory, error: event.error },
          "worker event failed",
        );
        return;
      }
      taskLogger.info({ event: event.type }, "worker event");
    },
  });
  await database.close();
  logger.info({ workerId }, "analysis worker stopped");
}

function prIdentity(task: { payload: unknown }) {
  const payload = parsePrReviewTaskPayload(task.payload);
  if (!payload) throw new Error("task payload is missing PR identity");
  const identity = repositoryOwnerName(payload.repositoryFullName);
  if (!identity)
    throw new Error(
      `invalid repository name in payload: ${payload.repositoryFullName}`,
    );
  return { payload, identity };
}

/** Persists a structured issue/PR result once per task (idempotent on taskId). */
async function persistSubjectResult(input: {
  taskId: string;
  subjectType: "issue" | "pr";
  subjectNumber: number;
  repositoryFullName: string;
  revision: string;
  result: unknown;
}): Promise<void> {
  await database.db
    .insert(subjectResults)
    .values({
      taskId: input.taskId,
      subjectType: input.subjectType,
      subjectNumber: input.subjectNumber,
      repositoryFullName: input.repositoryFullName,
      revision: input.revision,
      result: input.result,
      published: true,
    })
    .onConflictDoNothing({ target: subjectResults.taskId });
}

function assertGithub(github: ReturnType<typeof createGitHubClient> | null) {
  if (!github) throw new Error("GitHub App is not configured");
  return github;
}

/** Applies configured label rules to an analyzed issue (idempotent). */
async function applyConfiguredLabels(input: {
  github: ReturnType<typeof createGitHubClient>;
  installationId: string;
  owner: string;
  name: string;
  issueNumber: number;
  analysis: IssueAnalysisResult;
}): Promise<void> {
  const rules = await listLabelRules(database.db);
  // 标签来源 = 规则引擎匹配（category/severity/priority/quality）∪ 模型建议。
  // 此前模型在评论里输出的「建议标签」从不落到 GitHub（issue #23 用户误解的根源）：
  // 评论说了建议标签、Issue 上却没有。合并后言行一致；GitHub 会对不存在的
  // 标签自动创建。
  const ruleLabels = labelsForAnalysis(
    {
      category: input.analysis.category,
      severity: input.analysis.severity,
      priority: input.analysis.priority,
      quality: input.analysis.quality,
    },
    rules,
  );
  const labels = [
    ...new Set(
      [...ruleLabels, ...input.analysis.suggestedLabels].map((label) =>
        label.trim(),
      ),
    ),
  ].filter((label) => label.length > 0);
  // 契约上限：规则映射 + 模型建议各 ≤10；再兜底一层防爆量。
  const capped = labels.slice(0, 15);
  if (capped.length === 0) return;
  logger.info(
    { owner: input.owner, name: input.name, issueNumber: input.issueNumber, labels: capped },
    "applying configured labels",
  );
  await input.github.addIssueLabels({
    installationId: input.installationId,
    owner: input.owner,
    name: input.name,
    number: input.issueNumber,
    labels: capped,
  });
  // issue #31：把实际打上的标签同步进本地标签配置，WebUI「标签配置」页可见。
  // best-effort：失败只告警，不影响打标与分析任务。
  await syncAppliedLabels(database.db, capped).catch((error: unknown) =>
    logger.warn({ err: error }, "applied label sync failed"),
  );
}

/**
 * 分析行为设置的取值：仓库级覆盖优先，其次全局 `system_settings`，都没有时返回
 * undefined 让调用方套用应用默认（不同开关的默认值不同，这一层不猜）。
 *
 * 同一实例常同时接入个人项目与协作项目 —— 自动改标题在后者未必受欢迎，所以这
 * 些开关必须能按仓库分别控制（issue #54）。仓库未入库或读取失败时退回全局。
 */
async function resolveIssueSettings(
  repositoryFullName: string | null,
  keys: readonly string[],
): Promise<Map<string, string>> {
  let globals: Map<string, string>;
  try {
    globals = await loadSettings(database.db, keys);
  } catch (error) {
    logger.warn({ err: error }, "global settings read failed");
    throw error;
  }

  if (!repositoryFullName) return globals;
  try {
    const repositoryId = await resolveRepositoryId(repositoryFullName);
    if (!repositoryId) return globals;
    const overrides = await getRepositorySettingsFor(
      database.db,
      repositoryId,
      keys,
    );
    // 覆盖优先：仓库级有值就盖掉全局，没有的键保持全局值。
    for (const [key, value] of overrides) globals.set(key, value);
    return globals;
  } catch (error) {
    // 仓库级覆盖不可读时退回全局，而不是让整次分析失败。
    logger.warn(
      { err: error, repo: repositoryFullName },
      "repository settings read failed; using global settings",
    );
    return globals;
  }
}

/**
 * 是否允许 Issue 分析读取仓库源码。默认启用：读仓让模型给出可落地、精确到
 * 文件/函数的建议（用户 09-04 反馈）。读取失败时按关闭处理，不因设置不可用
 * 而改变行为。
 */
async function issueDeepAnalysisEnabled(
  repositoryFullName: string | null,
): Promise<boolean> {
  try {
    const settings = await resolveIssueSettings(repositoryFullName, [
      "issue_deep_analysis",
    ]);
    return parseBool(
      settings.get("issue_deep_analysis"),
      BOOLEAN_DEFAULTS.issue_deep_analysis ?? false,
    );
  } catch (error) {
    // 读设置失败时静默降级为不读仓（安全），但必须留痕，否则 deep 读仓会无影无踪地
    // 失效、极难排查（工具不注入时模型无法读仓挑错，评论只会诚实说"未读取文件"）。
    logger.warn(
      { err: error, repo: repositoryFullName },
      "issue deep analysis settings read failed; disabling deep source reading",
    );
    return false;
  }
}

/**
 * 判定 Issue 是否属「缺陷类」（bug / security / performance）或「代码审查请求」，
 * 决定是否读仓定位。命中以下任一条即读仓：
 * 1. 缺陷类语义：报错、失败、异常、崩溃、无法、安全、性能等；
 * 2. 代码审查请求：检查/审查/看看某文件或代码的 bug / 错误 / 哪里有问题（即便
 *    未明说 bug，用户点名要挑错也应读仓）。feature 等纯需求描述不误判。
 */
const DEFECT_HINT =
  /bug|fix|fault|defect|error|fail|crash|exception|stack|报错|错误|失败|异常|崩溃|无法|不能|卡死|闪退|坏了|安全|漏洞|泄漏|泄露|性能|慢|卡|风险|review|check|inspect|检查|审查|审阅|看看|哪里错|哪里不对|哪里有问题|哪写错|有问题|帮我看|找.*bug|挑错/i;

const DEFECT_LABEL_HINT = /\b(bug|fault|defect|fix|security|vulnerability)\b/i;

/**
 * 代码引用兜底（#70）：deep 已开启时，标题/正文若引用具体源码文件或扩展名，
 * 说明用户期望结合代码分析，即使类型前缀/标签未命中也读仓。
 */
const CODE_REFERENCE_HINT =
  /\b[\w./-]+\.(py|js|ts|tsx|jsx|go|rs|java|c|cpp|h|hpp|sh|json|yaml|yml|toml|sql|md)\b|(源码|代码|实现逻辑|在哪(里|儿)|哪一行|报错位置|如何实现|怎么实现)/i;

function isDefectIssue(context: IssueContext): boolean {
  const issue = context.issue;
  const labels = issue.labels ?? [];
  if (labelsMatchHint(labels, DEFECT_LABEL_HINT)) return true;
  const hay = `${issue.title ?? ""}\n${issue.body ?? ""}`;
  return DEFECT_HINT.test(hay);
}

/**
 * 判定 Issue 是否属「功能请求类」（feature / enhancement），决定是否读仓定位
 * 并给出具体改动位置（issue #56）。标签含 feature/enhancement，或标题/正文
 * 含较强的功能请求语义（新增、支持某能力、希望加…）即命中；与 isDefectIssue
 * 相互独立，任一命中都会触发读仓。
 */
const FEATURE_HINT =
  /feature|feat|enhancement|enhance|improvement|feature-request|新功能|新需求|功能请求|特性|新增|能否.*(支持|加|添加)|能不能.*(支持|加|添加)|希望.*(支持|加|添加|增加|做|实现)|建议.*(支持|加|添加|增加|做|实现|增强)|增强|优化|加一个|加个|添加.*(功能|支持)|支持.*功能|想要.*(功能|支持)|需求|提议/i;

/** 标题/正文常见类型前缀（GitHub 模板风格），大小写不敏感、可带 severity。 */
const TYPE_PREFIX_HINT = /^\[[^\]]*(bug|fix|fault|defect|enhancement|enhance|feature|feat|新功能|优化|需求|问题)[^\]]*\]/i;

/** 标签词边界匹配：兼容 feature-request / Feature Request 等变体（精确 includes 会漏）。 */
function labelsMatchHint(labels: readonly string[], hint: RegExp): boolean {
  return labels.some((label) => hint.test(label));
}

const FEATURE_LABEL_HINT = /\b(feature|feat|enhancement|enhance|feature-request)\b/i;

function isFeatureRequest(context: IssueContext): boolean {
  const issue = context.issue;
  const labels = issue.labels ?? [];
  if (labelsMatchHint(labels, FEATURE_LABEL_HINT)) return true;
  const hay = `${issue.title ?? ""}\n${issue.body ?? ""}`;
  if (TYPE_PREFIX_HINT.test(hay)) return true;
  return FEATURE_HINT.test(hay);
}

/** 最小文件读取器：避免引入 github-adapter 的完整 GitHubClient 类型依赖。 */
type FileReader = {
  getFileContents(args: {
    installationId: string;
    owner: string;
    name: string;
    path: string;
    ref: string;
  }): Promise<{ content?: string } | null | undefined>;
  /** 列目录条目（contents API），供兜底命中按关键词扫仓用。 */
  listDirectory(args: {
    installationId: string;
    owner: string;
    name: string;
    path: string;
    ref: string;
  }): Promise<{ name: string; path: string; type: string }[]>;
};

/** 审查/缺陷请求里用户点名的文件路径（如 main.py、backend/app.ts）。最多取 2 个。 */
const TARGET_FILE_RE =
  /([\w.\-/]+\.(?:py|js|ts|tsx|jsx|json|go|rs|java|c|cc|cpp|h|hpp|sh|ps1|bat|mjs|cjs|css|html|yaml|yml|toml|md))/gi;
const PRELOAD_MAX_CHARS = 60_000;

function extractTargetFiles(context: IssueContext): string[] {
  const hay = `${context.issue.title ?? ""}\n${context.issue.body ?? ""}`;
  const found: string[] = [];
  for (const match of hay.matchAll(TARGET_FILE_RE)) {
    const path = match[1];
    if (path && path.length <= 160 && !path.includes(" ")) found.push(path);
  }
  return [...new Set(found)].slice(0, 2);
}

/**
 * 方案B：服务端主动预读目标文件源码并注入上下文，模型无需依赖调用 read_file
 * 即可看到代码（deepseek 对 function-calling 不稳定，工具注入无法保证其一定
 * 主动读仓）。先取用户点名文件；未点名的（常见于模糊 enhancement）走兜底命中：
 * 按 issue 关键词在有界扫出的仓库路径里打分，挑最相关的源码注入（#62）。
 * 读不到的文件静默跳过，不阻断分析。
 */
const FALLBACK_MAX_FILES = 200;
const FALLBACK_MAX_DEPTH = 3;
/** 需跳过的目录（依赖/产物/版本控制/虚拟环境）。 */
const FALLBACK_SKIP_DIR =
  /(^|\/)(\.git|node_modules|dist|build|\.next|\.nuxt|out|coverage|vendor|target|\.cache|\.venv)(\/|$)/;
/** 只把可读的源码/配置纳入候选，排除二进制/图片/归档/压缩产物。 */
const FALLBACK_SOURCE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cc|cpp|h|hpp|sh|ps1|bat|json|css|scss|less|html|vue|svelte|yml|yaml|toml|md)$/i;

/** 从 issue 标题/正文提取英文技术关键词（去停用词），用于兜底扫仓匹配。 */
function extractIssueKeywords(context: IssueContext): Set<string> {
  const hay = `${context.issue.title ?? ""}\n${context.issue.body ?? ""}`.toLowerCase();
  const stop = new Set(
    "a|an|the|and|or|for|with|from|to|of|in|on|at|by|as|is|it|be|are|was|were|been|this|that|these|those|its|our|their|your|his|her|my|i|we|you|they|he|she|do|does|did|not|no|yes|but|if|so|then|there|here|about|into|over|under|again|while|when|how|why|what|where|which|who|can|could|would|should|may|might|must|will|shall|also|only|some|such|more|most|other|same|very|too|just|please|help|bug|fix|feat|feature|enhancement|issue|support|add|adding|new|use|used|using|get|got|give|need|needs|want|wants|have|has|having".split(
      "|",
    ),
  );
  const terms = new Set<string>();
  for (const m of hay.matchAll(/\b[a-z][a-z0-9_-]{2,}\b/g)) {
    const w = m[0];
    if (!stop.has(w) && !/^\d/.test(w)) terms.add(w);
  }
  return terms;
}

/** 有界 BFS：收集仓库内源码/配置文件路径（限制深度、访问数与文件数）。 */
async function listRepoSourcePaths(
  reader: FileReader,
  context: IssueContext,
): Promise<string[]> {
  const files: string[] = [];
  const queue: string[] = [""];
  let visited = 0;
  let depth = 0;
  while (queue.length > 0 && files.length < FALLBACK_MAX_FILES && visited < FALLBACK_MAX_FILES * 2) {
    const level = queue.length;
    depth += 1;
    if (depth > FALLBACK_MAX_DEPTH) break;
    for (let i = 0; i < level && queue.length > 0; i++) {
      const dir = queue.shift()!;
      visited += 1;
      const entries = await reader
        .listDirectory({
          installationId: context.installationId,
          owner: context.repository.owner,
          name: context.repository.name,
          path: dir,
          ref: "HEAD",
        })
        .catch(() => []);
      for (const e of entries) {
        if (e.type === "file") {
          if (FALLBACK_SOURCE_EXT.test(e.path) && !/\.(min|bundle|chunk)\.\w+$/.test(e.path)) {
            files.push(e.path);
          }
        } else if (e.type === "dir" && !FALLBACK_SKIP_DIR.test(e.path)) {
          queue.push(e.path);
        }
      }
    }
  }
  return files;
}

/** 按关键词给路径打分：命中文件名加权更高。 */
function scorePathByKeywords(path: string, terms: Set<string>): number {
  const lower = path.toLowerCase();
  const base = lower.split("/").pop() ?? "";
  let score = 0;
  for (const t of terms) {
    if (base.includes(t)) score += 2;
    else if (lower.includes(t)) score += 1;
  }
  return score;
}

/** 兜底命中：无点名文件时，按 issue 关键词挑最相关的源码（最多 2 个）。 */
async function findRelevantFiles(
  reader: FileReader,
  context: IssueContext,
): Promise<string[]> {
  const terms = extractIssueKeywords(context);
  if (terms.size === 0) return [];
  const paths = await listRepoSourcePaths(reader, context);
  return paths
    .map((path) => ({ path, score: scorePathByKeywords(path, terms) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((x) => x.path);
}

/** 实际读取并截断一组文件；读不到的文件静默跳过，不阻断分析。 */
async function readPreloadFiles(
  reader: FileReader,
  context: IssueContext,
  paths: string[],
): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  for (const path of paths) {
    try {
      const file = await reader.getFileContents({
        installationId: context.installationId,
        owner: context.repository.owner,
        name: context.repository.name,
        path,
        ref: "HEAD",
      });
      if (file && file.content) {
        out.push({ path, content: file.content.slice(0, PRELOAD_MAX_CHARS) });
      }
    } catch {
      // 文件不存在或读取失败 → 忽略，保留其它可读文件。
    }
  }
  return out;
}

/**
 * #62 方案2：内容级检索。路径打分未命中（多为纯中文语义，ASCII 路径无法直接
 * 匹配中文关键词）时，让模型从仓库候选文件清单里挑最相关源码回填预读注入。
 */
function buildFilePickRequest(
  context: IssueContext,
  candidatePaths: string[],
): {
  messages: { role: "system" | "user"; content: string }[];
  responseFormat: "json";
  temperature: number;
  maxOutputTokens: number;
} {
  const issue = `${context.issue.title ?? ""}\n${context.issue.body ?? ""}`;
  const list = candidatePaths.slice(0, 500).join("\n");
  return {
    messages: [
      {
        role: "system",
        content:
          "你是仓库代码检索助手。根据用户 Issue（可能为中文）找出与修复/实现该需求最相关的仓库文件。只能从给定的文件清单中选择，不得编造路径。",
      },
      {
        role: "user",
        content: `Issue 内容（可能是中文）：\n${issue}\n\n候选文件清单（只能从这些里选）：\n${list}\n\n请返回一个 JSON 对象 {"paths": [...]}，最多 2 个、按相关度从高到低；都不相关则返回 {"paths": []}。只输出该 JSON。`,
      },
    ],
    responseFormat: "json",
    temperature: 0.1,
    maxOutputTokens: 700,
  };
}

/** 解析模型返回的文件选择，只保留候选清单内真实存在的路径（大小写不敏感）。 */
function parseFilePicks(text: string, candidates: string[]): string[] {
  const byLower = new Map<string, string>();
  for (const p of candidates) byLower.set(p.toLowerCase(), p);
  const picked: string[] = [];
  const push = (v: string): void => {
    if (typeof v !== "string") return;
    const real = byLower.get(v.trim().toLowerCase());
    if (real && !picked.includes(real)) picked.push(real);
  };
  // 先试 JSON 块：{"paths": [ ... ]}
  const blocks = text.match(/\{[\s\S]*\}/g) ?? [];
  for (const block of blocks) {
    try {
      const obj = JSON.parse(block) as { paths?: unknown };
      if (Array.isArray(obj.paths)) for (const v of obj.paths) push(String(v));
    } catch {
      // 非 JSON 块，跳过。
    }
  }
  if (picked.length > 0) return picked.slice(0, 2);
  // 兜底：逐行当作相对路径解析（去掉列表符号/引号/逗号）。
  for (const line of text.split(/\r?\n/)) {
    const clean = line
      .trim()
      .replace(/^[-*\d.\s"'`]+/, "")
      .replace(/[,;'"]+$/u, "")
      .trim();
    if (clean) push(clean);
  }
  return picked.slice(0, 2);
}

/**
 * 预读源码：优先用户点名文件 → 路径关键词命中 → 内容级检索（模型挑文件）。
 * 注入后模型无需依赖不稳定的 function-calling 即可看到源码（#62）。
 */
async function preloadTargetFiles(
  reader: FileReader,
  context: IssueContext,
  pickWithModel?: (
    candidatePaths: string[],
    ctx: IssueContext,
  ) => Promise<string[]>,
): Promise<{ path: string; content: string }[]> {
  const explicit = extractTargetFiles(context);
  if (explicit.length > 0) return readPreloadFiles(reader, context, explicit);
  const pathHits = await findRelevantFiles(reader, context).catch(() => []);
  if (pathHits.length > 0) return readPreloadFiles(reader, context, pathHits);
  // 路径打分未命中（中文语义居多）→ 内容级检索：让模型挑最相关源码。
  if (pickWithModel) {
    const candidatePaths = await listRepoSourcePaths(reader, context).catch(() => []);
    if (candidatePaths.length > 0) {
      const modelPicks = await pickWithModel(candidatePaths, context).catch(() => []);
      if (modelPicks.length > 0) return readPreloadFiles(reader, context, modelPicks);
    }
  }
  return [];
}

/**
 * #57：发布前校验 proposedChanges 里的 path 是否真实存在于仓库。
 * 模型在无源码上下文时会凭猜测编造文件/文件夹路径（core/ 幻觉），
 * 这里用 contents API 逐个确认；不存在或非文件（目录）的路径从
 * proposedChanges 中移除，避免评论展示无法定位的改动点。
 * 占位路径（未读取源码）跳过校验；best-effort：GitHub 校验失败时
 * 保留原条目，不因接口抖动误删模型真实给出的建议。
 */
async function verifyProposedChangePaths(input: {
  reader: FileReader;
  installationId: string;
  owner: string;
  name: string;
  changes: readonly ProposedChange[];
}): Promise<ProposedChange[]> {
  const kept: ProposedChange[] = [];
  for (const change of input.changes) {
    if (!change.path || change.path === CODE_ACCESS_UNKNOWN_PATH) {
      kept.push(change);
      continue;
    }
    try {
      const file = await input.reader.getFileContents({
        installationId: input.installationId,
        owner: input.owner,
        name: input.name,
        path: change.path,
        ref: "HEAD",
      });
      // getFileContents 对目录/非文件/404 返回 null → 视为不存在，移除。
      if (file) {
        kept.push(change);
      } else {
        logger.warn(
          { repo: `${input.owner}/${input.name}`, path: change.path },
          "proposed change path not found; dropped before publish",
        );
      }
    } catch (error) {
      // 校验失败（网络/限流等）不误删，保留原建议。
      kept.push(change);
    }
  }
  return kept;
}

/**
 * 当前 Issue 分析的提示词版本。读「分析设置 → Issue 提示词版本」；
 * 缺省或读取失败回落到当前版本（analysis-worker 每轮 pass 重新读，改设置即生效）。
 */
async function resolveIssuePromptVersion(): Promise<string | undefined> {
  try {
    const settings = await resolveIssueSettings(null, [
      "issue_prompt_version",
    ]);
    const raw = settings.get("issue_prompt_version");
    return raw && raw.trim().length > 0 ? raw.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 当前 Issue 分析的强度模式（adaptive / light / full）。读「分析设置 →
 * Issue 提示词模式」；缺省或读取失败返回 undefined（默认 adaptive）。
 */
async function resolveIssuePromptMode(): Promise<"adaptive" | "light" | "full" | undefined> {
  try {
    const settings = await resolveIssueSettings(null, ["issue_prompt_mode"]);
    const raw = settings.get("issue_prompt_mode");
    if (raw === "light" || raw === "full" || raw === "adaptive") return raw;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 当前 Issue 分析的结果区块开关（summary / probable_cause / missing_information / …）。
 * 返回「通用兜底组 + bug 组 + feature 组」，交给 analyzer 按类别做前置 / 后置选择。
 * 三个组各自读「分析设置 → Issue 结果区块（通用 / 缺陷类 / 功能请求）」；
 * 某个组没配置时用 undefined 表示「未单独设置」，analyzer 会回落到通用组或全开。
 *
 * 若该仓库开启了 `issue_use_unified_sections`（#44），则所有类别一律回落到通用组：
 * 返回的 bug / feature 组均为 undefined，analyzer 对任何分类都走通用区块。
 */
async function resolveIssueSections(
  repositoryFullName: string | null,
): Promise<{
  sections: ReadonlySet<IssueResultSection> | undefined;
  sectionsByCategory: {
    bug: ReadonlySet<IssueResultSection> | undefined;
    feature: ReadonlySet<IssueResultSection> | undefined;
  };
}> {
  const read = async (
    key: string,
    isCategory: boolean,
  ): Promise<ReadonlySet<IssueResultSection> | undefined> => {
    try {
      const settings = await resolveIssueSettings(repositoryFullName, [key]);
      const raw = settings.get(key);
      // 分类组（bug / feature）未单独配置时返回 undefined，让 analyzer 回落到通用组。
      if (isCategory && !raw) return undefined;
      const parsed = parseIssueResultSections(raw);
      return parsed.size === ISSUE_RESULT_SECTIONS.length ? undefined : parsed;
    } catch {
      return undefined;
    }
  };
  const unified = await issueUseUnifiedSections(repositoryFullName);
  return {
    sections: await read("issue_result_sections", false),
    sectionsByCategory: unified
      ? { bug: undefined, feature: undefined }
      : {
          bug: await read("issue_result_sections_bug", true),
          feature: await read("issue_result_sections_feature", true),
        },
  };
}

/**
 * 是否让该仓库所有 Issue 都使用通用统一区块（#44）。
 * 仓库级覆盖 → 全局默认（false）。开启后不再按功能请求 / 缺陷分类选择区块。
 */
async function issueUseUnifiedSections(
  repositoryFullName: string | null,
): Promise<boolean> {
  try {
    const settings = await resolveIssueSettings(repositoryFullName, [
      "issue_use_unified_sections",
    ]);
    return parseBool(
      settings.get("issue_use_unified_sections"),
      BOOLEAN_DEFAULTS.issue_use_unified_sections ?? false,
    );
  } catch {
    return false;
  }
}

/**
 * 是否开启该仓库的 Issue 图片多模态分析（#545 Phase 1）。
 * 仓库级覆盖 → 全局默认（false）。开启后把 Issue 里的图随分析发给模型。
 */
async function issueVisionEnabled(
  repositoryFullName: string | null,
): Promise<boolean> {
  try {
    const settings = await resolveIssueSettings(repositoryFullName, [
      "issue_vision_enabled",
    ]);
    return parseBool(
      settings.get("issue_vision_enabled"),
      BOOLEAN_DEFAULTS.issue_vision_enabled ?? false,
    );
  } catch {
    return false;
  }
}

/**
 * 编辑 Issue 后是否重新分析。只有 webhook 的 `issues.edited` 受限制：改一个
 * 错别字就重跑完整分析，既花掉一次模型调用，又会用新结论覆盖既有评论。
 *
 * 比较对象是索引任务写进 `issue_documents` 的归一化正文，所以当前正文必须用
 * 同一套 `normalizedIndexText` 归一化 —— 只改图片或链接不会被算成改动。
 *
 * 任何一步失败都按「分析」处理：宁可多花一次调用，也不要静默吞掉真实修改。
 */
async function shouldReanalyzeIssue(
  task: { payload: unknown },
  context: IssueContext,
): Promise<boolean> {
  if (!isIssueEditEvent(task.payload)) return true;
  try {
    const { payload } = issueIdentity(task);
    const repositoryId = await resolveRepositoryId(payload.repositoryFullName);
    const snapshot = await getIndexedIssueText(
      database.sql as unknown as SqlTag,
      { repositoryId, issueNumber: payload.subjectNumber },
    );
    const revisionAt = new Date(payload.subjectRevision);
    const decision = decideReanalysis({
      gated: true,
      snapshot,
      revisionAt: Number.isNaN(revisionAt.getTime()) ? null : revisionAt,
      currentText: normalizedIndexText({
        title: context.issue.title,
        body: context.issue.body,
      }),
      minChangeRatio: await issueMinChangeRatio(payload.repositoryFullName),
    });
    logger.info(
      {
        repo: payload.repositoryFullName,
        issueNumber: payload.subjectNumber,
        reanalyze: decision.reanalyze,
        reason: decision.reason,
        changeRatio: decision.changeRatio,
      },
      decision.reanalyze
        ? "issue edit will be reanalyzed"
        : "issue edit skipped as a minor change",
    );
    return decision.reanalyze;
  } catch (error) {
    logger.warn(
      { err: error },
      "reanalysis gate failed; analyzing the edit anyway",
    );
    return true;
  }
}

/** 重新分析的最小变化比例（`issue_reanalyze_min_change`），可按仓库覆盖。 */
async function issueMinChangeRatio(
  repositoryFullName: string | null,
): Promise<number> {
  try {
    const settings = await resolveIssueSettings(repositoryFullName, [
      "issue_reanalyze_min_change",
    ]);
    return parseMinChangeRatio(settings.get("issue_reanalyze_min_change"));
  } catch {
    return DEFAULT_MIN_CHANGE_RATIO;
  }
}

async function issueEnhancementConfig(repositoryFullName: string | null): Promise<{
  autoAssign: boolean;
  assignee: string;
  rewriteTitle: boolean;
}> {
  try {
    const map = await resolveIssueSettings(repositoryFullName, [
      "issue_auto_assign",
      "issue_assignee",
      "issue_rewrite_title",
    ]);
    return {
      autoAssign: parseBool(
        map.get("issue_auto_assign"),
        BOOLEAN_DEFAULTS.issue_auto_assign ?? false,
      ),
      assignee: (map.get("issue_assignee") ?? "").trim(),
      // 默认开启：含糊的标题（如只写「bug」）让维护者在列表页无法判断内容，
      // 改写成 [标签][重要度]清晰标题 才是用户期望的默认行为。显式设为
      // "false" 可关闭（全局或按仓库）。
      rewriteTitle: parseBool(
        map.get("issue_rewrite_title"),
        BOOLEAN_DEFAULTS.issue_rewrite_title ?? true,
      ),
    };
  } catch {
    // 读取设置失败时不改写标题：宁可不动，也不要基于未知配置改写用户的 Issue。
    return { autoAssign: false, assignee: "", rewriteTitle: false };
  }
}

/** PR 审查交互开关（运行时设置，可在 WebUI「系统配置」热更新）。 */
async function prReviewConfig(): Promise<{ checkRun: boolean; autoReview: boolean }> {
  try {
    const map = await loadSettings(database.db, [
      "pr_check_run",
      "pr_auto_review",
    ]);
    return {
      checkRun: parseBool(
        map.get("pr_check_run"),
        BOOLEAN_DEFAULTS.pr_check_run ?? true,
      ),
      autoReview: parseBool(
        map.get("pr_auto_review"),
        BOOLEAN_DEFAULTS.pr_auto_review ?? true,
      ),
    };
  } catch {
    return { checkRun: true, autoReview: true };
  }
}

/** GitHub 单个 Issue 最多接受 10 个 assignee，超出会整请求失败。 */
const maxIssueAssignees = 10;

/**
 * 解析指派名单：配置了 issue_assignee 就只用它；留空时默认「仓库所有者 +
 * 协作者」（issue #7）。始终排除 Issue 作者——把问题派回给报告者没有意义。
 * 拉取协作者需要额外权限，失败时降级为仅所有者，不让指派整体失效。
 */
async function resolveIssueAssignees(input: {
  github: ReturnType<typeof createGitHubClient>;
  installationId: string;
  owner: string;
  name: string;
  configured: string;
  author: string | null;
}): Promise<string[]> {
  if (input.configured) {
    return input.configured === input.author ? [] : [input.configured];
  }

  let collaborators: string[] = [];
  try {
    collaborators = await input.github.listCollaborators({
      installationId: input.installationId,
      owner: input.owner,
      name: input.name,
    });
  } catch (error) {
    logger.warn(
      { err: error, repo: `${input.owner}/${input.name}` },
      "collaborator lookup failed; assigning the owner only",
    );
  }

  const seen = new Set<string>();
  const assignees: string[] = [];
  for (const login of [input.owner, ...collaborators]) {
    if (login === input.author || seen.has(login)) continue;
    seen.add(login);
    assignees.push(login);
    if (assignees.length === maxIssueAssignees) break;
  }
  return assignees;
}

/**
 * Issue 增强：自动指派（issue_assignee 留空时默认仓库所有者与协作者，跳过
 * 作者本人）与标题改写（issue_rewrite_title 开启时应用 suggestedTitle）。
 * 全部 best-effort：失败只告警，不影响分析任务状态。
 */
async function applyIssueEnhancements(input: {
  github: ReturnType<typeof createGitHubClient>;
  installationId: string;
  owner: string;
  name: string;
  issueNumber: number;
  analysis: Pick<
    IssueAnalysisResult,
    "severity" | "priority" | "suggestedLabels" | "suggestedTitle"
  >;
}): Promise<string[]> {
  const cfg = await issueEnhancementConfig(`${input.owner}/${input.name}`);
  // 标题按 [标签][重要度]标题 格式拼装（issue #5），前缀由服务端生成。
  const suggested = formatSuggestedTitle(input.analysis) ?? "";
  if (!cfg.autoAssign && !(cfg.rewriteTitle && suggested)) return [];

  // 需要作者（跳过自己）与当前标题（避免无效改写）时再拉取一次 Issue。
  const issue = await input.github.getIssue({
    installationId: input.installationId,
    owner: input.owner,
    name: input.name,
    number: input.issueNumber,
  });

  const patches: { title?: string; assignees?: string[] } = {};
  if (cfg.autoAssign) {
    const assignees = await resolveIssueAssignees({
      github: input.github,
      installationId: input.installationId,
      owner: input.owner,
      name: input.name,
      configured: cfg.assignee,
      author: issue.author,
    });
    if (assignees.length > 0) patches.assignees = assignees;
  }
  if (cfg.rewriteTitle && suggested && suggested !== issue.title) {
    patches.title = suggested;
  }
  if (Object.keys(patches).length === 0) return [];

  await input.github.updateIssue({
    installationId: input.installationId,
    owner: input.owner,
    name: input.name,
    number: input.issueNumber,
    ...patches,
  });
  logger.info(
    {
      repo: `${input.owner}/${input.name}`,
      issueNumber: input.issueNumber,
      patches,
    },
    "issue enhancement applied",
  );
  // 返回实际指派人（评论用于对齐「建议指派人」与真实指派，避免不一致）。
  return patches.assignees ?? [];
}

/** Reads the ad/spam handling policy with repository override; defaults to close. */
async function spamHandlingMode(
  repositoryFullName: string | null = null,
): Promise<"none" | "close" | "delete"> {
  try {
    const settings = await resolveIssueSettings(repositoryFullName, [
      "spam_handling",
    ]);
    return parseSpamHandling(settings.get("spam_handling"));
  } catch (error) {
    logger.warn(
      { err: error, repo: repositoryFullName },
      "spam handling setting read failed; using close",
    );
    return "close";
  }
}

/** Posts an explanatory comment and closes the flagged spam issue. */
async function closeSpamIssue(
  githubClient: ReturnType<typeof createGitHubClient>,
  payload: { installationId: string; subjectNumber: number },
  identity: { owner: string; name: string },
  reason: string,
): Promise<void> {
  await githubClient.createIssueComment({
    installationId: payload.installationId,
    owner: identity.owner,
    name: identity.name,
    number: payload.subjectNumber,
    body: spamCloseComment(reason),
  });
  await githubClient.closeIssue({
    installationId: payload.installationId,
    owner: identity.owner,
    name: identity.name,
    number: payload.subjectNumber,
  });
}

function spamCloseComment(reason: string): string {
  return `该 Issue 被识别为广告 / 垃圾内容，已自动关闭。\n\n判定理由：${reason}\n\n如果这是误判，请重新打开 Issue 并补充说明，维护者会复核。`;
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
