import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  DEFAULT_ALERT_THRESHOLDS,
  diffAlertTransitions,
  evaluateAlerts,
  type AlertRecord,
  type AlertRuleId,
  type AlertThresholds,
  type AlertTransition,
} from "./alerts.js";
import { and, asc, desc, eq, gt, inArray, isNotNull, like, or } from "drizzle-orm";
import {
  ALLOWED_SETTING_KEYS,
  BOOLEAN_DEFAULTS,
  createCredentialCipher,
  KNOWN_SETTING_KEYS,
  getSettingSpec,
  loadConfig,
  parseBool,
  parseLogLevel,
  SECRET_SETTING_KEYS,
  validateSettingValue,
} from "../../../packages/config/src/index.js";
import { createSessionSigner } from "./session.js";
import {
  analysisTasks,
  applyBackupSnapshot,
  buildBackupSnapshot,
  checkDatabase,
  checkRedis,
  closeRedisClient,
  createDatabaseClient,
  createRedisClient,
  deleteLabelRule,
  deleteRepoMemory,
  ensureUser,
  getRepositorySettings,
  getRepositorySettingsFor,
  getScanConfig,
  getUser,
  hashPassword,
  ingestGitHubWebhook,
  issueDocuments,
  LABEL_RULE_PREFIXES,
  externalPublications,
  listAuditLogs,
  listLabelRules,
  deleteSetting,
  listScanRuns,
  listUserSessions,
  loadSettings,
  needsPasswordBootstrap,
  putSetting,
  clearSettingWithRotation,
  putSettingWithRotation,
  rotationInfo,
  readPreviousValueWithinGrace,
  createSession,
  revokeSession,
  revokeSessionById,
  revokeUserSessions,
  setLastLogin,
  setPassword,
  verifyPassword,
  canAccessGrant,
  deleteGrant,
  listAllGrants,
  listGrantsForUser,
  setGrant,
  pruneRepositories,
  resolveSettingValue,
  resolveGithubAppCredentials,
  seedDefaultLabelRules,
  listRepoMemory,
  writeRepoMemory,
  listUsers,
  modelRolePolicies,
  providerAccounts,
  isRepositorySettingKey,
  repositories,
  REPOSITORY_SETTING_KEYS,
  setRepositorySetting,
  setUserRoles,
  subjectResults,
  systemSettings,
  taskAttempts,
  taskEvents,
  updateDisplayName,
  upsertInstalledRepositories,
  upsertLabelRule,
  upsertScanConfig,
  webhookDeliveries,
  writeAuditLog,
} from "../../../packages/database/src/index.js";
import { memoryConsolidationSweep } from "../../../apps/scheduler/src/consolidation.js";
import {
  handleUpdateApply,
  handleUpdateHistory,
  handleUpdateStatus,
} from "./update.js";
import {
  handleBotStart,
  handleBotStatus,
  handleBotStop,
} from "./botctl.js";
import {
  createGitHubClient,
  GitHubApiError,
  normalizeGitHubEvent,
  parseIssueCommand,
  REPO_RULES_DIR,
  type GitHubClient,
  type NormalizedGitHubEvent,
  verifyWebhookSignature,
  WebhookSignatureError,
  UnsupportedGitHubEventError,
} from "../../../packages/github-adapter/src/index.js";
import {
  DEFAULT_ISSUE_RESULT_SECTIONS_VALUE,
  DEFAULT_MIN_CHANGE_RATIO,
  ISSUE_ANALYSIS_POLICY_VERSION,
  repositoryOwnerName,
} from "../../../packages/issue-analysis/src/index.js";
import {
  serializeSseEvent,
  SSE_HEADERS,
} from "../../../packages/event-stream/src/index.js";
import {
  cancelTask,
  createAnalysisTask,
  resetTaskToQueued,
} from "../../../packages/task-engine/src/index.js";
import { PR_REVIEW_POLICY_VERSION } from "../../../packages/pr-review/src/index.js";
import {
  BUILTIN_SKILLS,
  EXPERT_TEAM,
} from "../../../packages/agent-capabilities/src/index.js";
import {
  extractIssueSignals,
  normalizedIndexText,
  recallCandidatesWithRepos,
  type SqlTag,
} from "../../../packages/duplicate-detection/src/index.js";
import {
  createLogger,
  metrics,
  startTimer,
  withCorrelation,
} from "../../../packages/observability/src/index.js";

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);
const database = createDatabaseClient(config.databaseUrl);
const redis = createRedisClient(config.redisUrl);

/**
 * Lazy GitHub App client for the manual-trigger endpoint, built only when the
 * App is configured. Failures degrade to `null` so the API still starts and
 * the manual endpoint reports `github_not_configured` instead of crashing.
 */
/**
 * GitHub App 凭据可以来自环境变量（GITHUB_APP_ID + 私钥文件），也可以在 WebUI
 * 里保存到 system_settings（私钥用 AES-GCM 加密）。运行时设置优先：它是用户刚在
 * 界面上填的，应当立即生效。凭据解析已下沉到 database 包的
 * `resolveGithubAppCredentials`，api 与三个 worker 共用同一实现。
 */
async function loadGithubAppCredentials(): Promise<{
  appId: string;
  privateKeyPem: string;
} | null> {
  const resolution = await resolveGithubAppCredentials(database.db, {
    opener: config.credentialMasterKey
      ? createCredentialCipher(config.credentialMasterKey)
      : null,
    env: {
      appId: config.githubAppId,
      privateKeyPath: config.githubAppPrivateKeyPath,
    },
  });
  if (resolution.outcome === "ok") return resolution.credentials;
  if (resolution.outcome === "decrypt_failed") {
    // 主密钥换过、缺失，或记录被篡改：不静默回退到环境变量，否则用户会以为
    // 界面里保存的凭据在生效。
    logger.error(
      { reason: resolution.reason },
      "stored GitHub App private key could not be used",
    );
  }
  return null;
}

/** 当前 GitHub App 客户端；WebUI 保存新凭据后会被重建。 */
let githubClientPromise: Promise<GitHubClient | null> = buildGithubClient();

async function buildGithubClient(): Promise<GitHubClient | null> {
  try {
    const credentials = await loadGithubAppCredentials();
    if (!credentials) return null;
    return createGitHubClient({
      appId: credentials.appId,
      privateKeyPem: credentials.privateKeyPem,
      ...(config.githubApiBaseUrl
        ? { apiBaseUrl: config.githubApiBaseUrl }
        : {}),
    });
  } catch (error) {
    logger.warn({ err: error }, "GitHub App client initialization failed");
    return null;
  }
}

/** 保存凭据后立即重建，无需重启容器。 */
function reloadGithubClient(): void {
  githubClientPromise = buildGithubClient();
}

/* ---------- GitHub OAuth (progressive; enabled when configured) ---------- */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** In-memory OAuth `state` → expiry, verified in the callback. */
const oauthStates = new Map<string, number>();

/**
 * Effective OAuth credentials: runtime settings (`oauth_client_id` /
 * `oauth_client_secret`) override, then env. This lets the install wizard
 * generate and store an OAuth secret without an env restart.
 */
function currentOAuth(): { clientId: string; clientSecret: string } {
  return {
    clientId:
      runtimeSettings.get("oauth_client_id") ||
      process.env.GITHUB_OAUTH_CLIENT_ID ||
      "",
    clientSecret:
      runtimeSettings.get("oauth_client_secret") ||
      process.env.GITHUB_OAUTH_CLIENT_SECRET ||
      "",
  };
}

function oauthConfigured(): boolean {
  const { clientId, clientSecret } = currentOAuth();
  return Boolean(clientId && clientSecret);
}

/**
 * OAuth redirect URI resolution order:
 *  1. explicit OAUTH_REDIRECT_URI env (most reliable — e.g. behind a reverse
 *     proxy that rewrites Host or terminates TLS), then
 *  2. derive from X-Forwarded-Proto + Host for direct/localhost deployments.
 */
function oauthRedirectUri(request: IncomingMessage): string {
  const explicit = process.env.OAUTH_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  const proto = request.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  const host = request.headers.host ?? "localhost";
  return `${proto}://${host}/auth/callback`;
}

function signSession(login: string): string {
  const { clientId, clientSecret } = currentOAuth();
  return createSessionSigner({
    clientId,
    clientSecret,
    ttlMs: SESSION_TTL_MS,
  }).sign(login);
}

function parseSessionToken(token: string): string | null {
  const { clientId, clientSecret } = currentOAuth();
  if (!clientId || !clientSecret) return null;
  return createSessionSigner({
    clientId,
    clientSecret,
    ttlMs: SESSION_TTL_MS,
  }).parse(token);
}

/* ---------- runtime settings (hot-reload overrides) ---------- */
const SETTINGS_POLL_MS = 8_000;
// 密钥集与写白名单都从注册表派生：此前它们在 api 里手写，且与 GET 列表分开维护、
// 已经漂移（pr_check_run 曾能画开关却存不了）。注册表是唯一事实源。
const SECRET_KEYS = SECRET_SETTING_KEYS;
const WRITABLE_SETTING_KEYS = new Set<string>(ALLOWED_SETTING_KEYS);

const runtimeSettings = new Map<string, string>();

/** Syncs the in-memory override map from the `system_settings` table. */
async function refreshRuntimeSettings(): Promise<void> {
  try {
    const rows = await database.db
      .select({ key: systemSettings.key, value: systemSettings.value })
      .from(systemSettings);
    runtimeSettings.clear();
    for (const row of rows) runtimeSettings.set(row.key, row.value);
    // 经注册表校验：DB 里存了非法值（比如手填 foo）时不该污染日志系统。
    logger.level = parseLogLevel(
      runtimeSettings.get("log_level"),
      config.logLevel,
    );
    logger.debug(
      { keys: rows.map((row) => row.key), count: rows.length },
      "runtime settings refreshed",
    );
  } catch (error) {
    logger.warn({ err: error }, "runtime settings refresh failed");
  }
}

function startRuntimeSettings(): void {
  void refreshRuntimeSettings();
  setInterval(() => void refreshRuntimeSettings(), SETTINGS_POLL_MS);
}

/** Effective WebUI token: settings override; falls back to env/./env.example. */
function webuiToken(): string {
  const override = runtimeSettings.get("webui_api_token");
  if (override && override.trim().length > 0) return override;
  return config.webuiApiToken ?? "";
}

/** Effective webhook secret + enabled flag, both runtime-overridable. */
function webhookSecret(): string {
  const override = runtimeSettings.get("github_webhook_secret");
  if (override && override.trim().length > 0) return override;
  return config.githubWebhookSecret ?? "";
}
function webhookEnabled(): boolean {
  const override = runtimeSettings.get("github_webhook_enabled");
  if (override !== undefined && override !== "") return override === "true";
  return Boolean(config.githubWebhookSecret);
}

/** Effective alert webhook URL: runtime setting overrides env; empty = disabled. */
function alertWebhookUrl(): string {
  const override = runtimeSettings.get("alert_webhook_url");
  if (override && override.trim().length > 0) return override.trim();
  return (process.env.ALERT_WEBHOOK_URL ?? "").trim();
}

/** Effective alert thresholds: runtime settings override; env; app default. */
function alertThresholds(): AlertThresholds {
  const num = (key: string, fallback: number): number => {
    const raw = runtimeSettings.get(key) || process.env[`${key.toUpperCase()}`];
    if (!raw || raw.trim().length === 0) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    queueBacklog: num(
      "alert_queue_backlog_threshold",
      DEFAULT_ALERT_THRESHOLDS.queueBacklog,
    ),
    failedTasks: num(
      "alert_failed_tasks_threshold",
      DEFAULT_ALERT_THRESHOLDS.failedTasks,
    ),
    staleTasks: num(
      "alert_stale_tasks_threshold",
      DEFAULT_ALERT_THRESHOLDS.staleTasks,
    ),
  };
}

/** Effective embedding config: runtime settings override, then env. */
function embeddingConfig(): {
  baseUrl: string;
  apiKey: string;
  model: string;
} {
  return {
    baseUrl:
      runtimeSettings.get("embedding_base_url") ||
      config.embedding.baseUrl ||
      "",
    apiKey:
      runtimeSettings.get("embedding_api_key") ||
      config.embedding.apiKey ||
      "",
    model:
      runtimeSettings.get("embedding_model") || config.embedding.model,
  };
}

/** Effective QQ bot config: runtime settings override, then env. */
function qqConfig(): {
  protocols: Record<string, unknown>;
  officialAppId: string;
  officialAppSecret: string;
  officialGatewayUrl: string;
  officialIntents: string;
} {
  const protocolsRaw = runtimeSettings.get("qq_bot_protocols");
  let protocols: Record<string, unknown> = config.qqBotProtocols;
  if (protocolsRaw && protocolsRaw.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(protocolsRaw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
        protocols = parsed as Record<string, unknown>;
    } catch {
      // keep the env value when the stored JSON is malformed
    }
  }
  return {
    protocols,
    officialAppId:
      runtimeSettings.get("qq_official_app_id") ||
      config.qqOfficialAppId ||
      "",
    officialAppSecret:
      runtimeSettings.get("qq_official_app_secret") ||
      config.qqOfficialAppSecret ||
      "",
    officialGatewayUrl:
      runtimeSettings.get("qq_official_gateway_url") ||
      config.qqOfficialGatewayUrl ||
      "",
    officialIntents:
      runtimeSettings.get("qq_official_intents") ||
      String(config.qqOfficialIntents),
  };
}

/** Upserts a runtime setting row and hot-reloads the in-memory map. */
async function upsertSetting(key: string, value: string): Promise<void> {
  await database.db
    .insert(systemSettings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value, updatedAt: new Date() },
    });
  await refreshRuntimeSettings();
}

/** Open SSE connections so shutdown can end them and exit cleanly. */
const sseClients = new Set<ServerResponse>();

/* ---------- per-IP in-memory rate limiting (sliding token bucket) ---------- */
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, { tokens: number; last: number }>();

/**
 * Returns true when the client has exceeded the per-minute budget. The bucket
 * refills fully each window; the map is pruned once it grows beyond a bound so
 * a hostile flood of source IPs cannot leak memory indefinitely.
 */
function rateLimited(ip: string, limit: number, now: number): boolean {
  if (rateBuckets.size > 10_000) {
    for (const [key, bucket] of rateBuckets) {
      if (now - bucket.last >= RATE_WINDOW_MS) rateBuckets.delete(key);
    }
  }
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.last >= RATE_WINDOW_MS) {
    rateBuckets.set(ip, { tokens: Math.max(limit - 1, 0), last: now });
    return false;
  }
  if (bucket.tokens <= 0) return true;
  bucket.tokens -= 1;
  return false;
}

function clientIp(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0)
    return forwarded.split(",")[0]!.trim();
  return request.socket.remoteAddress ?? "unknown";
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Routes that require the WebUI bearer token when it is configured. */
const protectedPaths = [
  "/tasks",
  "/summary",
  "/results",
  "/providers",
  "/repositories",
  "/logs",
  "/vector",
  "/index",
  "/backup",
  "/label-rules",
  "/auth/me",
  "/users",
  "/audit",
  "/config",
  "/settings",
  "/capabilities",
  "/events",
  "/memory",
  "/update",
  "/scans",
  "/bot",
  "/repo-rules",
  // 独立自检路径（不能写成 /github/webhook —— 那是 GitHub 公开投递入口）。
  "/webhook-selftest",
  // 方向七：仓库可见性授权管理（admin）。
  "/grants",
];
const EVENT_CHANNEL = "apertureprism:task:events";

/** Auth is disabled when no WebUI token is configured (open dev / intranet mode). */
function isAuthorized(request: IncomingMessage): boolean {
  const expected = webuiToken();
  if (!expected) return true;
  let token: string | null = null;
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer "))
    token = header.slice(7);
  if (token === null) {
    const url = new URL(request.url ?? "/", "http://localhost");
    token = url.searchParams.get("token");
  }
  // 方向四A：HttpOnly cookie 里的会话 token 也可鉴权（SSE/同源请求无需带 header）。
  if (token === null || token.length === 0) {
    token = sessionCookieToken(request);
  }
  if (token === null || token.length === 0) return false;
  if (
    token.length === expected.length &&
    timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  )
    return true;
  // 签名会话 token（GitHub OAuth 或本地密码登录）同样放行。会话有效性
  // 由 user_sessions 校验（落库后可过期/吊销），此处接受有效签名即可。
  return parseSessionToken(token) !== null;
}

const requiresAuth = (path: string): boolean =>
  protectedPaths.some((base) => path === base || path.startsWith(`${base}/`));

function json(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  requestId: string,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "x-request-id": requestId,
  });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/* ---------- Issue/PR comment command triggers ---------- */

const ISSUE_COMMAND_HELP = [
  "可用的指令（直接在 Issue / PR 评论里输入）：",
  "- `/analyze` 或 `/apertureprism analyze` — 触发 Issue 分析",
  "- `/review` 或 `/apertureprism review` — 触发 PR 代码审查（需在 PR 评论中）",
  "- `/help` 或 `/apertureprism help` — 显示本帮助",
].join("\n");

type CommentCommandOutcome =
  | { kind: "none" }
  | { kind: "help" }
  | {
      kind: "triggered";
      taskType: "issue_analysis" | "pr_review";
      taskId: string;
    }
  | { kind: "error"; reason: string };

/**
 * Reacts to `issue_comment` webhooks that carry a trigger command
 * (`/analyze`, `/review`, `/help`). Creates the matching task and replies with
 * an acknowledgement comment. Bot-authored comments are ignored to avoid
 * reply loops; comment posting failures are logged and never fail the webhook.
 */
async function handleIssueCommentCommand(
  event: NormalizedGitHubEvent,
): Promise<CommentCommandOutcome> {
  const payload = (event.payload ?? {}) as {
    comment?: { body?: string };
    issue?: { pull_request?: unknown };
    sender?: { type?: string };
  };
  if (payload.sender?.type === "Bot") return { kind: "none" };
  const command = parseIssueCommand(payload.comment?.body ?? "");
  if (command.kind === "none") return { kind: "none" };

  const fullName = event.repositoryFullName ?? "";
  const identity = repositoryOwnerName(fullName);
  const issueNumber = event.subjectNumber;
  if (!identity || issueNumber === null)
    return { kind: "error", reason: "missing_repository_context" };
  const subjectNumber: number = issueNumber;
  const owner = identity.owner;
  const repoName = identity.name;
  const rows = await database.db
    .select({
      id: repositories.id,
      githubId: repositories.githubId,
      installationId: repositories.installationId,
    })
    .from(repositories)
    .where(
      and(
        eq(repositories.owner, owner),
        eq(repositories.name, repoName),
      ),
    )
    .limit(1);
  const repo = rows[0];
  if (!repo || !repo.installationId)
    return { kind: "error", reason: "repository_not_installed" };
  const installationId = repo.installationId;
  const github = await githubClientPromise;

  const postComment = (body: string): void => {
    if (!github) return;
    void github
      .createIssueComment({
        installationId,
        owner,
        name: repoName,
        number: subjectNumber,
        body,
      })
      .catch((error: unknown) =>
        logger.warn({ err: error }, "command ack comment failed"),
      );
  };

  if (command.kind === "help") {
    void postComment(ISSUE_COMMAND_HELP);
    return { kind: "help" };
  }

  if (command.kind === "analyze") {
    const subjectRevision = new Date().toISOString();
    const result = await createAnalysisTask(database.db, {
      taskType: "issue_analysis",
      repositoryId: repo.id,
      subjectNumber: issueNumber,
      subjectRevision,
      policyVersion: ISSUE_ANALYSIS_POLICY_VERSION,
      dedupeKey: `issue-analysis:${repo.id}:${issueNumber}:${subjectRevision}:${ISSUE_ANALYSIS_POLICY_VERSION}`,
      payload: {
        installationId: repo.installationId,
        repositoryExternalId: repo.githubId,
        repositoryFullName: fullName,
        subjectNumber: issueNumber,
        subjectRevision,
        sourceEvent: "issue_comment_command",
        command: "analyze",
      },
    });
    void postComment(
      `已触发 Issue 分析，结果将发布为本 Issue 的评论（任务 ${result.task.id.slice(0, 8)}）。`,
    );
    return {
      kind: "triggered",
      taskType: "issue_analysis",
      taskId: result.task.id,
    };
  }

  // review: only valid on pull requests; needs the PR head SHA as revision.
  if (!github) {
    void postComment("GitHub App 未配置，无法触发 PR 审查。");
    return { kind: "error", reason: "github_not_configured" };
  }
  if (!payload.issue?.pull_request) {
    void postComment("该评论所在的对象不是 Pull Request，无法触发代码审查。");
    return { kind: "error", reason: "not_a_pull_request" };
  }
  try {
    const pullRequest = await github.getPullRequest({
      installationId: repo.installationId,
      owner: identity.owner,
      name: identity.name,
      number: issueNumber,
    });
    const subjectRevision = pullRequest.headSha;
    const result = await createAnalysisTask(database.db, {
      taskType: "pr_review",
      repositoryId: repo.id,
      subjectNumber: issueNumber,
      subjectRevision,
      policyVersion: PR_REVIEW_POLICY_VERSION,
      dedupeKey: `pr-review:${repo.id}:${issueNumber}:${subjectRevision}:${PR_REVIEW_POLICY_VERSION}`,
      payload: {
        installationId: repo.installationId,
        repositoryExternalId: repo.githubId,
        repositoryFullName: fullName,
        subjectNumber: issueNumber,
        subjectRevision,
        sourceEvent: "issue_comment_command",
        command: "review",
      },
    });
    void postComment(
      `已触发 PR 代码审查，结果将发布为该 PR 的 Review（任务 ${result.task.id.slice(0, 8)}）。`,
    );
    return {
      kind: "triggered",
      taskType: "pr_review",
      taskId: result.task.id,
    };
  } catch (error) {
    logger.warn({ err: error }, "command review trigger failed");
    void postComment("触发 PR 审查失败：无法读取该 PR 的最新提交。");
    return { kind: "error", reason: "pr_fetch_failed" };
  }
}

