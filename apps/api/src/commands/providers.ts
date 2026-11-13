/**
 * 模型账户：查询、连接探测、保存和删除。
 * 调用示例：handleProviders(request, response, requestId)。
 * HTTP 路径保持兼容；跨文件依赖在下方显式列出。
 */
import { parseJsonObject } from "../utils/http.js";
import type { HttpRoute } from "../utils/routes.js";
import { createCredentialCipher } from "../../../../packages/config/src/index.js";
import {
  modelRolePolicies,
  providerAccounts,
  systemSettings,
} from "../../../../packages/database/src/index.js";
import { audit } from "../identity.js";
import { database, logger, config } from "../runtime.js";
import { json, parseJsonBody, readBody } from "../utils/http.js";
import { asc, like, and, eq, desc } from "drizzle-orm";
import { type ServerResponse, type IncomingMessage } from "node:http";

/** Model role policies + configured provider account names (never the keys). */
export async function handleProviders(
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
      .select({
        provider: providerAccounts.provider,
        name: providerAccounts.name,
      })
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

/* ---------- install wizard / one-click init ---------- */
export const DEFAULT_POLICIES = [
  { role: "issue_analysis", version: "issue-analysis-v1" },
  { role: "pr_review", version: "pr-review-v1" },
  { role: "duplicate_judgment", version: "duplicate-judgment-v1" },
  { role: "memory_consolidation", version: "memory-consolidation-v1" },
] as const;

/** Role policy versions written/updated by the wizard's model step. */
const SETUP_ROLES: readonly { role: string; version: string }[] = [
  ...DEFAULT_POLICIES,
  { role: "expert_review", version: "expert-review-v1" },
  { role: "spam_detection", version: "spam-detection-v1" },
  // 图片多模态专用角色：与 issue_analysis 视觉分流，默认就位（随 provider 添加自动建）。
  { role: "issue_analysis_vision", version: "issue-analysis-v1" },
];

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

export async function handleSetupModels(
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
export async function handleSetupProvider(
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
    json(
      response,
      500,
      { status: "error", reason: "provider_save_failed" },
      requestId,
    );
  }
}

/**
 * POST /providers/delete — deletes a model provider account and removes it from
 * every role policy's candidate list (issue #58). Deleting a provider that is
 * still referenced elsewhere is safe: candidates are pruned, remaining ones
 * keep serving as failover. BaseUrl setting is kept (provider may still be
 * configured via env or re-added later).
 */
export async function handleProviderDelete(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const body = await readBody(request);
  let parsed: { provider?: unknown; accountName?: unknown };
  try {
    parsed = parseJsonObject(body);
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

// HTTP 入口与业务放在同一处：新增同类入口只修改本文件。
export const routes = [
  {
    path: "/providers",
    methods: ["GET"],
    handle: (_request, response, id) => handleProviders(response, id),
  },
  {
    path: "/providers/delete",
    methods: ["POST"],
    admin: true,
    handle: handleProviderDelete,
  },
  {
    path: "/setup/models",
    methods: ["POST"],
    admin: true,
    handle: handleSetupModels,
  },
  {
    path: "/setup/provider",
    methods: ["POST"],
    admin: true,
    handle: handleSetupProvider,
  },
] satisfies readonly HttpRoute[];
