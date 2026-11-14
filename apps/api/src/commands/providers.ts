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
import { redactDiagnosticText } from "../../../../packages/observability/src/redaction.js";
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
  // 旧账户可能只在环境变量配置地址；回填与 worker 使用相同的覆盖顺序。
  const baseByProvider = new Map<string, string>(
    Object.entries(config.modelProviderBaseUrls ?? {}),
  );
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

export class ModelListError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly hint: string,
    readonly diagnostics: Record<string, unknown> = {},
  ) {
    super(reason);
    this.name = "ModelListError";
  }
}

/** 完整响应受超时和大小限制；供应商回显 Authorization 时也不会传回密钥。 */
export async function readProviderModels(
  baseUrl: string,
  apiKey: string,
  options: { savedCredential?: boolean; timeoutMs?: number } = {},
): Promise<string[]> {
  let endpoint: URL;
  try {
    endpoint = new URL(openAiModelsEndpoint(baseUrl));
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error("invalid URL");
  } catch {
    throw new ModelListError(
      400,
      "invalid_provider_url",
      "Base URL 需为不带用户名、密码或查询参数的 HTTP(S) 地址",
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 15_000,
  );
  try {
    const res = await fetch(endpoint, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
      // 旧密钥只能交给已保存的地址，不能跟随跳转换一个接收方。
      ...(options.savedCredential ? { redirect: "error" as const } : {}),
      signal: controller.signal,
    });
    const reader = res.body?.getReader();
    let body = "";
    if (reader) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 2 * 1024 * 1024)
            throw new ModelListError(
              502,
              "models_response_too_large",
              "模型列表响应过大",
            );
          chunks.push(part.value);
        }
        body = Buffer.concat(chunks).toString("utf8");
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
    if (!res.ok) {
      const detail = redactDiagnosticText(
        body.split(apiKey).join("[redacted]"),
        300,
      );
      throw new ModelListError(
        502,
        "models_request_failed",
        "请检查供应商地址、密钥和访问权限",
        {
          httpStatus: res.status,
          endpoint: endpoint.href,
          ...(detail ? { detail } : {}),
        },
      );
    }
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      throw new ModelListError(
        502,
        "invalid_models_response",
        "供应商未返回有效的模型列表 JSON",
      );
    }
    const rows =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as { data?: unknown }).data
        : undefined;
    if (!Array.isArray(rows) || rows.length > 10_000)
      throw new ModelListError(
        502,
        "invalid_models_response",
        "供应商返回的模型列表格式不正确",
      );
    const ids: string[] = rows.flatMap((row) =>
      row &&
      typeof row === "object" &&
      typeof row.id === "string" &&
      row.id.trim()
        ? [row.id]
        : [],
    );
    // 成功状态也可能把 Authorization 误放入模型 id；原样或拼接的完整密钥都不能回传。
    const models = ids.filter((id) => !apiKey || !id.includes(apiKey));
    if (ids.length > 0 && models.length === 0)
      throw new ModelListError(
        502,
        "models_credential_echo",
        "供应商模型列表包含凭据内容，已拒绝显示；请检查供应商响应",
      );
    return [...new Set(models)].sort();
  } catch (error) {
    if (error instanceof ModelListError) throw error;
    throw new ModelListError(
      502,
      controller.signal.aborted
        ? "models_fetch_timeout"
        : "models_fetch_failed",
      controller.signal.aborted
        ? "请求供应商模型列表超时"
        : "无法连接供应商模型列表，请检查地址及网络",
    );
  } finally {
    clearTimeout(timer);
  }
}

/** 浏览器提交新密钥，或只提交已保存账号的身份；旧密钥始终留在服务端。 */
export async function handleSetupModels(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const body = await parseJsonBody(request);
  let baseUrl =
    typeof body?.baseUrl === "string"
      ? body.baseUrl.trim().replace(/\/+$/, "")
      : "";
  let apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  let savedCredential = false;
  try {
    if (!apiKey) {
      const provider =
        typeof body?.provider === "string" ? body.provider.trim() : "";
      const accountName =
        typeof body?.accountName === "string" ? body.accountName.trim() : "";
      if (!provider || !accountName)
        throw new ModelListError(
          400,
          "base_url_and_api_key_required",
          "请填写 Base URL 与 API Key，或选择已保存的账号",
        );
      const [account] = await database.db
        .select({ credential: providerAccounts.encryptedCredential })
        .from(providerAccounts)
        .where(
          and(
            eq(providerAccounts.provider, provider),
            eq(providerAccounts.name, accountName),
          ),
        )
        .limit(1);
      if (!account)
        throw new ModelListError(
          404,
          "provider_account_not_found",
          "已保存的模型账号不存在，请刷新后重试",
        );
      const [setting] = await database.db
        .select({ value: systemSettings.value })
        .from(systemSettings)
        .where(eq(systemSettings.key, providerBaseUrlSettingKey(provider)))
        .limit(1);
      const savedBaseUrl =
        setting?.value ?? config.modelProviderBaseUrls?.[provider] ?? "";
      if (!savedBaseUrl)
        throw new ModelListError(
          400,
          "provider_base_url_missing",
          "该账号尚未保存 Base URL，请先保存地址",
        );
      if (baseUrl && openAiApiRoot(baseUrl) !== openAiApiRoot(savedBaseUrl))
        throw new ModelListError(
          400,
          "saved_provider_url_changed",
          "Base URL 已修改；请先保存该账号，或输入新 API Key 验证新地址",
        );
      if (!config.credentialMasterKey)
        throw new ModelListError(
          503,
          "master_key_missing",
          "服务端缺少凭据解密配置，请检查 CREDENTIAL_MASTER_KEY",
        );
      try {
        apiKey = createCredentialCipher(config.credentialMasterKey).open(
          account.credential,
        );
      } catch {
        throw new ModelListError(
          503,
          "saved_credential_unavailable",
          "无法读取已保存的 API Key，请检查凭据配置或替换密钥",
        );
      }
      baseUrl = savedBaseUrl;
      savedCredential = true;
    }
    if (!baseUrl)
      throw new ModelListError(
        400,
        "base_url_and_api_key_required",
        "请填写 Base URL 与 API Key",
      );
    const models = await readProviderModels(baseUrl, apiKey, {
      savedCredential,
    });
    json(response, 200, { status: "ok", models }, requestId);
  } catch (error) {
    // 日志仅记稳定原因，不记录可能回显凭据的网络异常。
    const failure =
      error instanceof ModelListError
        ? error
        : new ModelListError(
            500,
            "models_fetch_failed",
            "无法读取模型配置，请稍后重试",
          );
    logger.warn({ reason: failure.reason }, "setup models fetch failed");
    json(
      response,
      failure.status,
      {
        status: "error",
        reason: failure.reason,
        hint: failure.hint,
        ...failure.diagnostics,
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