/**
 * Webhook 自检（issue #22/#23 排查经验的沉淀）：GitHub 侧路径配错、签名不一致、
 * 入口不通，这三类故障此前只能靠人肉对比配置 + 手工 curl。GitHub 不提供可程序化
 * 触发的 App 级 ping（/app/hook/ping|pings 均 404），自检改为两步：读 GitHub 侧
 * 实际配置 + 统计最近投递的成功率，据此给出中文诊断。
 */
async function handleWebhookSelfTest(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const github = await githubClientPromise;
  if (!github) {
    json(
      response,
      503,
      { status: "error", reason: "github_app_not_configured" },
      requestId,
    );
    return;
  }
  try {
    // 第一步：GitHub 侧实际配置（URL 错误是最常见根因）。
    const hookConfig = await github.getWebhookConfig();
    // 第二步：最近投递记录（新→旧）的成功率。
    const deliveries = await github.listRecentWebhookDeliveries();
    const recent = deliveries.slice(0, 5);
    const okCount = recent.filter(
      (entry) => entry.statusCode !== null && entry.statusCode < 400,
    ).length;
    const latest = recent[0] ?? null;

    const urlLooksRight = hookConfig.url.endsWith("/github/webhook");
    let diagnosis: string;
    if (!urlLooksRight) {
      diagnosis = `webhook URL 应以 /github/webhook 结尾，当前为「${hookConfig.url || "（空）"}」——这是投递失败最常见的原因，请在 GitHub App 设置页修正`;
    } else if (recent.length === 0) {
      diagnosis =
        "配置正确但还没有任何投递记录：新建或编辑一个 Issue 即会产生事件，几秒后再点一次自检";
    } else if (okCount === recent.length) {
      diagnosis = `链路正常：最近 ${recent.length} 次投递全部成功（最新 ${latest?.event} → ${latest?.statusCode}）`;
    } else {
      const lastFail = recent.find((entry) => entry.statusCode !== null && entry.statusCode >= 400);
      diagnosis = `最近 ${recent.length} 次投递中 ${recent.length - okCount} 次失败（如 ${lastFail?.event} → ${lastFail?.statusCode}）：签名不一致通常表现为非 2xx，请核对 Webhook 签名密钥与 env 是否一致`;
    }

    audit(request, "webhook.selftest", hookConfig.url, {
      urlLooksRight,
      okCount,
      total: recent.length,
    });
    json(
      response,
      200,
      {
        status: "ok",
        webhookUrl: hookConfig.url,
        urlLooksRight,
        contentType: hookConfig.contentType,
        recentDeliveries: recent.map((entry) => ({
          event: entry.event,
          statusCode: entry.statusCode,
          deliveredAt: entry.deliveredAt,
        })),
        diagnosis,
      },
      requestId,
    );
  } catch (error) {
    logger.warn({ err: error }, "webhook self-test failed");
    json(
      response,
      502,
      {
        status: "error",
        reason: "selftest_failed",
        detail: error instanceof Error ? error.message : String(error),
      },
      requestId,
    );
  }
}

async function handleWebhook(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  if (!webhookEnabled()) {
    json(
      response,
      503,
      { status: "error", reason: "GitHub webhook is not enabled" },
      requestId,
    );
    return;
  }
  const body = await readBody(request);
  try {
    // 轮换宽限期内双密钥接收：先用当前密钥验签，失败再试旧值（换密钥时对端
    // 可能还在用旧密钥推送）。
    const signature =
      typeof request.headers["x-hub-signature-256"] === "string"
        ? request.headers["x-hub-signature-256"]
        : undefined;
    const secrets = [webhookSecret()];
    try {
      // 轮换回退是增强：数据库不可用时（如测试/启动早期）不阻塞验签。
      const previous = await readPreviousValueWithinGrace(
        database.db,
        "github_webhook_secret",
      );
      if (previous) secrets.push(previous);
    } catch {
      // best-effort：继续只用当前密钥验签。
    }
    let verified = false;
    let lastError: unknown;
    for (const secret of secrets) {
      try {
        verifyWebhookSignature(body, signature, secret);
        verified = true;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!verified) throw lastError;
    const deliveryId = request.headers["x-github-delivery"]?.toString();
    const eventName = request.headers["x-github-event"]?.toString();
    if (!deliveryId || !eventName) {
      json(
        response,
        400,
        { status: "error", reason: "missing GitHub webhook headers" },
        requestId,
      );
      return;
    }
    const normalized = normalizeGitHubEvent(
      eventName,
      deliveryId,
      JSON.parse(body.toString("utf8")),
    );
    const policyVersion =
      normalized.eventName === "pull_request"
        ? PR_REVIEW_POLICY_VERSION
        : ISSUE_ANALYSIS_POLICY_VERSION;
    const result = await ingestGitHubWebhook(
      database.db,
      normalized,
      policyVersion,
    );
    metrics.increment("webhook.deliveries");
    metrics.increment(`webhook.outcome.${result.outcome}`);
    // Issue/PR comment commands (e.g. "/apertureprism analyze") trigger tasks.
    const commandOutcome =
      normalized.eventName === "issue_comment"
        ? await handleIssueCommentCommand(normalized)
        : { kind: "none" as const };
    const duplicate = result.outcome === "delivery_duplicate";
    json(
      response,
      duplicate ? 200 : 202,
      {
        status: "accepted",
        duplicate,
        outcome: result.outcome,
        ...("taskId" in result ? { taskId: result.taskId } : {}),
        ...commandOutcome,
      },
      requestId,
    );
  } catch (error) {
    if (error instanceof WebhookSignatureError) {
      json(
        response,
        401,
        { status: "error", reason: "invalid webhook signature" },
        requestId,
      );
      return;
    }
    if (error instanceof SyntaxError) {
      json(
        response,
        400,
        { status: "error", reason: "invalid JSON payload" },
        requestId,
      );
      return;
    }
    // 不在处理范围的事件（check_suite / check_run / workflow_run 等，GitHub App
    // 订阅 check_suite 用于 PR 审查的 check run）必须 2xx 确认收讫，否则 GitHub
    // 记为投递失败并重试，Webhook 自检的最近投递成功率会常年被这些噪声拉低
    // （NAS 实测：最近 5 条投递全是 check_suite → 500，误报「签名不一致」）。
    if (error instanceof UnsupportedGitHubEventError) {
      metrics.increment("webhook.unsupported_event");
      json(
        response,
        202,
        {
          status: "accepted",
          outcome: "ignored",
          reason: "unsupported_event",
        },
        requestId,
      );
      return;
    }
    throw error;
  }
}

/** Monotonic sequence for SSE frames so clients can detect gaps. */
let sseSeq = 0;
/** Watermark of the last task_events row already dispatched. */
let eventWatermark: Date | null = null;
/**
 * Ids of task_events rows already dispatched. task_events has no monotonic
 * cursor column, and many events share the same createdAt millisecond, so a
 * pure createdAt watermark would re-emit the same rows every pump until a
 * newer event arrives. Deduping by row id keeps the relay exactly-once.
 */
const dispatchedEventIds = new Set<string>();
/** Bound on dispatchedEventIds so the watermark alone drives long-running pumps. */
const DISPATCHED_ID_CAP = 5_000;
let eventSubscriber: Awaited<ReturnType<typeof redis.duplicate>> | null = null;
let eventPublisher: Awaited<ReturnType<typeof redis.duplicate>> | null = null;
let hbTimer: ReturnType<typeof setInterval> | null = null;
let pumpTimer: ReturnType<typeof setInterval> | null = null;

/** Writes one SSE frame to every open client. */
function broadcastSse(seq: number, type: string, data: unknown): void {
  const frame = serializeSseEvent({ seq, type, data });
  for (const client of sseClients) client.write(frame);
}

/**
 * Keeps an SSE connection open; frames are broadcast by the shared relay.
 * `?since=<iso>` replays historical task events created after the bookmark
 * before going live, so a reconnect can backfill events missed while offline.
 */
async function handleSse(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  response.writeHead(200, SSE_HEADERS);
  response.write(": connected\n\n");

  const url = new URL(request.url ?? "/", "http://localhost");
  const sinceRaw = url.searchParams.get("since");
  if (sinceRaw && !Number.isNaN(Date.parse(sinceRaw))) {
    try {
      const since = new Date(sinceRaw);
      const rows = await database.db
        .select({
          id: taskEvents.id,
          taskId: taskEvents.taskId,
          eventType: taskEvents.eventType,
          data: taskEvents.data,
          createdAt: taskEvents.createdAt,
        })
        .from(taskEvents)
        .where(gt(taskEvents.createdAt, since))
        .orderBy(asc(taskEvents.createdAt))
        .limit(500);
      for (const row of rows) {
        sseSeq += 1;
        response.write(
          serializeSseEvent({
            seq: sseSeq,
            type: "task",
            data: {
              taskId: row.taskId,
              eventType: row.eventType,
              data: row.data,
              createdAt: row.createdAt,
              replayed: true,
            },
          }),
        );
      }
      logger.debug(
        { replayed: rows.length, since: sinceRaw },
        "SSE replay sent",
      );
    } catch (error) {
      logger.warn({ err: error }, "SSE replay failed; going live");
    }
  }

  sseClients.add(response);
  response.on("close", () => {
    sseClients.delete(response);
  });
}

/**
 * The event relay: poll `task_events` for new lifecycle events, publish them to
 * Redis, and forward every published frame to the open SSE clients. Best-effort:
 * if Redis or the database is unavailable the relay degrades to heartbeats only
 * and the API still starts.
 */
async function startEventStream(): Promise<void> {
  let relay = false;
  try {
    eventSubscriber = redis.duplicate();
    eventSubscriber.on("error", () => undefined);
    eventSubscriber.on("message", (_channel, message) => {
      try {
        const parsed = JSON.parse(message) as {
          seq: number;
          type: string;
          data: unknown;
        };
        const frame = serializeSseEvent(parsed);
        for (const client of sseClients) client.write(frame);
      } catch {
        // ignore malformed frames
      }
    });
    await eventSubscriber.connect();
    await eventSubscriber.subscribe(EVENT_CHANNEL);

    eventPublisher = redis.duplicate();
    eventPublisher.on("error", () => undefined);
    await eventPublisher.connect();
    relay = true;
  } catch (error) {
    logger.warn({ err: error }, "event relay disabled: Redis unavailable");
    eventSubscriber?.disconnect();
    eventPublisher?.disconnect();
    eventSubscriber = null;
    eventPublisher = null;
  }

  try {
    const max = await database.db
      .select({ at: taskEvents.createdAt })
      .from(taskEvents)
      .orderBy(desc(taskEvents.createdAt))
      .limit(1);
    eventWatermark = max[0]?.at ?? null;
  } catch {
    eventWatermark = null;
  }

  hbTimer = setInterval(() => {
    sseSeq += 1;
    broadcastSse(sseSeq, "heartbeat", { at: new Date().toISOString() });
  }, 15_000);

  if (relay) {
    pumpTimer = setInterval(() => {
      void pumpTaskEvents().catch((error: unknown) => {
        logger.warn({ err: error }, "task event pump failed");
      });
    }, 1_000);
  }
}

async function pumpTaskEvents(): Promise<void> {
  const rows = await database.db
    .select({
      id: taskEvents.id,
      taskId: taskEvents.taskId,
      eventType: taskEvents.eventType,
      data: taskEvents.data,
      createdAt: taskEvents.createdAt,
    })
    .from(taskEvents)
    .where(
      eventWatermark ? gt(taskEvents.createdAt, eventWatermark) : undefined,
    )
    .orderBy(asc(taskEvents.createdAt))
    .limit(200);
  let newest: Date | null = eventWatermark;
  for (const row of rows) {
    if (dispatchedEventIds.has(row.id)) continue;
    dispatchedEventIds.add(row.id);
    if (dispatchedEventIds.size > DISPATCHED_ID_CAP) {
      // Drop the oldest ids so the set stays bounded; the createdAt watermark
      // may briefly re-emit a colliding batch, which the client tolerates.
      const oldest = dispatchedEventIds.values().next().value;
      if (oldest !== undefined) dispatchedEventIds.delete(oldest);
    }
    sseSeq += 1;
    const evt = {
      seq: sseSeq,
      type: "task",
      data: {
        taskId: row.taskId,
        eventType: row.eventType,
        data: row.data,
        createdAt: row.createdAt,
      },
    };
    if (eventPublisher)
      await eventPublisher.publish(EVENT_CHANNEL, JSON.stringify(evt));
    if (!newest || row.createdAt > newest) newest = row.createdAt;
  }
  if (newest) eventWatermark = newest;
}

async function stopEventStream(): Promise<void> {
  if (hbTimer) clearInterval(hbTimer);
  if (pumpTimer) clearInterval(pumpTimer);
  for (const client of sseClients) client.end();
  sseClients.clear();
  if (eventSubscriber) {
    try {
      await eventSubscriber.unsubscribe(EVENT_CHANNEL);
      await eventSubscriber.quit();
    } catch {
      eventSubscriber.disconnect();
    }
  }
  if (eventPublisher) {
    try {
      await eventPublisher.quit();
    } catch {
      eventPublisher.disconnect();
    }
  }
}

/** Column set shared by the list and detail views (payload is heavy). */
const taskSummaryColumns = {
  id: analysisTasks.id,
  taskType: analysisTasks.taskType,
  repositoryId: analysisTasks.repositoryId,
  subjectNumber: analysisTasks.subjectNumber,
  subjectRevision: analysisTasks.subjectRevision,
  policyVersion: analysisTasks.policyVersion,
  status: analysisTasks.status,
  priority: analysisTasks.priority,
  attemptCount: analysisTasks.attemptCount,
  maxAttempts: analysisTasks.maxAttempts,
  lastErrorCategory: analysisTasks.lastErrorCategory,
  createdAt: analysisTasks.createdAt,
  updatedAt: analysisTasks.updatedAt,
} as const;

/**
 * Lists tasks (cursor-paginated by creation time, newest first) or returns a
 * single task by id. Public reads for the WebUI; no secrets are exposed (the
 * task payload is only included in the detail view).
 */
async function handleTasks(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  const path = url.pathname;
  const id = path.startsWith("/tasks/")
    ? decodeURIComponent(path.slice("/tasks/".length)).trim()
    : null;

  // A well-formed task id is a UUID. Guard the detail lookup so a short or
  // malformed id (e.g. /tasks/1) returns 404 instead of a Postgres uuid parse
  // error bubbling up as a 500.
  if (
    id &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    json(
      response,
      404,
      { status: "error", reason: "task not found" },
      requestId,
    );
    return;
  }

  if (!id) {
    const limitRaw = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200)
      : 50;
    // Offset pagination is stable even when many rows share the same
    // createdAt millisecond (a pure createdAt cursor would skip duplicates).
    const offsetRaw = Number(url.searchParams.get("offset"));
    const offset = Number.isFinite(offsetRaw)
      ? Math.max(Math.trunc(offsetRaw), 0)
      : 0;
    // 方向七：非 admin 仅列出被授权仓库的任务。
    const scope = await visibleRepoScope(request);
    const items = await database.db
      .select(taskSummaryColumns)
      .from(analysisTasks)
      .where(
        scope && scope.ids !== null
          ? inArray(analysisTasks.repositoryId, [...scope.ids])
          : undefined,
      )
      .orderBy(desc(analysisTasks.createdAt), desc(analysisTasks.id))
      .limit(limit)
      .offset(offset);
    const nextOffset = items.length === limit ? offset + limit : undefined;
    json(
      response,
      200,
      nextOffset === undefined ? { items } : { items, nextOffset },
      requestId,
    );
    return;
  }

  const rows = await database.db
    .select({ ...taskSummaryColumns, payload: analysisTasks.payload })
    .from(analysisTasks)
    .where(eq(analysisTasks.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    json(
      response,
      404,
      { status: "error", reason: "task not found" },
      requestId,
    );
    return;
  }
  // 方向七：非 admin 只能查看被授权仓库的任务详情。
  if (row.repositoryId) {
    const login = sessionLogin(request);
    if (login) {
      const user = await getUser(database.db, login);
      if (user && !user.isAdmin && !(await canAccessGrant(database.db, login, row.repositoryId, "view"))) {
        json(
          response,
          404,
          { status: "error", reason: "task not found" },
          requestId,
        );
        return;
      }
    }
  }
  const [timeline, attempts, publications] = await Promise.all([
    database.db
      .select({
        eventType: taskEvents.eventType,
        data: taskEvents.data,
        createdAt: taskEvents.createdAt,
      })
      .from(taskEvents)
      .where(eq(taskEvents.taskId, id))
      .orderBy(asc(taskEvents.createdAt))
      .limit(200),
    database.db
      .select({
        attemptNumber: taskAttempts.attemptNumber,
        workerId: taskAttempts.workerId,
        startedAt: taskAttempts.startedAt,
        finishedAt: taskAttempts.finishedAt,
        errorCategory: taskAttempts.errorCategory,
      })
      .from(taskAttempts)
      .where(eq(taskAttempts.taskId, id))
      .orderBy(asc(taskAttempts.attemptNumber)),
    database.db
      .select({
        channel: externalPublications.channel,
        externalObjectId: externalPublications.externalObjectId,
        createdAt: externalPublications.createdAt,
      })
      .from(externalPublications)
      .where(eq(externalPublications.taskId, id))
      .orderBy(asc(externalPublications.createdAt)),
  ]);
  json(response, 200, { ...row, timeline, attempts, publications }, requestId);
}

/**
 * Manual task trigger (POST /tasks/manual). Looks up the installed repository
 * by owner/name, resolves the subject revision (PR head SHA via GitHub, or the
 * current time for issues), and enqueues an analysis/review task shaped exactly
 * like a webhook-derived task.
 */
async function handleManualTask(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const body = await readBody(request);
  let parsed: { type?: unknown; repositoryFullName?: unknown; subjectNumber?: unknown };
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    json(response, 400, { status: "error", reason: "invalid JSON" }, requestId);
    return;
  }
  const type = parsed.type;
  if (type !== "issue" && type !== "pr") {
    json(
      response,
      400,
      { status: "error", reason: "type must be 'issue' or 'pr'" },
      requestId,
    );
    return;
  }
  const repositoryFullName =
    typeof parsed.repositoryFullName === "string"
      ? parsed.repositoryFullName.trim()
      : "";
  const identity = repositoryOwnerName(repositoryFullName);
  if (!identity) {
    json(
      response,
      400,
      { status: "error", reason: "repositoryFullName must be owner/repo" },
      requestId,
    );
    return;
  }
  const subjectNumber = parsed.subjectNumber;
  if (
    typeof subjectNumber !== "number" ||
    !Number.isInteger(subjectNumber) ||
    subjectNumber <= 0
  ) {
    json(
      response,
      400,
      { status: "error", reason: "subjectNumber must be a positive integer" },
      requestId,
    );
    return;
  }

  const rows = await database.db
    .select({
      id: repositories.id,
      githubId: repositories.githubId,
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
  let subjectRevision: string;
  if (type === "pr") {
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
      const pullRequest = await github.getPullRequest({
        installationId: repo.installationId,
        owner: identity.owner,
        name: identity.name,
        number: subjectNumber,
      });
      subjectRevision = pullRequest.headSha;
    } catch (error) {
      if (error instanceof GitHubApiError) {
        const reason =
          error.category === "not_found" ? "pull_request_not_found" : error.category;
        json(response, 400, { status: "error", reason }, requestId);
        return;
      }
      throw error;
    }
  } else {
    subjectRevision = new Date().toISOString();
  }

  const policyVersion =
    type === "issue" ? ISSUE_ANALYSIS_POLICY_VERSION : PR_REVIEW_POLICY_VERSION;
  const taskType = type === "issue" ? "issue_analysis" : "pr_review";
  const keyPrefix = type === "issue" ? "issue-analysis" : "pr-review";
  const result = await createAnalysisTask(database.db, {
    taskType,
    repositoryId: repo.id,
    subjectNumber,
    subjectRevision,
    policyVersion,
    dedupeKey: `${keyPrefix}:${repo.id}:${subjectNumber}:${subjectRevision}:${policyVersion}`,
    payload: {
      installationId: repo.installationId,
      repositoryExternalId: repo.githubId,
      repositoryFullName,
      subjectNumber,
      subjectRevision,
      sourceEvent: "manual",
    },
  });

  audit(request, "task.manual_trigger", repositoryFullName, {
    type,
    subjectNumber,
  });
  json(
    response,
    200,
    { status: "ok", taskId: result.task.id, outcome: result.outcome },
    requestId,
  );
}

/**
 * Re-queues finished tasks (failed / canceled) for another run. Accepts a list
 * of task ids; each is reset to `queued` with a fresh attempt budget. Tasks in
 * non-finished states are skipped, not errored. Admin only.
 */
async function handleTaskRerun(
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
  const body = await readBody(request);
  let parsed: { taskIds?: unknown };
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    json(response, 400, { status: "error", reason: "invalid JSON" }, requestId);
    return;
  }
  const ids = Array.isArray(parsed.taskIds)
    ? parsed.taskIds.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
  if (ids.length === 0) {
    json(
      response,
      400,
      { status: "error", reason: "taskIds must be a non-empty array" },
      requestId,
    );
    return;
  }
  let rerun = 0;
  let skipped = 0;
  for (const taskId of ids) {
    const ok = await resetTaskToQueued(database.db, { taskId });
    if (ok) rerun += 1;
    else skipped += 1;
  }
  audit(request, "task.rerun", undefined, { taskIds: ids.length, rerun, skipped });
  json(response, 200, { status: "ok", rerun, skipped }, requestId);
}

