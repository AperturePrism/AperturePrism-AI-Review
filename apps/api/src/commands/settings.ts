/**
 * 系统设置：读取来源、保存覆盖、密钥轮换与引导诊断。
 * 调用示例：handleConfig(request, response, requestId)。
 * HTTP 路径保持兼容；跨文件依赖在下方显式列出。
 */
import { parseJsonObject } from "../utils/http.js";
import type { HttpRoute } from "../utils/routes.js";
import {
  getSettingSpec,
  BOOLEAN_DEFAULTS,
  validateSettingValue,
  KNOWN_SETTING_KEYS,
} from "../../../../packages/config/src/index.js";
import {
  clearSettingWithRotation,
  deleteSetting,
  putSettingWithRotation,
  putSetting,
  systemSettings,
  resolveSettingValue,
  rotationInfo,
} from "../../../../packages/database/src/index.js";
import {
  DEFAULT_MIN_CHANGE_RATIO,
  DEFAULT_ISSUE_RESULT_SECTIONS_VALUE,
} from "../../../../packages/issue-analysis/src/index.js";
import { DEFAULT_ALERT_THRESHOLDS } from "../alerts.js";
import { githubAppSlug, githubAppConfiguredFlag } from "../github.js";
import { audit } from "../identity.js";
import {
  webhookEnabled,
  embeddingConfig,
  qqConfig,
  oauthConfigured,
  webuiToken,
  WRITABLE_SETTING_KEYS,
  SECRET_KEYS,
  refreshRuntimeSettings,
} from "../preferences.js";
import { config, database } from "../runtime.js";
import { json, readBody } from "../utils/http.js";
import { asc } from "drizzle-orm";
import { type ServerResponse, type IncomingMessage } from "node:http";

export async function handleConfig(
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
export function settingDefaultValue(key: string): string {
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
  if (key === "issue_result_sections")
    return DEFAULT_ISSUE_RESULT_SECTIONS_VALUE;
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

/** 只能由专用接口管理的设置；通用接口读写会绕过其管理员校验。 */
const DEDICATED_SETTING_KEYS = new Set(["review_rules_global"]);

/** Runtime settings: GET lists (secret values masked); PUT upserts a key. */
export async function handleSettings(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  if (request.method === "PUT") {
    const body = await readBody(request);
    let parsed: { key?: unknown; value?: unknown };
    try {
      parsed = parseJsonObject(body);
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
    if (key && DEDICATED_SETTING_KEYS.has(key)) {
      json(
        response,
        400,
        {
          status: "error",
          reason: "dedicated_settings_endpoint_required",
          message: "该设置只能通过全局审核规则接口修改",
        },
        requestId,
      );
      return;
    }
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
    KNOWN_SETTING_KEYS.filter(
      (key) => !DEDICATED_SETTING_KEYS.has(key),
    ).map(async (key) => {
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
        ...(spec?.multiline ? { multiline: true } : {}),
        ...(spec?.maxLength !== undefined ? { maxLength: spec.maxLength } : {}),
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
export function handleSettingsBootstrap(
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

// HTTP 入口与业务放在同一处：新增同类入口只修改本文件。
export const routes = [
  {
    path: "/config",
    methods: ["GET"],
    handle: (_request, response, id) => handleConfig(response, id),
  },
  {
    path: "/settings/bootstrap",
    methods: ["GET"],
    handle: (_request, response, id) => handleSettingsBootstrap(response, id),
  },
  { path: "/settings", handle: handleSettings },
] satisfies readonly HttpRoute[];
