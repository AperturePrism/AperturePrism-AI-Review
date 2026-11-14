/**
 * 安装引导：初始配置、GitHub、OAuth 和嵌入模型。
 * 调用示例：handleSetupStatus(request, response, requestId)。
 * HTTP 路径保持兼容；跨文件依赖在下方显式列出。
 */
import type { HttpRoute } from "../utils/routes.js";
import { createCredentialCipher } from "../../../../packages/config/src/index.js";
import {
  checkDatabase,
  providerAccounts,
  modelRolePolicies,
  systemSettings,
} from "../../../../packages/database/src/index.js";
import { createGitHubClient } from "../../../../packages/github-adapter/src/index.js";
import { githubAppConfiguredFlag, reloadGithubClient } from "../github.js";
import { audit } from "../identity.js";
import {
  webhookEnabled,
  oauthConfigured,
  embeddingConfig,
  webuiToken,
  upsertSetting,
  refreshRuntimeSettings,
  currentOAuth,
} from "../preferences.js";
import { database, config, logger } from "../runtime.js";
import { json, parseJsonBody } from "../utils/http.js";
import { DEFAULT_POLICIES } from "./providers.js";
import { randomBytes } from "node:crypto";
import { type ServerResponse, type IncomingMessage } from "node:http";

async function tableCount(names: string[]): Promise<number> {
  const rows = await database.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY(${names})
  `;
  return rows[0]?.n ?? 0;
}

/** Setup diagnostics (public; shown by the install wizard before login). */
export async function handleSetupStatus(
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
export async function handleSetupInit(
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
            {
              provider: providerKey,
              model: config.defaultLlmModel,
              accountName,
            },
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

/** POST /setup/embedding — stores the embedding endpoint as a hot setting. */
export async function handleSetupEmbedding(
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
    json(
      response,
      500,
      { status: "error", reason: "embedding_save_failed" },
      requestId,
    );
  }
}

/** POST /setup/webhook-secret — generates and stores a GitHub webhook secret. */
export async function handleSetupWebhookSecret(
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
    json(
      response,
      500,
      { status: "error", reason: "webhook_secret_failed" },
      requestId,
    );
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
export async function handleSetupGithubApp(
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

export async function handleSetupOAuth(
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
    json(
      response,
      500,
      { status: "error", reason: "oauth_save_failed" },
      requestId,
    );
  }
}

// HTTP 入口与业务放在同一处：新增同类入口只修改本文件。
export const routes = [
  {
    path: "/setup/status",
    methods: ["GET"],
    handle: (_request, response, id) => handleSetupStatus(response, id),
  },
  {
    path: "/setup/init",
    methods: ["POST"],
    admin: true,
    handle: handleSetupInit,
  },
  {
    path: "/setup/embedding",
    methods: ["POST"],
    admin: true,
    handle: handleSetupEmbedding,
  },
  {
    path: "/setup/webhook-secret",
    methods: ["POST"],
    admin: true,
    handle: handleSetupWebhookSecret,
  },
  {
    path: "/setup/github-app",
    methods: ["POST"],
    admin: true,
    handle: handleSetupGithubApp,
  },
  {
    path: "/setup/oauth",
    methods: ["POST"],
    admin: true,
    handle: handleSetupOAuth,
  },
] satisfies readonly HttpRoute[];