/**
 * POST /tasks/cancel — manually cancel running tasks from the WebUI.
 *
 * Mirrors handleTaskRerun: admin-only, batch by taskIds, reports how many were
 * actually canceled vs skipped. A task is only canceled when it is in a
 * non-terminal state (queued/leased/running/publishing/retry_wait); tasks
 * already completed/failed/canceled are skipped. Running workers notice the
 * cleared lease on their next heartbeat and stop (see runOnce lease_lost path).
 */
async function handleTaskCancel(
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
  const body = await readBody(request);
  let parsed: { taskIds?: unknown };
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    json(response, 400, { status: "error", reason: "invalid JSON" }, requestId);
    return;
  }
  const ids = Array.isArray(parsed.taskIds)
    ? parsed.taskIds.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
  if (ids.length === 0) {
    json(
      response,
      400,
      { status: "error", reason: "taskIds must be a non-empty array" },
      requestId,
    );
    return;
  }
  let canceled = 0;
  let skipped = 0;
  for (const taskId of ids) {
    const ok = await cancelTask(database.db, { taskId, reason: "manual_cancel" });
    if (ok) canceled += 1;
    else skipped += 1;
  }
  audit(request, "task.cancel", undefined, {
    taskIds: ids.length,
    canceled,
    skipped,
  });
  json(response, 200, { status: "ok", canceled, skipped }, requestId);
}

/**
 * GET /tasks/check-run?taskId=<uuid> — live status of a task's published
 * GitHub Check Run. Looks up the check_run publication for the task and
 * queries GitHub for its current status/conclusion so the WebUI can poll
 * without keeping an SSE channel open. Degrades gracefully (no publication /
 * GitHub unconfigured / GitHub error) with a `degraded` flag.
 */
async function handleTaskCheckRun(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  const taskId = url.searchParams.get("taskId") ?? "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      taskId,
    )
  ) {
    json(
      response,
      400,
      { status: "error", reason: "taskId must be a UUID" },
      requestId,
    );
    return;
  }

  const task = await database.db
    .select({ payload: analysisTasks.payload })
    .from(analysisTasks)
    .where(eq(analysisTasks.id, taskId))
    .limit(1);
  const payload = task[0]?.payload as
    | {
        installationId?: unknown;
        repositoryFullName?: unknown;
        subjectNumber?: unknown;
      }
    | null
    | undefined;
  if (!payload) {
    json(response, 404, { status: "error", reason: "task not found" }, requestId);
    return;
  }

  const publication = await database.db
    .select({ externalObjectId: externalPublications.externalObjectId })
    .from(externalPublications)
    .where(
      and(
        eq(externalPublications.taskId, taskId),
        eq(externalPublications.channel, "check_run"),
      ),
    )
    .limit(1);
  const checkRunId = Number(publication[0]?.externalObjectId ?? 0);
  if (!Number.isInteger(checkRunId) || checkRunId <= 0) {
    json(
      response,
      200,
      { status: "ok", present: false, degraded: false },
      requestId,
    );
    return;
  }

  const github = await githubClientPromise;
  const installationId = String(payload.installationId ?? "");
  const repositoryFullName = String(payload.repositoryFullName ?? "");
  const [owner, name] = repositoryFullName.split("/");
  if (!github || !installationId || !owner || !name) {
    json(
      response,
      200,
      { status: "ok", present: true, degraded: true },
      requestId,
    );
    return;
  }

  try {
    const run = await github.getCheckRun({
      installationId,
      owner,
      name,
      checkRunId,
    });
    json(
      response,
      200,
      {
        status: "ok",
        present: true,
        degraded: false,
        checkRun: {
          id: run.id,
          status: run.status,
          conclusion: run.conclusion,
          title: run.title,
          htmlUrl: run.htmlUrl,
        },
      },
      requestId,
    );
  } catch {
    json(
      response,
      200,
      { status: "ok", present: true, degraded: true },
      requestId,
    );
  }
}

/** Model role policies + configured provider account names (never the keys). */
async function handleProviders(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const [policies, accounts] = await Promise.all([
    database.db
      .select({
        role: modelRolePolicies.role,
        version: modelRolePolicies.version,
        candidates: modelRolePolicies.candidates,
        createdAt: modelRolePolicies.createdAt,
      })
      .from(modelRolePolicies)
      .orderBy(asc(modelRolePolicies.role)),
    database.db
      .select({ provider: providerAccounts.provider, name: providerAccounts.name })
      .from(providerAccounts)
      .orderBy(asc(providerAccounts.provider)),
  ]);
  // 为每个账户补上运行时保存的 baseUrl（用于编辑表单回填；未保存过的为空串）。
  const baseRows = await database.db
    .select({ key: systemSettings.key, value: systemSettings.value })
    .from(systemSettings)
    .where(like(systemSettings.key, "model_provider_base_url:%"));
  const baseByProvider = new Map<string, string>();
  for (const row of baseRows) {
    const provider = row.key.slice("model_provider_base_url:".length);
    baseByProvider.set(provider, row.value);
  }
  json(
    response,
    200,
    {
      policies,
      accounts: accounts.map((account) => ({
        provider: account.provider,
        name: account.name,
        baseUrl: baseByProvider.get(account.provider) ?? "",
      })),
    },
    requestId,
  );
}

/**
 * One-click revoke of a published AI analysis / review (D-stage interaction).
 * Removes the artifacts this app published for a given issue/PR: review is
 * dismissed, comments deleted, and the suggested labels removed. Best-effort:
 * a single artifact failing to revoke never blocks the rest.
 */
async function handleRevokeSubject(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const body = await readBody(request);
  let parsed: { repositoryFullName?: unknown; number?: unknown; type?: unknown };
  try {
    parsed = JSON.parse(body.toString("utf8"));
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
  if (!repositoryFullName || !Number.isInteger(subjectNumber) || subjectNumber <= 0) {
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
    json(response, 400, { status: "error", reason: "仓库格式应为 owner/name" }, requestId);
    return;
  }

  const repoRows = await database.db
    .select({ installationId: repositories.installationId })
    .from(repositories)
    .where(and(eq(repositories.owner, owner), eq(repositories.name, name)))
    .limit(1);
  const installationId = repoRows[0]?.installationId;
  if (!installationId) {
    json(response, 404, { status: "error", reason: "repository_not_installed" }, requestId);
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
    json(response, 404, { status: "error", reason: "未找到该对象的分析结果" }, requestId);
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
    json(response, 503, { status: "error", reason: "github_not_configured" }, requestId);
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
      ? result.suggestedLabels.filter((label): label is string => typeof label === "string")
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

/** Aggregated counts for the WebUI overview KPIs (status/type/result totals). */
async function handleSummary(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const [byStatus, byType, resultCounts] = await Promise.all([
    database.sql<{ status: string; count: number }[]>`
      SELECT status, count(*)::int AS count FROM analysis_tasks GROUP BY status
    `,
    database.sql<{ task_type: string; count: number }[]>`
      SELECT task_type, count(*)::int AS count FROM analysis_tasks GROUP BY task_type
    `,
    database.sql<{ subject_type: string; count: number }[]>`
      SELECT subject_type, count(*)::int AS count
      FROM subject_results WHERE published = true GROUP BY subject_type
    `,
  ]);
  const total = byStatus.reduce((sum, row) => sum + Number(row.count), 0);
  json(
    response,
    200,
    {
      tasks: {
        total,
        byStatus: Object.fromEntries(
          byStatus.map((row) => [row.status, Number(row.count)]),
        ),
        byType: Object.fromEntries(
          byType.map((row) => [row.task_type, Number(row.count)]),
        ),
      },
      results: {
        issue: Number(
          resultCounts.find((row) => row.subject_type === "issue")?.count ?? 0,
        ),
        pr: Number(
          resultCounts.find((row) => row.subject_type === "pr")?.count ?? 0,
        ),
      },
    },
    requestId,
  );
}

/** Installed GitHub repositories with per-repo task/result counts. */
async function handleRepositories(
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
async function handleRepositoryIssues(
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
    .select({ id: repositories.id, installationId: repositories.installationId })
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

const REPOSITORY_SYNC_INTERVAL_MS = 12 * 60 * 60 * 1_000; // 每 12 小时自动同步
let repositorySyncRunning = false;
let repositorySyncTimer: ReturnType<typeof setInterval> | null = null;
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
async function syncInstallations(): Promise<{
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
      return { installations: 0, synced: 0, errors: 1, details: [{ installationId: "-", reason: "github_not_configured" }] };
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
          rateLimitedUntil: new Date(repositorySyncRateLimitResetAt).toISOString(),
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
          const repos = await github.listInstallationRepositories(installationId);
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
          if (error instanceof GitHubApiError && error.category === "rate_limited") {
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
              rateLimitedUntil: new Date(repositorySyncRateLimitResetAt).toISOString(),
            };
          }
          if (attempt < 2) {
            logger.warn(
              { err: error, installationId, attempt: attempt + 1 },
              "installation repository sync failed, retrying with backoff",
            );
            await sleep(500 * (2 ** attempt));
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
 * 仓库审核规则功能页（WebUI 独立「审核规则」菜单）：
 *
 *   GET    /repo-rules                          → 所有仓库 + 规则状态摘要
 *   GET    /repo-rules/:id                      → 单仓库规则文件列表 + 开关状态
 *   GET    /repo-rules/:id/file?path=…          → 读取单个规则文件内容
 *   PUT    /repo-rules/:id/file                 → 创建 / 更新规则文件（body: path/content/sha?）
 *   DELETE /repo-rules/:id/file?path=…          → 删除规则文件
 *   POST   /repo-rules/:id/from-url             → 从 URL 拉取内容写入规则文件（body: url/path）
 *
 * 所有写操作都是 best-effort：GitHub 侧失败（无写权限 / sha 冲突）返回 400 带原因，
 * 不抛 500。读取失败（仓库无 rules 目录等）降级为空列表。
 */
async function handleRepoRulesRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://local");
  const path = url.pathname;
  const github = await githubClientPromise;

  // GET /repo-rules —— 所有仓库 + 规则状态。
  if (path === "/repo-rules" && request.method === "GET") {
    // 方向七：非 admin 仅能看到被授权仓库的规则状态。
    const scope = await visibleRepoScope(request);
    const repos = await database.db
      .select({
        id: repositories.id,
        owner: repositories.owner,
        name: repositories.name,
        installationId: repositories.installationId,
      })
      .from(repositories)
      .where(
        scope && scope.ids !== null
          ? inArray(repositories.id, [...scope.ids])
          : undefined,
      )
      .orderBy(asc(repositories.name));
    const items = await Promise.all(
      repos.map(async (repo) => {
        const enabled = await repoRulesEnabledFlag(repo.id);
        let hasRulesDir = false;
        let files: { name: string; path: string }[] = [];
        if (github && repo.installationId) {
          try {
            const entries = await github.listDirectory({
              installationId: repo.installationId,
              owner: repo.owner,
              name: repo.name,
              path: REPO_RULES_DIR,
              ref: "HEAD",
            });
            hasRulesDir = entries.length > 0;
            files = entries
              .filter((e) => e.type === "file" && e.name.endsWith(".md"))
              .map((e) => ({ name: e.name, path: e.path }));
          } catch {
            // 目录不存在或读取失败 → 视为没有规则目录。
          }
        }
        return {
          id: repo.id,
          owner: repo.owner,
          name: repo.name,
          fullName: `${repo.owner}/${repo.name}`,
          enabled,
          hasRulesDir,
          files,
        };
      }),
    );
    json(response, 200, { githubConfigured: github !== null, items }, requestId);
    return;
  }

  // /repo-rules/:id/... —— 单仓库操作。
  if (path.startsWith("/repo-rules/")) {
    const rest = path.slice("/repo-rules/".length);
    const seg = rest.split("/");
    const repositoryId = decodeURIComponent(seg[0] ?? "").trim();
    const action = seg[1] ?? "";
    if (!repositoryId || !UUID_PATTERN.test(repositoryId)) {
      json(response, 400, { status: "error", reason: "invalid repository id" }, requestId);
      return;
    }
    const repoRows = await database.db
      .select({
        id: repositories.id,
        owner: repositories.owner,
        name: repositories.name,
        installationId: repositories.installationId,
      })
      .from(repositories)
      .where(eq(repositories.id, repositoryId))
      .limit(1);
    const repo = repoRows[0];
    if (!repo) {
      json(response, 404, { status: "error", reason: "repository_not_found" }, requestId);
      return;
    }
    if (!github || !repo.installationId) {
      json(response, 400, { status: "error", reason: "github_not_configured" }, requestId);
      return;
    }
    const ghInput = {
      installationId: repo.installationId,
      owner: repo.owner,
      name: repo.name,
    };
    const repoInfo = {
      id: repo.id,
      owner: repo.owner,
      name: repo.name,
      fullName: `${repo.owner}/${repo.name}`,
    };

    // 获取默认分支。
    const defaultBranch = async (): Promise<string> => {
      try {
        const meta = await github.getRepository(ghInput);
        return meta?.defaultBranch ?? "main";
      } catch {
        return "main";
      }
    };

    // GET /repo-rules/:id —— 文件列表 + 开关。
    if (action === "" && request.method === "GET") {
      const enabled = await repoRulesEnabledFlag(repositoryId);
      const ref = await defaultBranch();
      let files: { name: string; path: string }[] = [];
      try {
        const entries = await github.listDirectory({ ...ghInput, path: REPO_RULES_DIR, ref });
        files = entries
          .filter((e) => e.type === "file" && e.name.toLowerCase().endsWith(".md"))
          .map((e) => ({ name: e.name, path: e.path }));
      } catch {
        // 目录不存在 → 空列表。
      }
      json(response, 200, { ...repoInfo, enabled, ref, files }, requestId);
      return;
    }

    // GET /repo-rules/:id/file?path=…
    if (action === "file" && request.method === "GET") {
      const filePath = decodeURIComponent(url.searchParams.get("path") ?? "").trim();
      if (!filePath) {
        json(response, 400, { status: "error", reason: "path required" }, requestId);
        return;
      }
      const ref = await defaultBranch();
      const file = await github.getFileContents({ ...ghInput, path: filePath, ref });
      if (!file) {
        json(response, 404, { status: "error", reason: "file_not_found" }, requestId);
        return;
      }
      json(response, 200, { path: filePath, content: file.content }, requestId);
      return;
    }

    // PUT /repo-rules/:id/file —— 创建 / 更新。
    if (action === "file" && request.method === "PUT") {
      if (!(await isAdminRequest(request))) {
        json(response, 403, { status: "error", reason: "admin required" }, requestId);
        return;
      }
      const raw = await readBody(request);
      let parsed: { path?: unknown; content?: unknown; sha?: unknown };
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        json(response, 400, { status: "error", reason: "invalid json" }, requestId);
        return;
      }
      const filePath = String(parsed.path ?? "").trim();
      const content = String(parsed.content ?? "");
      const sha = typeof parsed.sha === "string" && parsed.sha ? parsed.sha : undefined;
      if (!filePath) {
        json(response, 400, { status: "error", reason: "path required" }, requestId);
        return;
      }
      const ref = await defaultBranch();
      const ok = await github.writeFileContents({
        ...ghInput,
        path: filePath,
        ref,
        content,
        ...(sha ? { sha } : {}),
      });
      if (!ok) {
        json(response, 400, { status: "error", reason: "write_failed", detail: "文件已存在（更新需带 sha）或内容未变化" }, requestId);
        return;
      }
      json(response, 200, { status: "ok", path: filePath }, requestId);
      return;
    }

    // DELETE /repo-rules/:id/file?path=…
    if (action === "file" && request.method === "DELETE") {
      if (!(await isAdminRequest(request))) {
        json(response, 403, { status: "error", reason: "admin required" }, requestId);
        return;
      }
      const filePath = decodeURIComponent(url.searchParams.get("path") ?? "").trim();
      if (!filePath) {
        json(response, 400, { status: "error", reason: "path required" }, requestId);
        return;
      }
      const ref = await defaultBranch();
      // 需要当前 blob sha：先读文件。
      const file = await github.getFileContents({ ...ghInput, path: filePath, ref });
      if (!file || !file.sha) {
        json(response, 404, { status: "error", reason: "file_not_found" }, requestId);
        return;
      }
      const ok = await github.deleteFileContents({
        ...ghInput,
        path: filePath,
        ref,
        sha: file.sha,
      });
      if (!ok) {
        json(response, 400, { status: "error", reason: "delete_failed" }, requestId);
        return;
      }
      json(response, 200, { status: "ok", path: filePath }, requestId);
      return;
    }

    // POST /repo-rules/:id/from-url —— 从 URL 拉取内容写入。
    if (action === "from-url" && request.method === "POST") {
      if (!(await isAdminRequest(request))) {
        json(response, 403, { status: "error", reason: "admin required" }, requestId);
        return;
      }
      const raw = await readBody(request);
      let parsed: { url?: unknown; path?: unknown };
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        json(response, 400, { status: "error", reason: "invalid json" }, requestId);
        return;
      }
      const remoteUrl = String(parsed.url ?? "").trim();
      const filePath = String(parsed.path ?? "").trim();
      if (!remoteUrl || !filePath) {
        json(response, 400, { status: "error", reason: "url and path required" }, requestId);
        return;
      }
      let remoteText: string;
      try {
        const res = await fetch(remoteUrl, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) {
          json(response, 400, { status: "error", reason: "fetch_failed", detail: `URL 返回 ${res.status}` }, requestId);
          return;
        }
        remoteText = await res.text();
      } catch (error) {
        json(response, 400, { status: "error", reason: "fetch_failed", detail: error instanceof Error ? error.message : "URL 拉取失败" }, requestId);
        return;
      }
      const ref = await defaultBranch();
      const existing = await github.getFileContents({ ...ghInput, path: filePath, ref });
      const ok = await github.writeFileContents({
        ...ghInput,
        path: filePath,
        ref,
        content: remoteText,
        ...(existing?.sha ? { sha: existing.sha } : {}),
      });
      if (!ok) {
        json(response, 400, { status: "error", reason: "write_failed" }, requestId);
        return;
      }
      json(response, 200, { status: "ok", path: filePath }, requestId);
      return;
    }

    json(response, 405, { status: "error", reason: "method not allowed" }, requestId);
    return;
  }

  json(response, 404, { status: "error", reason: "not found" }, requestId);
}

/** 读取某仓库的 repo_rules_enabled 生效值（仓库覆盖 → 全局 → 默认 true）。 */
async function repoRulesEnabledFlag(repositoryId: string): Promise<boolean> {
  try {
    const repoOverrides = await getRepositorySettingsFor(
      database.db,
      repositoryId,
      ["repo_rules_enabled"],
    );
    const global = await loadSettings(database.db, ["repo_rules_enabled"]);
    const raw = repoOverrides.get("repo_rules_enabled") ?? global.get("repo_rules_enabled");
    if (raw === undefined || raw === null || raw === "") return true;
    return raw === "true";
  } catch {
    return true;
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
async function handleRepositorySettings(
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
      parsed = JSON.parse(body.toString("utf8"));
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
    json(response, 200, { status: "ok", key, cleared: value === null }, requestId);
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
async function handleRepositorySync(
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
  if (result.removed) metrics.increment("repositories.sync_removed", result.removed);
  audit(request, "repositories.sync", undefined, result);
  // 限流暂停窗口内再次点同步：显式 429，前端据此提示「GitHub 限流中，稍后再试」。
  if (result.reason === "rate_limited_until" || result.reason === "rate_limited") {
    json(
      response,
      429,
      {
        status: "error",
        reason: result.reason,
        rateLimitedUntil: result.rateLimitedUntil ?? null,
        detail: result.reason === "rate_limited_until"
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
      { status: "error", reason: "github_auth_failed", detail: "GitHub App 凭据无效，请到「GitHub 接入」重新配置后重试" },
      requestId,
    );
    return;
  }
  json(response, 200, { status: "ok", ...result }, requestId);
}

/* ---------- repository scanning (config / manual trigger / history) ---------- */

/** Global scheduled-scan switch from `system_settings` (absent = enabled). */
async function scanGloballyEnabled(): Promise<boolean> {
  try {
    const settings = await loadSettings(database.db, ["scan_enabled"]);
    return parseBool(
      settings.get("scan_enabled"),
      BOOLEAN_DEFAULTS.scan_enabled ?? true,
    );
  } catch {
    return true;
  }
}

/**
 * GET /scans/config — global switch + per-repository effective scan configs
 * (explicit rows merged over defaults). Used by the WebUI scan management page.
 */
async function handleScansConfig(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const repoRows = await database.db
    .select({
      id: repositories.id,
      owner: repositories.owner,
      name: repositories.name,
      installationId: repositories.installationId,
    })
    .from(repositories)
    .orderBy(repositories.name);
  const items = await Promise.all(
    repoRows.map(async (repo) => {
      const cfg = await getScanConfig(database.db, repo.id);
      return {
        repositoryId: repo.id,
        owner: repo.owner,
        name: repo.name,
        fullName: `${repo.owner}/${repo.name}`,
        installed: Boolean(repo.installationId),
        enabled: cfg.enabled,
        intervalMinutes: cfg.intervalMinutes,
        maxIssues: cfg.maxIssues,
        maxPrs: cfg.maxPrs,
        autoAnalyzeIssues: cfg.autoAnalyzeIssues,
        autoAnalyzePrs: cfg.autoAnalyzePrs,
        createTrackingIssues: cfg.createTrackingIssues,
        updatedAt: cfg.updatedAt,
      };
    }),
  );
  json(response, 200, { enabled: await scanGloballyEnabled(), items }, requestId);
}

/**
 * PUT /scans/config — updates the global switch or one repository's config.
 * Global: `{"enabled": boolean}`. Per-repo: `{"repositoryId": string, ...}`.
 */
async function handleScansConfigUpdate(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  if (!(await isAdminRequest(request))) {
    json(response, 403, { status: "error", reason: "admin required" }, requestId);
    return;
  }
  const body = await readBody(request);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  } catch {
    json(response, 400, { status: "error", reason: "invalid JSON" }, requestId);
    return;
  }

  const repositoryId =
    typeof parsed.repositoryId === "string" ? parsed.repositoryId.trim() : "";

  if (!repositoryId) {
    // Global switch: only `enabled` is honored at the top level.
    if (typeof parsed.enabled !== "boolean") {
      json(
        response,
        400,
        { status: "error", reason: "global update requires boolean enabled" },
        requestId,
      );
      return;
    }
    await database.db
      .insert(systemSettings)
      .values({ key: "scan_enabled", value: String(parsed.enabled) })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: String(parsed.enabled), updatedAt: new Date() },
      });
    audit(request, "scans.config.global", undefined, { enabled: parsed.enabled });
    json(response, 200, { status: "ok", enabled: parsed.enabled }, requestId);
    return;
  }

  const exists = await database.db
    .select({ id: repositories.id })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);
  if (exists.length === 0) {
    json(response, 404, { status: "error", reason: "repository not found" }, requestId);
    return;
  }
  const bool = (value: unknown, fallback: boolean): boolean =>
    typeof value === "boolean" ? value : fallback;
  const int = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(Math.max(Math.trunc(value), min), max)
      : fallback;
  await upsertScanConfig(database.db, {
    repositoryId,
    enabled: bool(parsed.enabled, true),
    intervalMinutes: int(parsed.intervalMinutes, 1440, 1, 60 * 24 * 30),
    maxIssues: int(parsed.maxIssues, 50, 1, 1000),
    maxPrs: int(parsed.maxPrs, 20, 1, 1000),
    autoAnalyzeIssues: bool(parsed.autoAnalyzeIssues, true),
    autoAnalyzePrs: bool(parsed.autoAnalyzePrs, true),
    createTrackingIssues: bool(parsed.createTrackingIssues, false),
  });
  audit(request, "scans.config.update", repositoryId);
  json(response, 200, { status: "ok", repositoryId }, requestId);
}

/**
 * POST /scans/run — manual scan trigger. Writes a `scan_trigger` setting that
 * the scan-worker consumes on its next loop (mirrors the index trigger pattern).
 */
async function handleScansRun(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  if (!(await isAdminRequest(request))) {
    json(response, 403, { status: "error", reason: "admin required" }, requestId);
    return;
  }
  await database.db
    .insert(systemSettings)
    .values({ key: "scan_trigger", value: new Date().toISOString() })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: new Date().toISOString(), updatedAt: new Date() },
    });
  audit(request, "scans.run");
  json(response, 200, { status: "ok", triggered: true }, requestId);
}

/** GET /scans/runs — scan run history, newest first, offset-paginated. */
async function handleScansRuns(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200)
    : 50;
  const offsetRaw = Number(url.searchParams.get("offset"));
  const offset = Number.isFinite(offsetRaw) ? Math.max(Math.trunc(offsetRaw), 0) : 0;
  const runs = await listScanRuns(database.db, { limit, offset });
  const repoIds = [...new Set(runs.map((run) => run.repositoryId).filter((v): v is string => Boolean(v)))];
  const repos = repoIds.length > 0
    ? await database.db
        .select({ id: repositories.id, owner: repositories.owner, name: repositories.name })
        .from(repositories)
        .where(inArray(repositories.id, repoIds))
    : [];
  const byId = new Map(repos.map((repo) => [repo.id, `${repo.owner}/${repo.name}`]));
  const items = runs.map((run) => ({
    ...run,
    repositoryFullName: run.repositoryId ? (byId.get(run.repositoryId) ?? null) : null,
  }));
  const nextOffset = items.length === limit ? offset + limit : undefined;
  json(
    response,
    200,
    nextOffset === undefined ? { items } : { items, nextOffset },
    requestId,
  );
}

/**
 * Activity log. Three modes driven by query params:
 *  - default: recent events (60) + webhook deliveries (30) — diagnostic bundle.
 *  - ?history=1&offset=N&limit=M: offset-paginated historical events.
 *  - ?since=<iso>: events created after `since` (resume from a bookmark).
 */
async function handleLogs(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");

  const sinceRaw = url.searchParams.get("since");
  const isHistory = url.searchParams.get("history") === "1";
  // 方向七：非 admin 仅能看到被授权仓库的任务事件。
  const scope = await visibleRepoScope(request);
  const repoFilter =
    scope && scope.ids !== null ? [...scope.ids] : null;

  if (isHistory) {
    const limitRaw = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200)
      : 50;
    const offsetRaw = Number(url.searchParams.get("offset"));
    const offset = Number.isFinite(offsetRaw)
      ? Math.max(Math.trunc(offsetRaw), 0)
      : 0;
    const events = await database.db
      .select({
        taskId: taskEvents.taskId,
        eventType: taskEvents.eventType,
        data: taskEvents.data,
        createdAt: taskEvents.createdAt,
      })
      .from(taskEvents)
      .innerJoin(analysisTasks, eq(taskEvents.taskId, analysisTasks.id))
      .where(
        repoFilter
          ? inArray(analysisTasks.repositoryId, repoFilter)
          : undefined,
      )
      .orderBy(desc(taskEvents.createdAt), desc(taskEvents.id))
      .limit(limit)
      .offset(offset);
    const nextOffset = events.length === limit ? offset + limit : undefined;
    json(
      response,
      200,
      nextOffset === undefined
        ? { events, deliveries: [] }
        : { events, deliveries: [], nextOffset },
      requestId,
    );
    return;
  }

  if (sinceRaw && !Number.isNaN(Date.parse(sinceRaw))) {
    const since = new Date(sinceRaw);
    const events = await database.db
      .select({
        taskId: taskEvents.taskId,
        eventType: taskEvents.eventType,
        data: taskEvents.data,
        createdAt: taskEvents.createdAt,
      })
      .from(taskEvents)
      .innerJoin(analysisTasks, eq(taskEvents.taskId, analysisTasks.id))
      .where(
        and(
          gt(taskEvents.createdAt, since),
          ...(repoFilter
            ? [inArray(analysisTasks.repositoryId, repoFilter)]
            : []),
        ),
      )
      .orderBy(asc(taskEvents.createdAt))
      .limit(500);
    json(response, 200, { events, deliveries: [] }, requestId);
    return;
  }

  const [events, deliveries] = await Promise.all([
    database.db
      .select({
        taskId: taskEvents.taskId,
        eventType: taskEvents.eventType,
        data: taskEvents.data,
        createdAt: taskEvents.createdAt,
      })
      .from(taskEvents)
      .innerJoin(analysisTasks, eq(taskEvents.taskId, analysisTasks.id))
      .where(
        repoFilter
          ? inArray(analysisTasks.repositoryId, repoFilter)
          : undefined,
      )
      .orderBy(desc(taskEvents.createdAt))
      .limit(60),
    database.db
      .select({
        eventName: webhookDeliveries.eventName,
        status: webhookDeliveries.processingStatus,
        outcomeReason: webhookDeliveries.outcomeReason,
        receivedAt: webhookDeliveries.receivedAt,
      })
      .from(webhookDeliveries)
      .orderBy(desc(webhookDeliveries.receivedAt))
      .limit(30),
  ]);
  json(response, 200, { events, deliveries }, requestId);
}

/** Vector/duplicate-index stats from issue_documents (nvidia/nv-embed-v1). */
async function handleVector(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const [stats, repoCoverage, lastIndex] = await Promise.all([
    database.sql<
      { docs: number; with_embedding: number; with_signals: number }[]
    >`
      SELECT count(*)::int AS docs,
             count(embedding)::int AS with_embedding,
             count(*) FILTER (WHERE cardinality(error_codes) > 0)::int AS with_signals
      FROM issue_documents
    `,
    database.sql<{ repositories: number }[]>`
      SELECT count(DISTINCT repository_id)::int AS repositories
      FROM issue_documents WHERE repository_id IS NOT NULL
    `,
    database.sql<{ at: Date | null }[]>`
      SELECT max(indexed_at) AS at FROM issue_documents
    `,
  ]);
  const row = stats[0];
  json(
    response,
    200,
    {
      documents: row?.docs ?? 0,
      withEmbedding: row?.with_embedding ?? 0,
      withSignals: row?.with_signals ?? 0,
      repositoryCoverage: repoCoverage[0]?.repositories ?? 0,
      embeddingModel: embeddingConfig().model,
      embeddingConfigured: Boolean(
        embeddingConfig().baseUrl && embeddingConfig().apiKey,
      ),
      lastIndexedAt: lastIndex[0]?.at ?? null,
    },
    requestId,
  );
}

/** Requests an immediate index pass by writing the index_trigger setting. */
async function handleIndexRun(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  try {
    await database.db
      .insert(systemSettings)
      .values({ key: "index_trigger", value: new Date().toISOString() })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: new Date().toISOString(), updatedAt: new Date() },
      });
    audit(request, "index.run");
    json(response, 200, { status: "ok", triggered: true }, requestId);
  } catch (error) {
    logger.warn({ err: error }, "index trigger failed");
    json(
      response,
      500,
      { status: "error", reason: "trigger_failed" },
      requestId,
    );
  }
}

/** Index health: last worker pass summary + pending trigger/rebuild flags. */
async function handleIndexStatus(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const [rows, pending] = await Promise.all([
    database.db
      .select({ key: systemSettings.key, value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, "index_last_pass"))
      .limit(1),
    database.db
      .select({ key: systemSettings.key })
      .from(systemSettings)
      .where(
        or(
          eq(systemSettings.key, "index_trigger"),
          eq(systemSettings.key, "index_rebuild"),
        ),
      )
      .limit(5),
  ]);
  const raw = rows[0]?.value;
  let lastPass: unknown = null;
  if (raw) {
    try {
      lastPass = JSON.parse(raw);
    } catch {
      lastPass = null;
    }
  }
  const keys = new Set(pending.map((row) => row.key));
  json(
    response,
    200,
    {
      lastPass,
      pendingTrigger: keys.has("index_trigger"),
      pendingRebuild: keys.has("index_rebuild"),
    },
    requestId,
  );
}

/** Full index rebuild: clears issue_documents and triggers a fresh pass. */
async function handleIndexRebuild(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  try {
    await database.db.delete(issueDocuments);
    await database.db
      .insert(systemSettings)
      .values({ key: "index_rebuild", value: new Date().toISOString() })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: new Date().toISOString(), updatedAt: new Date() },
      });
    audit(request, "index.rebuild");
    json(response, 200, { status: "ok", rebuilt: true }, requestId);
  } catch (error) {
    logger.warn({ err: error }, "index rebuild failed");
    json(
      response,
      500,
      { status: "error", reason: "rebuild_failed" },
      requestId,
    );
  }
}

/** Read-only RAG recall: candidates similar to a lead issue, never decides. */
async function handleIndexRelated(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const title = url.searchParams.get("title") ?? "";
  const body = url.searchParams.get("body") ?? "";
  const topK = Math.min(
    Math.max(Number(url.searchParams.get("topK")) || 5, 1),
    20,
  );
  const repositoryFullName = url.searchParams.get("repositoryFullName") ?? "";
  const repository =
    repositoryFullName && repositoryFullName.includes("/")
      ? (() => {
          const [owner, name] = repositoryFullName.split("/");
          return owner && name ? { owner, name } : null;
        })()
      : null;
  if (title.length === 0 && body.length === 0) {
    json(
      response,
      400,
      { status: "error", reason: "title or body required" },
      requestId,
    );
    return;
  }
  try {
    const signals = extractIssueSignals({ title, body, labels: [] });
    const candidates = await recallCandidatesWithRepos(
      database.sql as unknown as SqlTag,
      {
        title: normalizedIndexText({ title, body: "" }),
        body: normalizedIndexText({ title, body }),
        signals,
        topK,
        // 可选：限制在同一仓库内召回，避免跨项目“相关”Issue。
        repository,
      },
    );
    json(response, 200, { candidates }, requestId);
  } catch (error) {
    // Index unavailable is a degrade-not-fail condition for the caller.
    logger.warn({ err: error }, "index recall failed");
    json(response, 200, { candidates: [], degraded: true }, requestId);
  }
}

/** Config backup: exports settings + policies (secrets masked, no keys). */
async function handleBackupExport(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  try {
    const snapshot = await buildBackupSnapshot(database.db);
    audit(request, "backup.export");
    json(response, 200, snapshot, requestId);
  } catch (error) {
    logger.warn({ err: error }, "backup export failed");
    json(response, 500, { status: "error", reason: "export_failed" }, requestId);
  }
}

/** Config restore: applies non-secret settings + policies from a snapshot. */
async function handleBackupImport(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const body = await readBody(request);
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(body.toString("utf8"));
  } catch {
    json(response, 400, { status: "error", reason: "invalid JSON" }, requestId);
    return;
  }
  try {
    const result = await applyBackupSnapshot(database.db, snapshot);
    // 导入会批量改写设置与策略，属敏感操作，留痕。
    audit(request, "backup.import", undefined, {
      settings: result.settings,
      policies: result.policies,
    });
    json(response, 200, { status: "ok", ...result }, requestId);
  } catch (error) {
    const reason =
      error instanceof Error ? error.message.slice(0, 120) : "import_failed";
    json(response, 400, { status: "error", reason }, requestId);
  }
}

/** Label rules: list all, or upsert/delete by path. */
async function handleLabelRules(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (path === "/label-rules" && request.method === "GET") {
    let items = await listLabelRules(database.db);
    // 首次使用自动填充默认常用标签，方便用户直接编辑/启用。
    if (items.length === 0) {
      await seedDefaultLabelRules(database.db);
      items = await listLabelRules(database.db);
    }
    json(response, 200, { items, prefixes: LABEL_RULE_PREFIXES }, requestId);
    return;
  }

  if (path === "/label-rules" && request.method === "PUT") {
    const body = await readBody(request);
    let parsed: { key?: unknown; label?: unknown; enabled?: unknown };
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      json(response, 400, { status: "error", reason: "invalid JSON" }, requestId);
      return;
    }
    const key = typeof parsed.key === "string" ? parsed.key.trim() : "";
    const label = typeof parsed.label === "string" ? parsed.label.trim() : "";
    const enabled = parsed.enabled !== false;
    if (!key) {
      json(response, 400, { status: "error", reason: "rule key required" }, requestId);
      return;
    }
    try {
      await upsertLabelRule(database.db, { key, label, enabled });
      json(response, 200, { status: "ok", key, label, enabled }, requestId);
    } catch (error) {
      logger.warn({ err: error }, "label rule upsert failed");
      json(response, 500, { status: "error", reason: "upsert_failed" }, requestId);
    }
    return;
  }

  if (path.startsWith("/label-rules/") && request.method === "DELETE") {
    const key = decodeURIComponent(path.slice("/label-rules/".length)).trim();
    if (!key) {
      json(response, 400, { status: "error", reason: "rule key required" }, requestId);
      return;
    }
    const deleted = await deleteLabelRule(database.db, key);
    if (deleted) audit(request, "label_rule.delete", key);
    json(response, deleted ? 200 : 404, { status: deleted ? "ok" : "error" }, requestId);
    return;
  }

  json(
    response,
    405,
    { status: "error", reason: "method not allowed" },
    requestId,
  );
}

/** Non-secret runtime configuration snapshot (no keys, no secrets). */
/** GitHub App slug 缓存（60s），供 WebUI 生成「安装 / 授权仓库」链接。 */
let githubAppSlugCache: { slug: string; at: number } | null = null;

/** 当前 GitHub App 的 slug（如 clodbreeze-ai-reviewer）；未配置/失败返回 null。 */
async function githubAppSlug(): Promise<string | null> {
  if (githubAppSlugCache && Date.now() - githubAppSlugCache.at < 60_000)
    return githubAppSlugCache.slug;
  try {
    const client = await githubClientPromise;
    if (!client) return null;
    const app = await client.getAppMetadata();
    if (!app.slug) return null;
    githubAppSlugCache = { slug: app.slug, at: Date.now() };
    return app.slug;
  } catch (error) {
    logger.warn({ err: error }, "github app slug lookup failed");
    return null;
  }
}

/**
 * GitHub App 是否「真的可用」：凭据可以是环境变量，也可以是在 WebUI 保存到
 * system_settings 的那一份（DB 优先）。此前 /config 只看环境变量，用户在界面上
 * 配好 App、同步也能跑，页面却显示「未配置」，导致「安装 / 授权仓库」引导区被
 * 隐藏 —— 这正是用户安装后看不到该区块的原因。
 */
async function githubAppConfiguredFlag(): Promise<boolean> {
  try {
    return (await loadGithubAppCredentials()) !== null;
  } catch (error) {
    logger.warn({ err: error }, "github app configured check failed");
    return false;
  }
}

async function handleConfig(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const modelProviders = Object.keys(config.modelProviderBaseUrls);
  const [appSlug, appConfigured] = await Promise.all([
    githubAppSlug(),
    githubAppConfiguredFlag(),
  ]);
  json(
    response,
    200,
    {
      host: config.host,
      port: config.port,
      logLevel: config.logLevel,
      githubWebhookConfigured: webhookEnabled(),
      githubAppConfigured: appConfigured,
      githubAppSlug: appSlug,
      webuiAuthEnabled: Boolean(config.webuiApiToken),
      modelProviders,
      embeddingModel: embeddingConfig().model,
      embeddingConfigured: Boolean(
        embeddingConfig().baseUrl && embeddingConfig().apiKey,
      ),
      qqBotProtocols: Object.keys(qqConfig().protocols),
      qqOfficialConfigured: Boolean(
        qqConfig().officialAppId && qqConfig().officialAppSecret,
      ),
      oauthConfigured: oauthConfigured(),
      oauthEnabled: oauthConfigured() && webuiToken().length === 0,
      apiRateLimit: config.apiRateLimit,
      webhookRateLimit: config.webhookRateLimit,
    },
    requestId,
  );
}

/**
 * 某个设置键的 env 兜底值。
 *
 * 直接读 process.env 而不是 loadConfig 的结果：注册表里记的是 env 变量名，而
 * config 已经把它们改过名、套过默认值（比如 EMBEDDING_MODEL 默认
 * nvidia/nv-embed-v1）。界面要显示的是「env 里到底有没有配」，所以看原始值。
 *
 * `github_app_private_key` 的 env 形态是文件路径而非密钥内容，这里只用于判断
 * 「env 有没有提供」，不回显值。
 */
function settingEnvValue(key: string): string | undefined {
  const spec = getSettingSpec(key);
  if (!spec?.envVar) return undefined;
  const raw = process.env[spec.envVar];
  return raw === undefined || raw.trim().length === 0 ? undefined : raw;
}

/**
 * 某个设置键的应用默认值（没有 DB 覆盖也没有 env 时生效的那个），以字符串表示，
 * 供界面显示「应用默认：…」。
 *
 * `github_webhook_enabled` 的默认是动态的 —— 跟随是否配了签名密钥，这也是它在
 * 注册表里没有 envVar 的原因。
 */
function settingDefaultValue(key: string): string {
  if (key === "github_webhook_enabled")
    return config.githubWebhookSecret ? "true" : "false";
  const spec = getSettingSpec(key);
  if (spec?.kind === "boolean") {
    const fallback = BOOLEAN_DEFAULTS[key];
    return fallback === undefined ? "" : String(fallback);
  }
  if (key === "spam_handling") return "close";
  if (key === "log_level") return config.logLevel;
  if (key === "issue_reanalyze_min_change")
    return String(DEFAULT_MIN_CHANGE_RATIO);
  if (key === "issue_prompt_version") return "v9";
  if (key === "issue_prompt_mode") return "adaptive";
  if (key === "issue_result_sections") return DEFAULT_ISSUE_RESULT_SECTIONS_VALUE;
  if (key === "embedding_model") return config.embedding.model;
  if (key === "qq_official_intents") return String(config.qqOfficialIntents);
  if (key === "alert_queue_backlog_threshold")
    return String(DEFAULT_ALERT_THRESHOLDS.queueBacklog);
  if (key === "alert_failed_tasks_threshold")
    return String(DEFAULT_ALERT_THRESHOLDS.failedTasks);
  if (key === "alert_stale_tasks_threshold")
    return String(DEFAULT_ALERT_THRESHOLDS.staleTasks);
  return "";
}

/**
 * 任务可靠性量规（供 /metrics 与告警评估共用）：队列积压、在途、失败、滞留。
 */
async function collectTaskReliabilityGauges(): Promise<{
  queueDepth: number;
  inflight: number;
  failed: number;
  stale: number;
}> {
  const [queue, inflight, failed, stale] = await Promise.all([
    database.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM analysis_tasks WHERE status IN ('queued', 'retry_wait')`,
    database.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM analysis_tasks WHERE status IN ('leased', 'running', 'publishing')`,
    database.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM analysis_tasks WHERE status = 'failed'`,
    // 滞留任务：声称在跑但心跳超过 10 分钟未更新（疑似 worker 已死但租约未释放）。
    database.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM analysis_tasks
      WHERE status IN ('leased', 'running', 'publishing')
        AND (heartbeat_at IS NULL OR heartbeat_at < now() - interval '10 minutes')`,
  ]);
  return {
    queueDepth: queue[0]?.c ?? 0,
    inflight: inflight[0]?.c ?? 0,
    failed: failed[0]?.c ?? 0,
    stale: stale[0]?.c ?? 0,
  };
}

/** 进程内告警状态（规则 → 最新记录）。 */
const alertRecords = new Map<AlertRuleId, AlertRecord>();

/**
 * 将告警状态迁移事件 POST 到配置的 webhook（如飞书/钉钉/自定义端点）。
 * 仅在配置了 alert_webhook_url 时发送；失败仅记日志，不影响告警主流程。
 * 每次迁移只发一条（triggered/resolved），持续状态不重复。
 */
async function notifyAlertTransitions(
  transitions: readonly AlertTransition[],
): Promise<void> {
  if (transitions.length === 0) return;
  const url = alertWebhookUrl();
  if (!url) return;
  const payload = {
    type: "alert",
    sentAt: new Date().toISOString(),
    events: transitions.map((t) => ({
      kind: t.kind,
      rule: t.record.id,
      severity: t.record.severity,
      message: t.record.message,
      value: t.record.value,
      firstAt: t.record.firstAt,
      lastAt: t.record.lastAt,
      status: t.record.status,
    })),
  };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      logger.warn(
        { url, status: response.status },
        "alert webhook non-2xx response",
      );
    }
  } catch (error) {
    logger.warn({ err: error, url }, "alert webhook send failed");
  }
}

/** 评估一次告警（由定时器与 /alerts 请求共同触发），并在状态迁移时推送 webhook。 */
async function refreshAlerts(): Promise<void> {
  try {
    const prev = new Map(alertRecords);
    const { queueDepth, failed, stale } =
      await collectTaskReliabilityGauges();
    const next = evaluateAlerts(alertRecords, {
      queueDepth,
      failed,
      stale,
    }, new Date(), alertThresholds());
    const transitions = diffAlertTransitions(prev, next);
    alertRecords.clear();
    for (const record of next) alertRecords.set(record.id, record);
    if (transitions.length > 0) {
      // 不 await：通知失败不阻塞告警刷新。
      void notifyAlertTransitions(transitions);
    }
  } catch (error) {
    logger.warn({ err: error }, "alert evaluation failed");
  }
}

/**
 * GET /metrics — 进程内指标快照 + 库内实时量规（队列深度 / 在途任务 / 仓库数）。
 * 管理员可见；给「运维」页与未来 Prometheus 抓取共用同一份快照。
 */
async function handleMetrics(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const snapshot = metrics.snapshot();
  try {
    const { queueDepth, inflight, failed, stale } =
      await collectTaskReliabilityGauges();
    const repos = await database.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM repositories`;
    snapshot.gauges["queue.depth"] = queueDepth;
    snapshot.gauges["tasks.inflight"] = inflight;
    snapshot.gauges["repositories.count"] = repos[0]?.c ?? 0;
    snapshot.gauges["tasks.failed"] = failed;
    snapshot.gauges["tasks.stale"] = stale;
  } catch (error) {
    logger.warn({ err: error }, "metrics live gauges failed");
  }
  json(response, 200, snapshot, requestId);
}

/**
 * GET /alerts — 当前告警状态（active 在前，resolved 历史在后）。管理员可见。
 */
async function handleAlerts(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  await refreshAlerts();
  json(
    response,
    200,
    { items: [...alertRecords.values()] },
    requestId,
  );
}

/** Runtime settings: GET lists (secret values masked); PUT upserts a key. */
async function handleSettings(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  if (request.method === "PUT") {
    const body = await readBody(request);
    let parsed: { key?: unknown; value?: unknown };
    try {
      parsed = JSON.parse(body.toString("utf8"));
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
    if (!key || !WRITABLE_SETTING_KEYS.has(key)) {
      json(
        response,
        400,
        { status: "error", reason: "unsupported_setting_key" },
        requestId,
      );
      return;
    }

    // value: null 表示删除覆盖、回落到 env / 应用默认。没有这个动作的话，一旦
    // 存过值就再也回不去，只能在库里留一份 env 值的副本。
    if (parsed.value === null) {
      const secret = SECRET_KEYS.has(key);
      // 密钥走轮换语义：宽限期内「清空」会回滚到旧值，换错了新密钥不必回退部署。
      const result = secret
        ? await clearSettingWithRotation(database.db, key)
        : (await deleteSetting(database.db, key), { rolledBack: false });
      await refreshRuntimeSettings();
      audit(request, "settings.clear", key, {
        secret,
        rolledBack: result.rolledBack,
      });
      json(
        response,
        200,
        { status: "ok", key, cleared: true, ...result },
        requestId,
      );
      return;
    }

    const value = typeof parsed.value === "string" ? parsed.value : "";
    // 保存前校验：此前无校验直存，log_level 填 foo 会存进去并污染日志系统。
    const invalid = validateSettingValue(key, value);
    if (invalid) {
      json(
        response,
        400,
        { status: "error", reason: "invalid_setting_value", detail: invalid },
        requestId,
      );
      return;
    }

    // 密钥覆盖走轮换语义：旧值暂存 24h，换错了可在窗口内回滚；非密钥照常写入。
    const secret = SECRET_KEYS.has(key);
    let rotated = false;
    if (secret) {
      ({ rotated } = await putSettingWithRotation(database.db, key, value));
    } else {
      await putSetting(database.db, key, value);
    }
    await refreshRuntimeSettings();
    audit(request, "settings.update", key, { secret, rotated });
    json(response, 200, { status: "ok", key, rotated }, requestId);
    return;
  }

  const rows = await database.db
    .select({
      key: systemSettings.key,
      value: systemSettings.value,
      updatedAt: systemSettings.updatedAt,
    })
    .from(systemSettings)
    .orderBy(asc(systemSettings.key));
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const items = await Promise.all(
    KNOWN_SETTING_KEYS.map(async (key) => {
      const spec = getSettingSpec(key);
      const row = byKey.get(key);
      const envValue = settingEnvValue(key);
      const resolved = resolveSettingValue({
        dbValue: row?.value,
        envValue,
      });
      const secret = SECRET_KEYS.has(key);
      const hasValue = Boolean(row && row.value.trim().length > 0);
      // 生效值：secret 一律不回显，只说明「已配置」。
      const effective =
        resolved.value === undefined
          ? settingDefaultValue(key)
          : secret
            ? "••••••••"
            : resolved.value;
      const rotation = secret ? await rotationInfo(database.db, key) : null;
      return {
        key,
        group: spec?.group ?? "ops",
        kind: spec?.kind ?? "string",
        label: spec?.label ?? key,
        hint: spec?.hint ?? "",
        secret,
        repoScoped: spec?.repoScoped ?? false,
        hotReload: spec?.hotReload ?? "poll",
        ...(spec?.options ? { options: spec.options } : {}),
        // source 是这次交互改造的核心：用户终于能看出「我改的到底生效没、
        // 现在这个值是谁给的」。
        source: resolved.source,
        value: effective,
        /** env 是否提供了兜底值（secret 不回显内容）。 */
        envConfigured: envValue !== undefined,
        envVar: spec?.envVar ?? null,
        defaultValue: settingDefaultValue(key),
        // 兼容旧前端：hasValue 表示「数据库里有覆盖」。
        hasValue,
        updatedAt: row?.updatedAt ?? null,
        // 密钥轮换：旧值在回滚窗口内的过期时间（用于 UI 提示）。
        ...(rotation && rotation.hasPrevious ? { rotation } : {}),
      };
    }),
  );
  json(response, 200, { items }, requestId);
}

/**
 * GET /settings/bootstrap — 引导层（只能来自环境变量的那几项）的健康度。
 *
 * 这几项无法下沉到数据库：DATABASE_URL / REDIS_URL 要先连上才能读库（鸡生蛋），
 * HOST / PORT 在读库之前就要绑定，CREDENTIAL_MASTER_KEY 是解开库内所有密文的
 * 钥匙 —— 放进库等于明文存钥匙，加密就失去意义。
 *
 * 单独暴露是因为 CREDENTIAL_MASTER_KEY 缺失时，provider 凭据与 GitHub App 私钥
 * 都保存不了，而这件事此前只在保存失败时才暴露出来。
 */
function handleSettingsBootstrap(
  response: ServerResponse,
  requestId: string,
): void {
  const masterKeyConfigured = Boolean(config.credentialMasterKey);
  json(
    response,
    200,
    {
      // 一律不回显值：这些要么是连接串（含口令），要么是主密钥本身。
      items: [
        {
          key: "DATABASE_URL",
          configured: true, // 能响应这个请求就说明它可用
          required: true,
          label: "数据库连接",
          hint: "要先连上数据库才能读取设置，因此它无法保存在数据库里",
        },
        {
          key: "REDIS_URL",
          configured: Boolean(config.redisUrl),
          required: true,
          label: "Redis 连接",
          hint: "事件流与限流依赖；同样属于启动前就要知道的连接信息",
        },
        {
          key: "CREDENTIAL_MASTER_KEY",
          configured: masterKeyConfigured,
          required: true,
          label: "凭据主密钥",
          hint: masterKeyConfigured
            ? "已配置：模型 Provider 凭据与 GitHub App 私钥可加密保存"
            : "未配置：无法保存模型 Provider 凭据与 GitHub App 私钥（AES-GCM 加密需要它）。它是解开库内所有密文的钥匙，因此不能存进数据库",
        },
        {
          key: "HOST/PORT",
          configured: true,
          required: true,
          label: "监听地址",
          hint: `${config.host}:${config.port}；端口绑定发生在读取数据库之前`,
        },
      ],
      healthy: masterKeyConfigured,
    },
    requestId,
  );
}

/** Reads the current expert-team enablement flag from `system_settings`. */
async function agentTeamEnabled(): Promise<boolean> {
  try {
    const settings = await loadSettings(database.db, ["agent_team_enabled"]);
    return parseBool(
      settings.get("agent_team_enabled"),
      BOOLEAN_DEFAULTS.agent_team_enabled ?? false,
    );
  } catch (error) {
    // 之前这里没有 catch：数据库抖一下就让整个 /capabilities 返回 500，
    // 而这只是一个开关，读不到时按「未启用」处理即可。
    logger.warn({ err: error }, "agent team flag read failed; treating as off");
    return false;
  }
}

/**
 * Agent capabilities catalog: built-in skills + expert team registry, plus the
 * global expert-team enablement switch. GET is available to any authenticated
 * user; PUT (toggle) requires admin and writes a runtime setting.
 */
async function handleCapabilities(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  if (request.method === "PUT") {
    if (!(await isAdminRequest(request))) {
      json(
        response,
        403,
        { status: "error", reason: "admin required" },
        requestId,
      );
      return;
    }
    const body = await readBody(request);
    let parsed: { enabled?: unknown };
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      json(
        response,
        400,
        { status: "error", reason: "invalid JSON" },
        requestId,
      );
      return;
    }
    const enabled = parsed.enabled === true;
    const value = enabled ? "true" : "false";
    await database.db
      .insert(systemSettings)
      .values({ key: "agent_team_enabled", value })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value, updatedAt: new Date() },
      });
    audit(request, "capabilities.toggle", undefined, { enabled });
    json(response, 200, { status: "ok", enabled }, requestId);
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

  json(
    response,
    200,
    {
      skills: BUILTIN_SKILLS.map((skill) => ({
        id: skill.id,
        name: skill.name,
        appliesTo: skill.appliesTo,
        description: skill.description,
      })),
      experts: EXPERT_TEAM.map((expert) => ({
        id: expert.id,
        name: expert.name,
        appliesTo: expert.appliesTo,
      })),
      enabled: await agentTeamEnabled(),
    },
    requestId,
  );
}

/** GitHub OAuth entry: /auth/status, /auth/login (redirect), /auth/callback. */
async function handleAuth(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (path === "/auth/status") {
    json(response, 200, { oauthConfigured: oauthConfigured() }, requestId);
    return;
  }

  if (path === "/auth/login") {
    if (!oauthConfigured()) {
      json(
        response,
        503,
        { status: "error", reason: "oauth_not_configured" },
        requestId,
      );
      return;
    }
    const state = randomUUID();
    oauthStates.set(state, Date.now() + 10 * 60 * 1000);
    const { clientId } = currentOAuth();
    const redirectUri = oauthRedirectUri(request);
    const authorizeUrl =
      `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}` +
      `&scope=read:user&state=${state}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}`;
    response.writeHead(302, { Location: authorizeUrl });
    response.end();
    return;
  }

  if (path === "/auth/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const exp = state ? oauthStates.get(state) : undefined;
    if (!state || exp === undefined || exp < Date.now()) {
      oauthStates.delete(state ?? "");
      response.writeHead(302, { Location: "/#/?oauth_error=bad_state" });
      response.end();
      return;
    }
    oauthStates.delete(state);
    if (!code) {
      response.writeHead(302, { Location: "/#/?oauth_error=missing_code" });
      response.end();
      return;
    }
    try {
      const { clientId, clientSecret } = currentOAuth();
      const tokenRes = await fetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code,
          }),
        },
      );
      const tokenJson = (await tokenRes.json()) as {
        access_token?: string;
        error?: string;
      };
      if (typeof tokenJson.access_token !== "string")
        throw new Error(tokenJson.error ?? "no_access_token");
      const userRes = await fetch("https://api.github.com/user", {
        headers: {
          authorization: `Bearer ${tokenJson.access_token}`,
          "user-agent": "apertureprism",
        },
      });
      const user = (await userRes.json()) as { login?: string };
      if (typeof user.login !== "string") throw new Error("no_login");
      // Persist the recognized user so the personal settings page can address them.
      await ensureUser(database.db, user.login).catch((error: unknown) =>
        logger.warn({ err: error }, "user upsert failed"),
      );
      const session = signSession(user.login);
      response.writeHead(302, {
        Location: `/#/?token=${encodeURIComponent(session)}`,
      });
      response.end();
    } catch {
      response.writeHead(302, { Location: "/#/?oauth_error=login_failed" });
      response.end();
    }
    return;
  }

  json(response, 404, { status: "error", reason: "not_found" }, requestId);
}

/** HttpOnly 会话 cookie 名（方向四A）：把签名 token 放 cookie，前端 JS 不可读。 */
const SESSION_COOKIE = "__ap_session";

/** 从 Cookie 头解析会话 token（URL 编码处理）。 */
function sessionCookieToken(request: IncomingMessage): string | null {
  const header = request.headers.cookie;
  if (typeof header !== "string" || header.length === 0) return null;
  for (const part of header.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const name = part.slice(0, eqIdx).trim();
    if (name === SESSION_COOKIE) {
      try {
        return decodeURIComponent(part.slice(eqIdx + 1).trim()) || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Set-Cookie 片段：HttpOnly + SameSite=Strict；生产（经 https）追加 Secure。 */
function sessionCookieHeader(token: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return (
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; ` +
    `SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`
  );
}

/** 清空会话 cookie（登出时）。 */
function clearSessionCookie(): string {
  const secure =
    process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${secure}`;
}

/** Login of the current signed session (cookie or Authorization header), if any. */
function sessionLogin(request: IncomingMessage): string | null {
  const fromCookie = sessionCookieToken(request);
  if (fromCookie) return parseSessionToken(fromCookie);
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer "))
    return parseSessionToken(header.slice(7));
  return null;
}

/** Personal settings: GET current user, PUT display name. */
async function handleAccount(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const login = sessionLogin(request);

  if (request.method === "GET") {
    if (!login) {
      // 未登录：告诉前端是否需要先引导创建本地管理员（无任何本地 admin 时）。
      json(
        response,
        200,
        {
          login: null,
          displayName: null,
          isAdmin: false,
          isReadOnly: false,
          hasPassword: false,
          authMethod: "bearer",
          needsBootstrap: await needsPasswordBootstrap(database.db),
        },
        requestId,
      );
      return;
    }
    const user = await getUser(database.db, login);
    json(
      response,
      200,
      {
        login,
        displayName: user?.displayName ?? "",
        isAdmin: user?.isAdmin === true,
        isReadOnly: user?.isReadOnly === true,
        hasPassword: user?.hasPassword === true,
        authMethod: "oauth",
      },
      requestId,
    );
    return;
  }

  if (request.method === "PUT") {
    if (!login) {
      json(
        response,
        401,
        { status: "error", reason: "oauth login required" },
        requestId,
      );
      return;
    }
    const body = await readBody(request);
    let parsed: { displayName?: unknown };
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      json(response, 400, { status: "error", reason: "invalid JSON" }, requestId);
      return;
    }
    const displayName =
      typeof parsed.displayName === "string" ? parsed.displayName.slice(0, 120) : "";
    const user = await updateDisplayName(database.db, login, displayName);
    json(
      response,
      200,
      { status: "ok", login, displayName: user?.displayName ?? "" },
      requestId,
    );
    return;
  }

  json(response, 405, { status: "error", reason: "method not allowed" }, requestId);
}

/**
 * 本地账号密码认证（方向一）。用现有 signSession(login) 签发 bearer 兼容令牌
 * （可过 parseSessionToken / isAuthorized），并落一条 user_sessions 以支持过期、
 * 吊销与会话管控。当前入口：
 *   POST /auth/login               本地用户名/密码登录
 *   POST /auth/register            引导创建首个本地管理员（仅当无本地管理员时）
 *   POST /auth/logout              吊销当前会话
 *   POST /auth/password            改密（仅本地账号；非本地需先设密码）
 *   GET  /auth/sessions            列出本人活跃会话
 *   DELETE /auth/sessions/:id      吊销本人指定会话
 */
const SESSION_UA_MAX = 400;
function browserFingerprint(request: IncomingMessage): {
  userAgent: string | null;
  ip: string | null;
} {
  const ua = request.headers["user-agent"];
  return {
    userAgent:
      typeof ua === "string"
        ? ua.slice(0, SESSION_UA_MAX)
        : null,
    ip: clientIp(request),
  };
}

async function handleLocalAuth(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = request.method ?? "GET";
  const fp = browserFingerprint(request);
  const now = new Date();

  // POST /auth/login —— 本地密码登录
  if (path === "/auth/login" && method === "POST") {
    const body = await readBody(request);
    let parsed: { username?: unknown; password?: unknown };
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      json(response, 400, { status: "error", reason: "invalid JSON" }, requestId);
      return;
    }
    const username =
      typeof parsed.username === "string" ? parsed.username.trim() : "";
    const password =
      typeof parsed.password === "string" ? parsed.password : "";
    if (!username || !password) {
      json(
        response,
        400,
        { status: "error", reason: "username and password required" },
        requestId,
      );
      return;
    }
    const user = await getUser(database.db, username);
    // 统一模糊文案，避免枚举账号是否存在。
    const ok =
      user !== null &&
      user.hasPassword &&
      user.passwordHash !== null &&
      (await verifyPassword(password, user.passwordHash));
    audit(request, ok ? "auth.login" : "auth.login_failed", username, {
      ok,
      ip: fp.ip,
    });
    if (!ok) {
      json(
        response,
        401,
        { status: "error", reason: "invalid_credentials" },
        requestId,
      );
      return;
    }
    // 签发 bearer（HMAC 签名，含 login+exp），并落会话。
    const token = signSession(username);
    await createSession(database.db, {
      userLogin: username,
      token,
      authMethod: "password",
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      ...fp,
    });
    await setLastLogin(database.db, username);
    response.setHeader(
      "set-cookie",
      sessionCookieHeader(token, Math.floor(SESSION_TTL_MS / 1000)),
    );
    json(
      response,
      200,
      {
        status: "ok",
        token,
        user: {
          login: username,
          displayName: user.displayName,
          isAdmin: user.isAdmin,
          isReadOnly: user.isReadOnly,
          hasPassword: true,
        },
      },
      requestId,
    );
    return;
  }

  // POST /auth/register —— 引导创建首个本地管理员（一次性）。
  if (path === "/auth/register" && method === "POST") {
    const needsBootstrap = await needsPasswordBootstrap(database.db);
    if (!needsBootstrap) {
      json(
        response,
        409,
        { status: "error", reason: "bootstrap_already_done" },
        requestId,
      );
      return;
    }
    const body = await readBody(request);
    let parsed: { username?: unknown; password?: unknown };
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      json(response, 400, { status: "error", reason: "invalid JSON" }, requestId);
      return;
    }
    const username =
      typeof parsed.username === "string" ? parsed.username.trim() : "";
    const password =
      typeof parsed.password === "string" ? parsed.password : "";
    if (!username || !password || password.length < 8) {
      json(
        response,
        400,
        { status: "error", reason: "password too weak or username empty" },
        requestId,
      );
      return;
    }
    // 首个引导用户：不存在则建，存在则只设密码并保证是 admin。
    const existing = await getUser(database.db, username);
    if (!existing) {
      await ensureUser(database.db, username);
      await setUserRoles(database.db, username, { isAdmin: true });
    } else {
      await setUserRoles(database.db, username, { isAdmin: true });
    }
    await setPassword(database.db, username, await hashPassword(password));
    const token = signSession(username);
    await createSession(database.db, {
      userLogin: username,
      token,
      authMethod: "password",
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      ...fp,
    });
    response.setHeader(
      "set-cookie",
      sessionCookieHeader(token, Math.floor(SESSION_TTL_MS / 1000)),
    );
    audit(request, "auth.bootstrap", username, {});
    json(
      response,
      200,
      {
        status: "ok",
        token,
        user: {
          login: username,
          displayName: (await getUser(database.db, username))?.displayName ?? "",
          isAdmin: true,
          isReadOnly: false,
          hasPassword: true,
        },
      },
      requestId,
    );
    return;
  }

  // 以下端点需已登录（本地或 OAuth）。
  const login = sessionLogin(request);
  if (!login) {
    json(response, 401, { status: "error", reason: "login required" }, requestId);
    return;
  }

  // POST /auth/logout —— 吊销当前会话
  if (path === "/auth/logout" && method === "POST") {
    const token =
      sessionCookieToken(request) ?? extractBearerOrQueryToken(request);
    if (token) await revokeSession(database.db, token, now);
    response.setHeader("set-cookie", clearSessionCookie());
    audit(request, "auth.logout", login, {});
    json(response, 200, { status: "ok" }, requestId);
    return;
  }

  // POST /auth/password —— 改密（本地账号）。旧密校验；成功吊销其它会话。
  if (path === "/auth/password" && method === "POST") {
    const body = await readBody(request);
    let parsed: { currentPassword?: unknown; newPassword?: unknown };
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      json(response, 400, { status: "error", reason: "invalid JSON" }, requestId);
      return;
    }
    const current =
      typeof parsed.currentPassword === "string" ? parsed.currentPassword : "";
    const next = typeof parsed.newPassword === "string" ? parsed.newPassword : "";
    const user = await getUser(database.db, login);
    if (!user || !user.hasPassword || user.passwordHash === null) {
      json(
        response,
        409,
        { status: "error", reason: "account has no local password set" },
        requestId,
      );
      return;
    }
    if (!next || next.length < 8) {
      json(
        response,
        400,
        { status: "error", reason: "new password too weak" },
        requestId,
      );
      return;
    }
    const verified = await verifyPassword(current, user.passwordHash);
    if (!verified) {
      audit(request, "auth.change_password_failed", login, {});
      json(
        response,
        401,
        { status: "error", reason: "invalid_credentials" },
        requestId,
      );
      return;
    }
    await setPassword(database.db, login, await hashPassword(next));
    // 吊销本人其它会话（保留当前）。
    const token = extractBearerOrQueryToken(request);
    if (token) await revokeUserSessions(database.db, login, token, now);
    audit(request, "auth.change_password", login, {});
    json(response, 200, { status: "ok" }, requestId);
    return;
  }

  // GET /auth/sessions —— 列出本人活跃会话
  if (path === "/auth/sessions" && method === "GET") {
    const rows = await listUserSessions(database.db, login, now);
    json(
      response,
      200,
      {
        sessions: rows.map((row) => ({
          id: row.id,
          authMethod: row.authMethod,
          issuedAt: row.issuedAt,
          lastSeenAt: row.lastSeenAt,
          userAgent: row.userAgent,
          ip: row.ip,
        })),
      },
      requestId,
    );
    return;
  }

  // DELETE /auth/sessions/:id —— 吊销本人指定会话
  if (path.startsWith("/auth/sessions/") && method === "DELETE") {
    const sessionId = decodeURIComponent(path.slice("/auth/sessions/".length)).trim();
    if (!sessionId) {
      json(response, 400, { status: "error", reason: "session id required" }, requestId);
      return;
    }
    const revoked = await revokeSessionById(database.db, sessionId, login, now);
    audit(request, "auth.session_revoke", login, { sessionId, revoked });
    json(response, revoked ? 200 : 404, revoked ? { status: "ok" } : { status: "error", reason: "session not found" }, requestId);
    return;
  }

  json(response, 405, { status: "error", reason: "method not allowed" }, requestId);
}

function extractBearerOrQueryToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer "))
    return header.slice(7);
  const url = new URL(request.url ?? "/", "http://localhost");
  const query = url.searchParams.get("token");
  if (query) return query;
  return sessionCookieToken(request);
}

/**
 * Admin check for the current request. A valid OAuth/password session is admin
 * only when the persisted user has `is_admin`; a shared WebUI bearer-token
 * request (matching webuiToken) is treated as admin.
 */
async function isAdminRequest(request: IncomingMessage): Promise<boolean> {
  const login = sessionLogin(request);
  if (!login) return true;
  const user = await getUser(database.db, login);
  return user?.isAdmin === true;
}

/**
 * 只读操作员判定（OAuth 用户）。Bearer token 是管理员凭据，永不视为只读。
 * 只读用户可登录查看，但一切写操作都会被全局拦截。
 */
async function isReadOnlyRequest(request: IncomingMessage): Promise<boolean> {
  const login = sessionLogin(request);
  if (!login) return false;
  const user = await getUser(database.db, login);
  return user?.isReadOnly === true;
}

/**
 * 方向七：仓库可见性授权作用域。
 * 返回 `null` 表示"全部仓库可见/可管"（admin 或匿名开放模式）；否则返回当前用户
 * 被授权的一组仓库 id 与 full_name。列表型 handler 用它过滤展示行。
 */
async function visibleRepoScope(
  request: IncomingMessage,
): Promise<{ ids: Set<string> | null; fullNames: Set<string> | null } | null> {
  const login = sessionLogin(request);
  if (!login) return null; // bearer/open 模式：全可见
  const user = await getUser(database.db, login);
  if (user?.isAdmin === true) return null; // admin 兜底全可见
  const grants = await listGrantsForUser(database.db, login);
  if (grants.length === 0) return { ids: new Set(), fullNames: new Set() };
  const ids = new Set<string>();
  const fullNames = new Set<string>();
  const repoRows = await database.db
    .select({
      id: repositories.id,
      owner: repositories.owner,
      name: repositories.name,
    })
    .from(repositories)
    .where(
      inArray(
        repositories.id,
        [...new Set(grants.map((g) => g.repositoryId))],
      ),
    );
  for (const row of repoRows) {
    ids.add(row.id);
    fullNames.add(`${row.owner}/${row.name}`);
  }
  return { ids, fullNames };
}

/** admin → 全放行；否则校验仓库授权是否满足指定等级（view 或 manage）。 */
async function canAccessRepo(
  request: IncomingMessage,
  repositoryId: string,
  need: "view" | "manage",
): Promise<boolean> {
  const login = sessionLogin(request);
  if (!login) return true; // 开放/bearer 模式放行
  const user = await getUser(database.db, login);
  if (user?.isAdmin === true) return true;
  return canAccessGrant(database.db, login, repositoryId, need);
}

/**
 * Best-effort security audit entry. Never blocks the operation it records;
 * a write failure is logged and swallowed.
 */
function audit(
  request: IncomingMessage,
  action: string,
  target?: string,
  detail?: Record<string, unknown>,
): void {
  const login = sessionLogin(request);
  const entry: {
    actor: string;
    action: string;
    target?: string | undefined;
    detail?: Record<string, unknown> | undefined;
    ip?: string | undefined;
  } = { actor: login ?? "bearer", action, ip: clientIp(request) };
  if (target !== undefined) entry.target = target;
  if (detail !== undefined) entry.detail = detail;
  void writeAuditLog(database.db, entry).catch((error: unknown) =>
    logger.warn({ err: error, action }, "audit log write failed"),
  );
}

/** Security audit trail: GET /audit?limit=&offset= (admin only). */
async function handleAuditLog(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const limit = Number(url.searchParams.get("limit")) || 50;
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
  try {
    const items = await listAuditLogs(database.db, { limit, offset });
    json(response, 200, { items }, requestId);
  } catch (error) {
    logger.warn({ err: error }, "audit log list failed");
    json(response, 500, { status: "error", reason: "audit_failed" }, requestId);
  }
}

/** User management: list users; PUT /users/:login toggles admin. */
async function handleUsers(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (path === "/users" && request.method === "GET") {
    const items = await listUsers(database.db);
    json(response, 200, { items }, requestId);
    return;
  }

  if (path.startsWith("/users/") && request.method === "PUT") {
    const login = decodeURIComponent(path.slice("/users/".length)).trim();
    if (!login) {
      json(response, 400, { status: "error", reason: "login required" }, requestId);
      return;
    }
    const body = await readBody(request);
    let parsed: { isAdmin?: unknown; isReadOnly?: unknown };
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      json(response, 400, { status: "error", reason: "invalid JSON" }, requestId);
      return;
    }
    // 角色位：管理员 / 只读操作员，各自独立、未提供则保持不变。
    const roles: { isAdmin?: boolean; isReadOnly?: boolean } = {};
    if (typeof parsed.isAdmin === "boolean") roles.isAdmin = parsed.isAdmin;
    if (typeof parsed.isReadOnly === "boolean")
      roles.isReadOnly = parsed.isReadOnly;
    const user = await setUserRoles(database.db, login, roles);
    if (!user) {
      json(response, 404, { status: "error", reason: "user not found" }, requestId);
      return;
    }
    // 权限变更是高敏感操作，必须留痕。
    audit(request, "users.update_role", login, {
      isAdmin: roles.isAdmin ?? null,
      isReadOnly: roles.isReadOnly ?? null,
    });
    json(response, 200, { status: "ok", ...user }, requestId);
    return;
  }

  json(response, 405, { status: "error", reason: "method not allowed" }, requestId);
}

/* ---------- 方向七：仓库可见性授权管理（admin） ---------- */
async function handleGrants(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  if (!(await isAdminRequest(request))) {
    json(response, 403, { status: "error", reason: "admin required" }, requestId);
    return;
  }
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;

  // GET /grants[?user=&repository=]  → 列出授权（可按用户/仓库筛选）
  if (path === "/grants" && request.method === "GET") {
    const user = url.searchParams.get("user")?.trim() || undefined;
    const repository = url.searchParams.get("repository")?.trim() || undefined;
    let grants = await listAllGrants(
      database.db,
      user ? { userLogin: user } : {},
    );
    if (repository) {
      // 找出匹配该仓库（by id 或 full_name owner/name）的 repositoryId 集合。
      const allRepos = await database.db
        .select({ id: repositories.id, owner: repositories.owner, name: repositories.name })
        .from(repositories);
      const wanted = new Set<string>();
      for (const row of allRepos) {
        if (
          row.id === repository ||
          `${row.owner}/${row.name}`.toLowerCase() === repository.toLowerCase()
        )
          wanted.add(row.id);
      }
      grants = grants.filter((g) => wanted.has(g.repositoryId));
    }
    json(response, 200, { items: grants }, requestId);
    return;
  }

  // PUT /grants/:user/:repository  → 设/改授权，body { access: 'view' | 'manage' }
  if (path.startsWith("/grants/") && request.method === "PUT") {
    const rest = path.slice("/grants/".length).trim();
    const slash = rest.indexOf("/");
    if (slash <= 0 || slash === rest.length - 1) {
      json(response, 400, { status: "error", reason: "bad grant path" }, requestId);
      return;
    }
    const userLogin = decodeURIComponent(rest.slice(0, slash)).trim();
    const repositoryId = decodeURIComponent(rest.slice(slash + 1)).trim();
    const body = await readBody(request);
    let parsed: { access?: unknown };
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      json(response, 400, { status: "error", reason: "invalid JSON" }, requestId);
      return;
    }
    const access = parsed.access === "manage" ? "manage" : "view";
    if (!userLogin || !repositoryId) {
      json(response, 400, { status: "error", reason: "user and repo required" }, requestId);
      return;
    }
    // 校验用户与仓库确实存在，避免往授权表写悬空外键。
    const [user, repo] = await Promise.all([
      getUser(database.db, userLogin),
      database.db
        .select({ id: repositories.id })
        .from(repositories)
        .where(eq(repositories.id, repositoryId))
        .limit(1),
    ]);
    if (!user || repo.length === 0) {
      json(response, 404, { status: "error", reason: "user or repo not found" }, requestId);
      return;
    }
    await setGrant(database.db, userLogin, repositoryId, access);
    audit(request, "grants.set", `${userLogin}@${repositoryId}`, { access });
    json(response, 200, { status: "ok", userLogin, repositoryId, access }, requestId);
    return;
  }

  // DELETE /grants/:user/:repository → 移除授权
  if (path.startsWith("/grants/") && request.method === "DELETE") {
    const rest = path.slice("/grants/".length).trim();
    const slash = rest.indexOf("/");
    if (slash <= 0 || slash === rest.length - 1) {
      json(response, 400, { status: "error", reason: "bad grant path" }, requestId);
      return;
    }
    const userLogin = decodeURIComponent(rest.slice(0, slash)).trim();
    const repositoryId = decodeURIComponent(rest.slice(slash + 1)).trim();
    const removed = await deleteGrant(database.db, userLogin, repositoryId);
    if (!removed) {
      json(response, 404, { status: "error", reason: "grant not found" }, requestId);
      return;
    }
    audit(request, "grants.remove", `${userLogin}@${repositoryId}`, {});
    json(response, 200, { status: "ok", removed: true }, requestId);
    return;
  }

  json(response, 405, { status: "error", reason: "method not allowed" }, requestId);
}

/* ---------- install wizard / one-click init ---------- */
const DEFAULT_POLICIES = [
  { role: "issue_analysis", version: "issue-analysis-v1" },
  { role: "pr_review", version: "pr-review-v1" },
  { role: "duplicate_judgment", version: "duplicate-judgment-v1" },
  { role: "memory_consolidation", version: "memory-consolidation-v1" },
] as const;

async function tableCount(names: string[]): Promise<number> {
  const rows = await database.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY(${names})
  `;
  return rows[0]?.n ?? 0;
}

/** Setup diagnostics (public; shown by the install wizard before login). */
async function handleSetupStatus(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  let dbOk = false;
  let tablesReady = 0;
  let providerCount = 0;
  let policyCount = 0;
  try {
    const h = await checkDatabase(database.sql, config.healthCheckTimeoutMs);
    dbOk = h.status === "ok";
    tablesReady = dbOk
      ? await tableCount([
          "analysis_tasks",
          "task_events",
          "subject_results",
          "system_settings",
          "model_role_policies",
          "provider_accounts",
        ])
      : 0;
    if (dbOk) {
      const [p, pol] = await Promise.all([
        database.db
          .select({ id: providerAccounts.id })
          .from(providerAccounts)
          .limit(100),
        database.db
          .select({ id: modelRolePolicies.id })
          .from(modelRolePolicies)
          .limit(100),
      ]);
      providerCount = p.length;
      policyCount = pol.length;
    }
  } catch {
    dbOk = false;
  }
  const providerKey = Object.keys(config.modelProviderBaseUrls)[0] ?? "";
  const initialized =
    dbOk && tablesReady === 6 && policyCount >= DEFAULT_POLICIES.length;
  const appConfigured = await githubAppConfiguredFlag();
  json(
    response,
    200,
    {
      database: { ok: dbOk, tablesReady, tablesTotal: 6 },
      provider: {
        count: providerCount,
        providerKey,
        model: config.defaultLlmModel,
      },
      policies: { count: policyCount, required: DEFAULT_POLICIES.length },
      githubWebhookConfigured: webhookEnabled(),
      githubAppConfigured: appConfigured,
      oauthConfigured: oauthConfigured(),
      embeddingConfigured: Boolean(
        embeddingConfig().baseUrl && embeddingConfig().apiKey,
      ),
      initialized,
      // The WebUI bearer token is surfaced only while the system is still
      // uninitialized so a fresh install can record it once. Once installed,
      // the token is never exposed through this public endpoint.
      ...(initialized ? {} : { webuiToken: webuiToken() }),
    },
    requestId,
  );
}

/** One-click init: seed default model role policies if none exist. */
async function handleSetupInit(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  try {
    const existing = await database.db
      .select({ id: modelRolePolicies.id })
      .from(modelRolePolicies)
      .limit(1);
    if (existing.length > 0) {
      json(
        response,
        200,
        { status: "ok", created: 0, reason: "already_initialized" },
        requestId,
      );
      return;
    }
    const providerKey = Object.keys(config.modelProviderBaseUrls)[0] ?? "";
    const accounts = await database.db
      .select({ name: providerAccounts.name })
      .from(providerAccounts)
      .limit(1);
    const accountName = accounts[0]?.name;
    const created = [];
    if (providerKey && accountName) {
      for (const policy of DEFAULT_POLICIES) {
        await database.db.insert(modelRolePolicies).values({
          role: policy.role,
          version: policy.version,
          candidates: [
            { provider: providerKey, model: config.defaultLlmModel, accountName },
          ],
        });
        created.push(policy.role);
      }
    }
    json(
      response,
      200,
      {
        status: "ok",
        created: created.length,
        roles: created,
        skipped:
          created.length === 0
            ? "model provider/account not configured"
            : undefined,
      },
      requestId,
    );
  } catch (error) {
    logger.warn({ err: error }, "setup init failed");
    json(response, 500, { status: "error", reason: "init_failed" }, requestId);
  }
}

/** Role policy versions written/updated by the wizard's model step. */
const SETUP_ROLES: readonly { role: string; version: string }[] = [
  ...DEFAULT_POLICIES,
  { role: "expert_review", version: "expert-review-v1" },
  { role: "spam_detection", version: "spam-detection-v1" },
  // 图片多模态专用角色：与 issue_analysis 视觉分流，默认就位（随 provider 添加自动建）。
  { role: "issue_analysis_vision", version: "issue-analysis-v1" },
];

/** Parses a JSON request body into an object; null on malformed input. */
async function parseJsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown> | null> {
  const raw = await readBody(request).catch(() => Buffer.alloc(0));
  try {
    const value: unknown = JSON.parse(raw.toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * POST /setup/models — proxies an OpenAI-compatible `/models` listing so the
 * wizard can offer a model dropdown. No state is persisted.
 */
/**
 * 把用户填写的 Base URL 归一化为 OpenAI 兼容的 API 根（形如 `.../v1`）。
 *
 * 用户从供应商站点复制的地址形式很多：带或不带 `/v1`、带尾斜杠、甚至直接
 * 复制了完整的 chat/completions 端点。原先只做字符串拼接，后两种都会 404
 * （issue #13）。
 */
export function openAiApiRoot(rawBaseUrl: string): string {
  let base = rawBaseUrl.trim().replace(/\/+$/, "");
  // 用户误填完整端点时，回退到其所在的 API 根。
  base = base.replace(/\/(?:chat\/)?completions$/i, "");
  base = base.replace(/\/models$/i, "");
  base = base.replace(/\/+$/, "");
  // 绝大多数 OpenAI 兼容网关都在 /v1 下；缺失时补上。
  if (!/\/v\d+$/i.test(base)) base = `${base}/v1`;
  return base;
}

export function openAiModelsEndpoint(rawBaseUrl: string): string {
  return `${openAiApiRoot(rawBaseUrl)}/models`;
}

/** 运行时保存的 provider 基址键，与环境变量同名 provider 合并使用。 */
export function providerBaseUrlSettingKey(provider: string): string {
  return `model_provider_base_url:${provider}`;
}

async function handleSetupModels(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const body = await parseJsonBody(request);
  const baseUrl =
    typeof body?.baseUrl === "string"
      ? body.baseUrl.trim().replace(/\/+$/, "")
      : "";
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  if (!baseUrl || !apiKey) {
    json(
      response,
      400,
      { status: "error", reason: "baseUrl and apiKey required" },
      requestId,
    );
    return;
  }
  try {
    const endpoint = openAiModelsEndpoint(baseUrl);
    // 公益站/自建网关可能很慢或无响应，没有超时会让请求一直挂着。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(endpoint, {
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // 上游的错误正文才是用户能据以行动的信息（密钥无效 / 余额不足 /
      // 路径不对）。只回 httpStatus 会让用户完全无从判断。
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      json(
        response,
        502,
        {
          status: "error",
          reason: "models_request_failed",
          httpStatus: res.status,
          endpoint,
          ...(detail ? { detail } : {}),
        },
        requestId,
      );
      return;
    }
    const data = (await res.json()) as { data?: { id?: string }[] };
    const models = (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string")
      .sort();
    json(response, 200, { status: "ok", models }, requestId);
  } catch (error) {
    logger.warn({ err: error }, "setup models fetch failed");
    const aborted = error instanceof Error && error.name === "AbortError";
    json(
      response,
      502,
      {
        status: "error",
        reason: aborted ? "models_fetch_timeout" : "models_fetch_failed",
        ...(error instanceof Error && !aborted
          ? { detail: error.message.slice(0, 200) }
          : {}),
      },
      requestId,
    );
  }
}

/**
 * POST /setup/provider — saves a model provider account (API key encrypted
 * under the master key) and wires it as the primary candidate of every role
 * policy, keeping existing providers as failover.
 */
async function handleSetupProvider(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const body = await parseJsonBody(request);
  const provider =
    typeof body?.provider === "string" ? body.provider.trim() : "";
  const baseUrl =
    typeof body?.baseUrl === "string"
      ? body.baseUrl.trim().replace(/\/+$/, "")
      : "";
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  const model = typeof body?.model === "string" ? body.model.trim() : "";
  const accountName =
    typeof body?.accountName === "string" && body.accountName.trim().length > 0
      ? body.accountName.trim()
      : `${provider || "model"}-main`;
  // 编辑已有账户时 apiKey 可留空（保留旧密钥，只更新 baseUrl/model）；新建必填。
  if (!provider || !baseUrl || !model) {
    json(
      response,
      400,
      {
        status: "error",
        reason: "provider, baseUrl and model required",
      },
      requestId,
    );
    return;
  }
  if (!config.credentialMasterKey) {
    json(
      response,
      400,
      {
        status: "error",
        reason: "master_key_missing",
        hint: "Set CREDENTIAL_MASTER_KEY to store provider credentials",
      },
      requestId,
    );
    return;
  }
  try {
    const cipher = createCredentialCipher(config.credentialMasterKey);
    // apiKey 留空时从库里读取现有密文保留原密钥（支持编辑表单不重填密钥）；
    // 无现有密文且未给 key 则报错。
    let sealed: string;
    if (apiKey) {
      sealed = cipher.seal(apiKey);
    } else {
      const existing = await database.db
        .select({ credential: providerAccounts.encryptedCredential })
        .from(providerAccounts)
        .where(
          and(
            eq(providerAccounts.provider, provider),
            eq(providerAccounts.name, accountName),
          ),
        )
        .limit(1);
      const current = existing[0]?.credential;
      if (!current) {
        json(
          response,
          400,
          {
            status: "error",
            reason: "api_key_required",
            hint: "新建 provider 必须提供 apiKey",
          },
          requestId,
        );
        return;
      }
      sealed = current;
    }
    await database.db
      .insert(providerAccounts)
      .values({ provider, name: accountName, encryptedCredential: sealed })
      .onConflictDoUpdate({
        target: [providerAccounts.provider, providerAccounts.name],
        set: { encryptedCredential: sealed, updatedAt: new Date() },
      });

    // 持久化 baseUrl：此前它只被校验、从未保存，worker 的 adapter 仅按环境变量
    // MODEL_PROVIDER_BASE_URLS 构造，因此界面新增的 provider 没有对应 adapter，
    // 模型路由会直接判为 model_not_found（issue #13 / #2 的根因之一）。
    const apiRoot = openAiApiRoot(baseUrl);
    await database.db
      .insert(systemSettings)
      .values({ key: providerBaseUrlSettingKey(provider), value: apiRoot })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: apiRoot, updatedAt: new Date() },
      });

    const newCandidate = { provider, model, accountName };
    let policiesUpdated = 0;
    for (const { role, version } of SETUP_ROLES) {
      const rows = await database.db
        .select({ candidates: modelRolePolicies.candidates })
        .from(modelRolePolicies)
        .where(eq(modelRolePolicies.role, role))
        .orderBy(desc(modelRolePolicies.createdAt))
        .limit(1);
      const existing = Array.isArray(rows[0]?.candidates)
        ? (rows[0].candidates as unknown[])
        : [];
      const merged = [
        newCandidate,
        ...existing.filter((entry) => {
          const value = entry as Record<string, unknown>;
          return !(
            value.provider === provider && value.accountName === accountName
          );
        }),
      ];
      await database.db
        .insert(modelRolePolicies)
        .values({ role, version, candidates: merged })
        .onConflictDoUpdate({
          target: [modelRolePolicies.role, modelRolePolicies.version],
          set: { candidates: merged },
        });
      policiesUpdated += 1;
    }
    audit(request, "setup.provider", provider, {
      account: accountName,
      policies: policiesUpdated,
    });
    json(
      response,
      200,
      { status: "ok", provider, accountName, model, policiesUpdated },
      requestId,
    );
  } catch (error) {
    logger.warn({ err: error }, "setup provider failed");
    json(response, 500, { status: "error", reason: "provider_save_failed" }, requestId);
  }
}

/**
 * POST /providers/delete — deletes a model provider account and removes it from
 * every role policy's candidate list (issue #58). Deleting a provider that is
 * still referenced elsewhere is safe: candidates are pruned, remaining ones
 * keep serving as failover. BaseUrl setting is kept (provider may still be
 * configured via env or re-added later).
 */
async function handleProviderDelete(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const body = await readBody(request);
  let parsed: { provider?: unknown; accountName?: unknown };
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    json(response, 400, { status: "error", reason: "invalid JSON" }, requestId);
    return;
  }
  const provider =
    typeof parsed.provider === "string" ? parsed.provider.trim() : "";
  const accountName =
    typeof parsed.accountName === "string" ? parsed.accountName.trim() : "";
  if (!provider || !accountName) {
    json(
      response,
      400,
      {
        status: "error",
        reason: "provider and accountName required",
      },
      requestId,
    );
    return;
  }
  try {
    await database.db
      .delete(providerAccounts)
      .where(
        and(
          eq(providerAccounts.provider, provider),
          eq(providerAccounts.name, accountName),
        ),
      );
    // 从各角色策略的 candidates 中剔除被删账户，保留其余候选。
    const policies = await database.db
      .select({
        id: modelRolePolicies.id,
        role: modelRolePolicies.role,
        version: modelRolePolicies.version,
        candidates: modelRolePolicies.candidates,
      })
      .from(modelRolePolicies);
    for (const policy of policies) {
      const candidates = Array.isArray(policy.candidates)
        ? (policy.candidates as unknown[])
        : [];
      const pruned = candidates.filter((entry) => {
        const value = entry as Record<string, unknown>;
        return !(
          value.provider === provider && value.accountName === accountName
        );
      });
      if (pruned.length === candidates.length) continue;
      await database.db
        .update(modelRolePolicies)
        .set({ candidates: pruned })
        .where(eq(modelRolePolicies.id, policy.id));
    }
    audit(request, "provider.delete", provider, { account: accountName });
    json(response, 200, { status: "ok", provider, accountName }, requestId);
  } catch (error) {
    logger.warn({ err: error }, "provider delete failed");
    json(
      response,
      500,
      { status: "error", reason: "provider_delete_failed" },
      requestId,
    );
  }
}

/** POST /setup/embedding — stores the embedding endpoint as a hot setting. */
async function handleSetupEmbedding(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const body = await parseJsonBody(request);
  const baseUrl =
    typeof body?.baseUrl === "string"
      ? body.baseUrl.trim().replace(/\/+$/, "")
      : "";
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  const model = typeof body?.model === "string" ? body.model.trim() : "";
  if (!baseUrl || !apiKey || !model) {
    json(
      response,
      400,
      { status: "error", reason: "baseUrl, apiKey and model required" },
      requestId,
    );
    return;
  }
  try {
    await Promise.all([
      upsertSetting("embedding_base_url", baseUrl),
      upsertSetting("embedding_api_key", apiKey),
      upsertSetting("embedding_model", model),
    ]);
    audit(request, "setup.embedding", undefined, { baseUrl, model });
    json(
      response,
      200,
      { status: "ok", baseUrl, model, embeddingConfigured: true },
      requestId,
    );
  } catch (error) {
    logger.warn({ err: error }, "setup embedding failed");
    json(response, 500, { status: "error", reason: "embedding_save_failed" }, requestId);
  }
}

/** POST /setup/webhook-secret — generates and stores a GitHub webhook secret. */
async function handleSetupWebhookSecret(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  try {
    const secret = randomBytes(24).toString("hex");
    await upsertSetting("github_webhook_secret", secret);
    audit(request, "setup.webhook-secret", undefined, undefined);
    json(response, 200, { status: "ok", secret }, requestId);
  } catch (error) {
    logger.warn({ err: error }, "setup webhook secret failed");
    json(response, 500, { status: "error", reason: "webhook_secret_failed" }, requestId);
  }
}

/**
 * POST /setup/oauth — persists a GitHub OAuth client id (when supplied) and
 * generates a fresh client secret; returns both plus the callback path.
 */
/**
 * POST /setup/github-app — 保存 GitHub App ID 与私钥（私钥 AES-GCM 加密）。
 *
 * 保存前先用该私钥签一个 App JWT 调 GET /app 验证：凭据错误必须当场告诉用户，
 * 而不是等到同步仓库时才抛出 github_not_configured（用户此前就是这样卡住的）。
 */
async function handleSetupGithubApp(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const body = await parseJsonBody(request);
  const appId = typeof body?.appId === "string" ? body.appId.trim() : "";
  const privateKeyPem =
    typeof body?.privateKeyPem === "string" ? body.privateKeyPem.trim() : "";

  if (!appId || !privateKeyPem) {
    json(
      response,
      400,
      { status: "error", reason: "appId and privateKeyPem required" },
      requestId,
    );
    return;
  }
  if (!/^\d+$/.test(appId)) {
    json(
      response,
      400,
      {
        status: "error",
        reason: "invalid_app_id",
        hint: "App ID 是一串数字，可在 GitHub App 设置页顶部看到；不要填 Client ID",
      },
      requestId,
    );
    return;
  }
  if (!privateKeyPem.includes("PRIVATE KEY")) {
    json(
      response,
      400,
      {
        status: "error",
        reason: "invalid_private_key",
        hint: "请粘贴 GitHub 下载的 .pem 文件全文，包含 BEGIN/END PRIVATE KEY 两行",
      },
      requestId,
    );
    return;
  }
  if (!config.credentialMasterKey) {
    json(
      response,
      400,
      {
        status: "error",
        reason: "master_key_missing",
        hint: "Set CREDENTIAL_MASTER_KEY to store the GitHub App private key",
      },
      requestId,
    );
    return;
  }

  // 用候选凭据实际调一次 GitHub，确认 App ID 与私钥匹配且未被吊销。
  let appSlug: string | null = null;
  try {
    const probe = createGitHubClient({
      appId,
      privateKeyPem,
      ...(config.githubApiBaseUrl
        ? { apiBaseUrl: config.githubApiBaseUrl }
        : {}),
    });
    const app = await probe.getAppMetadata();
    appSlug = app.slug;
  } catch (error) {
    logger.warn({ err: error }, "GitHub App credential probe failed");
    const detail =
      error instanceof Error ? error.message.slice(0, 200) : undefined;
    json(
      response,
      400,
      {
        status: "error",
        reason: "github_app_probe_failed",
        hint: "GitHub 拒绝了这组凭据：请确认 App ID 与私钥来自同一个 GitHub App，且私钥未被吊销",
        ...(detail ? { detail } : {}),
      },
      requestId,
    );
    return;
  }

  try {
    const cipher = createCredentialCipher(config.credentialMasterKey);
    const sealed = cipher.seal(privateKeyPem);
    for (const [key, value] of [
      ["github_app_id", appId],
      ["github_app_private_key", sealed],
    ] as const) {
      await database.db
        .insert(systemSettings)
        .values({ key, value })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value, updatedAt: new Date() },
        });
    }
    // 立即重建客户端，用户不必重启容器。
    reloadGithubClient();
    await refreshRuntimeSettings();
    audit(request, "setup.github_app", appId, { appSlug });
    json(response, 200, { status: "ok", appId, appSlug }, requestId);
  } catch (error) {
    logger.warn({ err: error }, "GitHub App save failed");
    json(
      response,
      500,
      { status: "error", reason: "github_app_save_failed" },
      requestId,
    );
  }
}

async function handleSetupOAuth(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const body = await parseJsonBody(request);
  const clientId =
    typeof body?.clientId === "string" && body.clientId.trim().length > 0
      ? body.clientId.trim()
      : currentOAuth().clientId;
  if (!clientId) {
    json(
      response,
      400,
      { status: "error", reason: "clientId required" },
      requestId,
    );
    return;
  }
  try {
    const clientSecret = randomBytes(24).toString("hex");
    await Promise.all([
      upsertSetting("oauth_client_id", clientId),
      upsertSetting("oauth_client_secret", clientSecret),
    ]);
    audit(request, "setup.oauth", undefined, { clientId });
    json(
      response,
      200,
      { status: "ok", clientId, clientSecret, callbackPath: "/auth/callback" },
      requestId,
    );
  } catch (error) {
    logger.warn({ err: error }, "setup oauth failed");
    json(response, 500, { status: "error", reason: "oauth_save_failed" }, requestId);
  }
}

const resultColumns = {
  subjectType: subjectResults.subjectType,
  subjectNumber: subjectResults.subjectNumber,
  repositoryFullName: subjectResults.repositoryFullName,
  revision: subjectResults.revision,
  result: subjectResults.result,
  published: subjectResults.published,
  createdAt: subjectResults.createdAt,
} as const;

/**
 * Lists persisted results by type (`/results?type=issue|pr`) or all revisions
 * for one subject (`/results/:type/:number`). Used by the WebUI result pages.
 */
async function handleResults(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  const path = url.pathname;

  // /results/:type/:number -> all revisions of one subject
  if (path.startsWith("/results/")) {
    const parts = path.split("/").filter(Boolean);
    const type = parts[1];
    const number = Number(parts[2]);
    if ((type !== "issue" && type !== "pr") || !Number.isInteger(number)) {
      json(
        response,
        400,
        { status: "error", reason: "invalid result path" },
        requestId,
      );
      return;
    }
    const items = await database.db
      .select(resultColumns)
      .from(subjectResults)
      .where(
        and(
          eq(subjectResults.subjectType, type),
          eq(subjectResults.subjectNumber, number),
        ),
      )
      .orderBy(desc(subjectResults.createdAt))
      .limit(50);
    json(response, 200, { items }, requestId);
    return;
  }

  // /results?type=issue|pr
  const type = url.searchParams.get("type");
  if (type !== "issue" && type !== "pr") {
    json(
      response,
      400,
      { status: "error", reason: "type=issue|pr required" },
      requestId,
    );
    return;
  }
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100)
    : 25;
  // Offset pagination avoids skipping rows that share a createdAt millisecond.
  const offsetRaw = Number(url.searchParams.get("offset"));
  const offset = Number.isFinite(offsetRaw)
    ? Math.max(Math.trunc(offsetRaw), 0)
    : 0;
  // 方向七：非 admin 仅列出被授权仓库的结果。
  const scope = await visibleRepoScope(request);
  const where =
    scope && scope.fullNames !== null
      ? and(
          eq(subjectResults.subjectType, type),
          inArray(subjectResults.repositoryFullName, [...scope.fullNames]),
        )
      : eq(subjectResults.subjectType, type);
  const items = await database.db
    .select(resultColumns)
    .from(subjectResults)
    .where(where)
    .orderBy(desc(subjectResults.createdAt), desc(subjectResults.id))
    .limit(limit)
    .offset(offset);
  const nextOffset = items.length === limit ? offset + limit : undefined;
  json(
    response,
    200,
    nextOffset === undefined ? { items } : { items, nextOffset },
    requestId,
  );
}

/**
 * POST /results/delete — batch-deletes persisted results (admin only).
 * Body: `{"items":[{"subjectType","subjectNumber","repositoryFullName","revision"}]}`.
 * Each item removes the matching subject_results row(s). Returns how many rows
 * were deleted and how many items matched nothing. Also removes the task's
 * external publications so revoke bookkeeping does not linger.
 */
async function handleResultsDelete(
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
  const body = await readBody(request);
  let parsed: { items?: unknown };
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    json(response, 400, { status: "error", reason: "invalid JSON" }, requestId);
    return;
  }
  const items = Array.isArray(parsed.items)
    ? (parsed.items as Record<string, unknown>[]).filter(
        (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
      )
    : [];
  if (items.length === 0) {
    json(
      response,
      400,
      { status: "error", reason: "items must be a non-empty array" },
      requestId,
    );
    return;
  }

  let deleted = 0;
  let notFound = 0;
  for (const item of items) {
    const subjectType = item.subjectType === "pr" ? "pr" : "issue";
    const subjectNumber = Number(item.subjectNumber);
    const repositoryFullName = typeof item.repositoryFullName === "string" ? item.repositoryFullName : "";
    const revision = typeof item.revision === "string" ? item.revision : "";
    if (!Number.isInteger(subjectNumber) || subjectNumber <= 0 || !repositoryFullName) {
      notFound += 1;
      continue;
    }
    const conditions = [
      eq(subjectResults.subjectType, subjectType),
      eq(subjectResults.subjectNumber, subjectNumber),
      eq(subjectResults.repositoryFullName, repositoryFullName),
    ];
    if (revision) conditions.push(eq(subjectResults.revision, revision));

    const rows = await database.db
      .select({ id: subjectResults.id, taskId: subjectResults.taskId })
      .from(subjectResults)
      .where(and(...conditions));
    if (rows.length === 0) {
      notFound += 1;
      continue;
    }
    const resultIds = rows.map((r) => r.id);
    await database.db
      .delete(subjectResults)
      .where(
        and(
          eq(subjectResults.subjectType, subjectType),
          eq(subjectResults.subjectNumber, subjectNumber),
          eq(subjectResults.repositoryFullName, repositoryFullName),
        ),
      );
    deleted += resultIds.length;
    // 清理该主体的 external_publications 书签，避免撤回/Check Run 查询残留。
    const taskIds = rows
      .map((r) => r.taskId)
      .filter((t): t is string => Boolean(t));
    if (taskIds.length > 0) {
      await database.db
        .delete(externalPublications)
        .where(inArray(externalPublications.taskId, taskIds));
    }
  }
  audit(request, "results.delete", undefined, { items: items.length, deleted, notFound });
  json(response, 200, { status: "ok", deleted, notFound }, requestId);
}

/**
 * Repository memory management:
 *  - GET /memory: list (any authenticated user), filterable by repositoryId /
 *    kind, offset-paginated; always returns per-kind counts for the UI cards.
 *  - POST /memory: admin, create a manual rule/knowledge entry (issue #32);
 *    consolidated=true so it is immediately part of the analysis context.
 *  - POST /memory/consolidate: admin, runs one memory-consolidation sweep.
 *  - DELETE /memory/:id: admin, removes a single memory row.
 */
async function handleMemory(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  const path = url.pathname;

  if (path === "/memory" && request.method === "GET") {
    const repositoryId =
      url.searchParams.get("repositoryId")?.trim() || undefined;
    const kindRaw = url.searchParams.get("kind");
    const kind =
      kindRaw === "reflection" || kindRaw === "rule" || kindRaw === "knowledge"
        ? kindRaw
        : undefined;
    const limitRaw = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200)
      : 50;
    const offsetRaw = Number(url.searchParams.get("offset"));
    const offset = Number.isFinite(offsetRaw)
      ? Math.max(Math.trunc(offsetRaw), 0)
      : 0;
    try {
      const [items, countsRows] = await Promise.all([
        listRepoMemory(database.db, { repositoryId, kind, limit, offset }),
        database.sql<{ kind: string; c: number }[]>`
          SELECT kind, count(*)::int AS c FROM repo_memory GROUP BY kind
        `,
      ]);
      const counts: Record<string, number> = {
        reflection: 0,
        rule: 0,
        knowledge: 0,
      };
      for (const row of countsRows) {
        if (row.kind === "reflection") counts.reflection = Number(row.c);
        else if (row.kind === "rule") counts.rule = Number(row.c);
        else if (row.kind === "knowledge") counts.knowledge = Number(row.c);
      }
      const nextOffset = items.length === limit ? offset + limit : undefined;
      json(
        response,
        200,
        nextOffset === undefined
          ? { items, counts }
          : { items, counts, nextOffset },
        requestId,
      );
    } catch (error) {
      logger.warn({ err: error }, "memory list failed");
      json(response, 500, { status: "error", reason: "memory_failed" }, requestId);
    }
    return;
  }

  if (path === "/memory" && request.method === "POST") {
    if (!(await isAdminRequest(request))) {
      json(
        response,
        403,
        { status: "error", reason: "admin required" },
        requestId,
      );
      return;
    }
    const body = await readBody(request);
    let parsed: {
      kind?: unknown;
      title?: unknown;
      content?: unknown;
      repositoryId?: unknown;
    };
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      json(response, 400, { status: "error", reason: "invalid JSON" }, requestId);
      return;
    }
    const kind = parsed.kind;
    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    const content =
      typeof parsed.content === "string" ? parsed.content.trim() : "";
    const repositoryId =
      typeof parsed.repositoryId === "string" && parsed.repositoryId.trim().length > 0
        ? parsed.repositoryId.trim()
        : undefined;
    // 手动写入只允许 rule / knowledge：reflection 是自动沉淀的，不允许人工伪装。
    if (kind !== "rule" && kind !== "knowledge") {
      json(
        response,
        400,
        { status: "error", reason: "kind must be rule or knowledge" },
        requestId,
      );
      return;
    }
    if (!title || !content) {
      json(
        response,
        400,
        { status: "error", reason: "title and content required" },
        requestId,
      );
      return;
    }
    if (repositoryId && !UUID_PATTERN.test(repositoryId)) {
      json(
        response,
        400,
        { status: "error", reason: "invalid repositoryId" },
        requestId,
      );
      return;
    }
    try {
      // consolidated=true：手动规则/知识立即进入分析上下文（issue #32）。
      await writeRepoMemory(database.db, {
        repositoryId,
        kind,
        title,
        content,
        sourceType: "manual",
        consolidated: true,
      });
      audit(request, "memory.create", undefined, {
        kind,
        title,
        repositoryId: repositoryId ?? null,
      });
      json(response, 200, { status: "ok" }, requestId);
    } catch (error) {
      logger.warn({ err: error }, "memory create failed");
      json(response, 500, { status: "error", reason: "memory_failed" }, requestId);
    }
    return;
  }

  if (path === "/memory/consolidate" && request.method === "POST") {
    if (!(await isAdminRequest(request))) {
      json(
        response,
        403,
        { status: "error", reason: "admin required" },
        requestId,
      );
      return;
    }
    try {
      const result = await memoryConsolidationSweep(database, logger);
      audit(request, "memory.consolidate", undefined, {
        repositories: result.repositories,
        rules: result.rules,
      });
      json(response, 200, { status: "ok", ...result }, requestId);
    } catch (error) {
      logger.warn({ err: error }, "memory consolidation failed");
      json(
        response,
        500,
        { status: "error", reason: "consolidate_failed" },
        requestId,
      );
    }
    return;
  }

  if (path.startsWith("/memory/") && request.method === "DELETE") {
    if (!(await isAdminRequest(request))) {
      json(
        response,
        403,
        { status: "error", reason: "admin required" },
        requestId,
      );
      return;
    }
    const id = decodeURIComponent(path.slice("/memory/".length)).trim();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    ) {
      json(
        response,
        400,
        { status: "error", reason: "invalid memory id" },
        requestId,
      );
      return;
    }
    try {
      const deleted = await deleteRepoMemory(database.db, id);
      if (deleted) audit(request, "memory.delete", id);
      json(
        response,
        deleted ? 200 : 404,
        { status: deleted ? "ok" : "error" },
        requestId,
      );
    } catch (error) {
      logger.warn({ err: error }, "memory delete failed");
      json(response, 500, { status: "error", reason: "delete_failed" }, requestId);
    }
    return;
  }

  json(
    response,
    405,
    { status: "error", reason: "method not allowed" },
    requestId,
  );
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestId = request.headers["x-request-id"]?.toString() || randomUUID();
  const requestLogger = withCorrelation(logger, { requestId });
  const path = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  ).pathname;
  const ip = clientIp(request);
  const now = Date.now();

  // Webhook flood protection is independent of the WebUI API budget.
  if (
    path === "/github/webhook" &&
    rateLimited(ip, config.webhookRateLimit, now)
  ) {
    json(response, 429, { status: "error", reason: "rate_limited" }, requestId);
    requestLogger.warn({ ip }, "webhook rate limited");
    return;
  }

  if (requiresAuth(path) && rateLimited(ip, config.apiRateLimit, now)) {
    json(response, 429, { status: "error", reason: "rate_limited" }, requestId);
    requestLogger.warn({ ip, path }, "api rate limited");
    return;
  }

  if (requiresAuth(path) && !isAuthorized(request)) {
    json(response, 401, { status: "error", reason: "unauthorized" }, requestId);
    return;
  }

  // 只读操作员（OAuth）：允许查看，禁止一切写操作；仅放行个人显示名更新。
  // Bearer token 是管理员凭据，永不落入只读。
  if (
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

  if (path === "/metrics") {
    if (request.method !== "GET") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    if (!(await isAdminRequest(request))) {
      json(
        response,
        403,
        { status: "error", reason: "admin required" },
        requestId,
      );
      return;
    }
    await handleMetrics(response, requestId);
    return;
  }

  if (path === "/alerts") {
    if (request.method !== "GET") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    if (!(await isAdminRequest(request))) {
      json(
        response,
        403,
        { status: "error", reason: "admin required" },
        requestId,
      );
      return;
    }
    await handleAlerts(response, requestId);
    return;
  }

  if (
    path === "/auth/status" ||
    path === "/auth/login" ||
    path === "/auth/callback"
  ) {
    // POST /auth/login 走本地密码登录（方向一）；GET 走 GitHub OAuth 重定向。
    if (path === "/auth/login" && request.method === "POST") {
      await handleLocalAuth(request, response, requestId);
    } else {
      await handleAuth(request, response, requestId);
    }
    return;
  }

  if (
    path === "/auth/register" ||
    path === "/auth/logout" ||
    path === "/auth/password" ||
    path === "/auth/sessions" ||
    path.startsWith("/auth/sessions/")
  ) {
    await handleLocalAuth(request, response, requestId);
    return;
  }

  if (path === "/auth/me") {
    await handleAccount(request, response, requestId);
    return;
  }

  if (path === "/setup/status") {
    if (request.method !== "GET") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    await handleSetupStatus(response, requestId);
    return;
  }

  if (path === "/setup/init") {
    if (request.method !== "POST") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    if (!(await isAdminRequest(request))) {
      json(
        response,
        403,
        { status: "error", reason: "admin required" },
        requestId,
      );
      return;
    }
    await handleSetupInit(request, response, requestId);
    return;
  }

  const setupWriteRoutes: Record<string, (req: IncomingMessage, res: ServerResponse, rid: string) => Promise<void>> = {
    "/setup/models": handleSetupModels,
    "/setup/provider": handleSetupProvider,
    "/setup/embedding": handleSetupEmbedding,
    "/setup/webhook-secret": handleSetupWebhookSecret,
    "/setup/github-app": handleSetupGithubApp,
    "/setup/oauth": handleSetupOAuth,
  };
  const setupHandler = setupWriteRoutes[path];
  if (setupHandler) {
    if (request.method !== "POST") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    if (!(await isAdminRequest(request))) {
      json(
        response,
        403,
        { status: "error", reason: "admin required" },
        requestId,
      );
      return;
    }
    await setupHandler(request, response, requestId);
    return;
  }

  if (path === "/webhook-selftest" && request.method === "POST") {
    if (!(await isAdminRequest(request))) {
      json(
        response,
        403,
        { status: "error", reason: "admin required" },
        requestId,
      );
      return;
    }
    await handleWebhookSelfTest(request, response, requestId);
    return;
  }

  if (path === "/github/webhook") {
    if (request.method !== "POST") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    await handleWebhook(request, response, requestId);
    return;
  }

  if (path === "/events") {
    if (request.method !== "GET") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    handleSse(request, response);
    return;
  }

  if (path === "/settings/bootstrap") {
    if (request.method !== "GET") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    handleSettingsBootstrap(response, requestId);
    return;
  }

  if (path === "/settings") {
    await handleSettings(request, response, requestId);
    return;
  }

  if (path === "/update/status") {
    if (request.method !== "GET") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    await handleUpdateStatus(response, requestId);
    return;
  }

  if (path === "/update/history") {
    if (request.method !== "GET") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    if (!(await isAdminRequest(request))) {
      json(
        response,
        403,
        { status: "error", reason: "admin required" },
        requestId,
      );
      return;
    }
    await handleUpdateHistory(response, requestId, database.db);
    return;
  }

  if (path === "/update/apply") {
    if (request.method !== "POST") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    const isAdmin = await isAdminRequest(request);
    await handleUpdateApply(
      request,
      response,
      requestId,
      isAdmin,
      database.db,
      (detail) => audit(request, "update.apply", undefined, detail),
    );
    return;
  }

  if (path === "/bot/status") {
    if (request.method !== "GET") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    if (!(await isAdminRequest(request))) {
      json(
        response,
        403,
        { status: "error", reason: "admin required" },
        requestId,
      );
      return;
    }
    await handleBotStatus(response, requestId);
    return;
  }

  if (path === "/bot/start" || path === "/bot/stop") {
    if (request.method !== "POST") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    if (!(await isAdminRequest(request))) {
      json(
        response,
        403,
        { status: "error", reason: "admin required" },
        requestId,
      );
      return;
    }
    if (path === "/bot/start") {
      await handleBotStart(response, requestId);
    } else {
      await handleBotStop(response, requestId);
    }
    return;
  }

  if (path === "/capabilities") {
    await handleCapabilities(request, response, requestId);
    return;
  }

  if (path === "/index/run" || path === "/index/rebuild") {
    if (request.method !== "POST") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    if (path === "/index/rebuild") {
      await handleIndexRebuild(request, response, requestId);
    } else {
      await handleIndexRun(request, response, requestId);
    }
    return;
  }

  if (path === "/index/status") {
    if (request.method !== "GET") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    await handleIndexStatus(response, requestId);
    return;
  }

  if (path === "/index/related") {
    if (request.method !== "GET") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    await handleIndexRelated(request, response, requestId);
    return;
  }

  if (path === "/label-rules" || path.startsWith("/label-rules/")) {
    await handleLabelRules(request, response, requestId);
    return;
  }

  if (path === "/users" || path.startsWith("/users/")) {
    if (!(await isAdminRequest(request))) {
      json(
        response,
        403,
        { status: "error", reason: "admin required" },
        requestId,
      );
      return;
    }
    await handleUsers(request, response, requestId);
    return;
  }

  if (path === "/audit") {
    if (request.method !== "GET") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    if (!(await isAdminRequest(request))) {
      json(
        response,
        403,
        { status: "error", reason: "admin required" },
        requestId,
      );
      return;
    }
    await handleAuditLog(request, response, requestId);
    return;
  }

  if (path === "/backup/import") {
    if (request.method !== "POST") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    if (!(await isAdminRequest(request))) {
      json(
        response,
        403,
        { status: "error", reason: "admin required" },
        requestId,
      );
      return;
    }
    await handleBackupImport(request, response, requestId);
    return;
  }

  if (path === "/backup") {
    if (request.method !== "GET") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    await handleBackupExport(request, response, requestId);
    return;
  }

  if (path === "/memory" || path.startsWith("/memory/")) {
    await handleMemory(request, response, requestId);
    return;
  }

  if (path === "/tasks/manual") {
    if (request.method !== "POST") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    await handleManualTask(request, response, requestId);
    return;
  }

  if (path === "/tasks/rerun") {
    if (request.method !== "POST") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    await handleTaskRerun(request, response, requestId);
    return;
  }

  if (path === "/tasks/cancel") {
    if (request.method !== "POST") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    await handleTaskCancel(request, response, requestId);
    return;
  }

  if (path === "/tasks/check-run") {
    if (request.method !== "GET") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    await handleTaskCheckRun(request, response, requestId);
    return;
  }

  if (path === "/repositories/sync") {
    if (request.method !== "POST") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    await handleRepositorySync(request, response, requestId);
    return;
  }

  if (path === "/repos/revoke") {
    if (request.method !== "POST") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    if (!(await isAdminRequest(request))) {
      json(
        response,
        403,
        { status: "error", reason: "admin required" },
        requestId,
      );
      return;
    }
    await handleRevokeSubject(request, response, requestId);
    return;
  }

  if (path === "/scans/config") {
    if (request.method === "PUT") {
      await handleScansConfigUpdate(request, response, requestId);
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
    await handleScansConfig(response, requestId);
    return;
  }

  if (path === "/scans/run") {
    if (request.method !== "POST") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    await handleScansRun(request, response, requestId);
    return;
  }

  if (path === "/scans/runs") {
    if (request.method !== "GET") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    await handleScansRuns(request, response, requestId);
    return;
  }

  // /repositories/:id/settings 支持 PUT/GET，必须放在下面的 GET-only 兜底守卫
  // 之前——否则 PUT（保存仓库级覆盖）会被守卫拦成 405，开关永远存不上（#42）。
  if (
    path.startsWith("/repositories/") &&
    path.endsWith("/settings") &&
    path !== "/repositories/settings"
  ) {
    const repositoryId = decodeURIComponent(
      path.slice("/repositories/".length, path.length - "/settings".length),
    ).trim();
    if (!repositoryId) {
      json(
        response,
        400,
        { status: "error", reason: "repository id required" },
        requestId,
      );
      return;
    }
    await handleRepositorySettings(request, response, repositoryId, requestId);
    return;
  }

  // 删除 provider 账户是写操作（POST），必须放在下面的 GET-only 兜底守卫之前，
  // 否则会被守卫拦成 405（与 /repositories/:id/settings 同因，issue #58）。
  if (path === "/providers/delete") {
    if (String(request.method) !== "POST") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    if (!(await isAdminRequest(request))) {
      json(
        response,
        403,
        { status: "error", reason: "admin required" },
        requestId,
      );
      return;
    }
    await handleProviderDelete(request, response, requestId);
    return;
  }

  // 方向七：仓库可见性授权管理。PUT/DELETE 是写操作，放在 GET-only 兜底守卫之前
  // （与 /providers/delete 同因，避免 405）。admin 校验在 handleGrants 内部完成。
  if (path === "/grants" || path.startsWith("/grants/")) {
    await handleGrants(request, response, requestId);
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

  if (path === "/summary") {
    await handleSummary(response, requestId);
    return;
  }

  // 仓库审核规则功能页（WebUI「审核规则」菜单）。
  if (path === "/repo-rules" || path.startsWith("/repo-rules/")) {
    await handleRepoRulesRequest(request, response, requestId);
    return;
  }

  if (path === "/repositories") {
    await handleRepositories(request, response, requestId);
    return;
  }

  if (path === "/repositories/issues") {
    if (request.method !== "GET") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    await handleRepositoryIssues(request, response, requestId);
    return;
  }

  if (path === "/logs") {
    await handleLogs(request, response, requestId);
    return;
  }

  if (path === "/vector") {
    await handleVector(response, requestId);
    return;
  }

  if (path === "/config") {
    await handleConfig(response, requestId);
    return;
  }

  if (path === "/tasks" || path.startsWith("/tasks/")) {
    await handleTasks(request, response, requestId);
    return;
  }

  if (path === "/providers") {
    await handleProviders(response, requestId);
    return;
  }

  if (path === "/results/delete") {
    if (String(request.method) !== "POST") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    await handleResultsDelete(request, response, requestId);
    return;
  }

  if (path === "/results" || path.startsWith("/results/")) {
    await handleResults(request, response, requestId);
    return;
  }

  if (path === "/health/live") {
    json(
      response,
      200,
      { status: "ok", service: "apertureprism-api" },
      requestId,
    );
    return;
  }

  if (path === "/health/ready") {
    const [databaseHealth, redisHealth] = await Promise.all([
      checkDatabase(database.sql, config.healthCheckTimeoutMs),
      checkRedis(redis, config.healthCheckTimeoutMs),
    ]);
    const ready = databaseHealth.status === "ok" && redisHealth.status === "ok";
    json(
      response,
      ready ? 200 : 503,
      {
        status: ready ? "ok" : "error",
        dependencies: { database: databaseHealth, redis: redisHealth },
      },
      requestId,
    );
    return;
  }

  json(response, 404, { status: "error", reason: "not found" }, requestId);
  requestLogger.debug({ path }, "request not found");
}

const server = createServer((request, response) => {
  metrics.increment("http.requests");
  const timer = startTimer();
  response.once("finish", () => {
    metrics.recordDuration("http.request_ms", timer());
    const code = response.statusCode;
    if (code >= 500) metrics.increment("http.errors_5xx");
  });
  void handleRequest(request, response).catch((error: unknown) => {
    logger.error({ err: error }, "request failed");
    if (!response.headersSent)
      json(
        response,
        500,
        { status: "error", reason: "internal server error" },
        randomUUID(),
      );
    else response.destroy();
  });
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  await stopEventStream();
  if (repositorySyncTimer) clearInterval(repositorySyncTimer);
  if (alertTimer) clearInterval(alertTimer);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeRedisClient(redis);
  await database.close();
}

let alertTimer: ReturnType<typeof setInterval> | null = null;

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
void startEventStream()
  .then(() => {
    startRuntimeSettings();
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
    logger.error({ err: error }, "failed to start event stream");
    process.exitCode = 1;
  });
