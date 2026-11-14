/**
 * 生效设置：持有运行时覆盖；读设置不需要 HTTP 请求。
 * 调用示例：startRuntimeSettings(); webuiToken()。
 * HTTP 路径保持兼容；跨文件依赖在下方显式列出。
 */
import {
  SECRET_SETTING_KEYS,
  ALLOWED_SETTING_KEYS,
  parseLogLevel,
} from "../../../packages/config/src/index.js";
import { systemSettings } from "../../../packages/database/src/index.js";
import { type AlertThresholds, DEFAULT_ALERT_THRESHOLDS } from "./alerts.js";
import { database, logger, config } from "./runtime.js";

/**
 * Effective OAuth credentials: runtime settings (`oauth_client_id` /
 * `oauth_client_secret`) override, then env. This lets the install wizard
 * generate and store an OAuth secret without an env restart.
 */
export function currentOAuth(): { clientId: string; clientSecret: string } {
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

export function oauthConfigured(): boolean {
  const { clientId, clientSecret } = currentOAuth();
  return Boolean(clientId && clientSecret);
}

/* ---------- runtime settings (hot-reload overrides) ---------- */
const SETTINGS_POLL_MS = 8_000;

// 密钥集与写白名单都从注册表派生：此前它们在 api 里手写，且与 GET 列表分开维护、
// 已经漂移（pr_check_run 曾能画开关却存不了）。注册表是唯一事实源。
export const SECRET_KEYS = SECRET_SETTING_KEYS;

export const WRITABLE_SETTING_KEYS = new Set<string>(ALLOWED_SETTING_KEYS);

export const runtimeSettings = new Map<string, string>();

/** Syncs the in-memory override map from the `system_settings` table. */
let settingsLoaded = false;

/** 尚未读取数据库覆盖时，不能把“尚未知晓 token”误判为明确的开放模式。 */
export function authenticationReady(): boolean {
  return settingsLoaded || Boolean(config.webuiApiToken);
}

export async function refreshRuntimeSettings(): Promise<void> {
  try {
    const rows = await database.db
      .select({ key: systemSettings.key, value: systemSettings.value })
      .from(systemSettings);
    runtimeSettings.clear();
    settingsLoaded = true;
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

let settingsTimer: ReturnType<typeof setInterval> | null = null;

/** 开始轮询覆盖设置；同一进程重复调用不会创建第二个计时器。 */
export async function startRuntimeSettings(): Promise<void> {
  if (settingsTimer) return;
  await refreshRuntimeSettings();
  settingsTimer = setInterval(
    () => void refreshRuntimeSettings(),
    SETTINGS_POLL_MS,
  );
}

/** 关闭进程前停止轮询，避免数据库关闭后计时器继续查询。 */
export function stopRuntimeSettings(): void {
  if (settingsTimer) clearInterval(settingsTimer);
  settingsTimer = null;
}

/** Effective WebUI token: settings override; falls back to env/./env.example. */
export function webuiToken(): string {
  const override = runtimeSettings.get("webui_api_token");
  if (override && override.trim().length > 0) return override;
  return config.webuiApiToken ?? "";
}

/** Effective webhook secret + enabled flag, both runtime-overridable. */
export function webhookSecret(): string {
  const override = runtimeSettings.get("github_webhook_secret");
  if (override && override.trim().length > 0) return override;
  return config.githubWebhookSecret ?? "";
}

export function webhookEnabled(): boolean {
  const override = runtimeSettings.get("github_webhook_enabled");
  if (override !== undefined && override !== "") return override === "true";
  return Boolean(config.githubWebhookSecret);
}

/** Effective alert webhook URL: runtime setting overrides env; empty = disabled. */
export function alertWebhookUrl(): string {
  const override = runtimeSettings.get("alert_webhook_url");
  if (override && override.trim().length > 0) return override.trim();
  return (process.env.ALERT_WEBHOOK_URL ?? "").trim();
}

/** Effective alert thresholds: runtime settings override; env; app default. */
export function alertThresholds(): AlertThresholds {
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
export function embeddingConfig(): {
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
      runtimeSettings.get("embedding_api_key") || config.embedding.apiKey || "",
    model: runtimeSettings.get("embedding_model") || config.embedding.model,
  };
}

/** Effective QQ bot config: runtime settings override, then env. */
export function qqConfig(): {
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
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      )
        protocols = parsed as Record<string, unknown>;
    } catch {
      // keep the env value when the stored JSON is malformed
    }
  }
  return {
    protocols,
    officialAppId:
      runtimeSettings.get("qq_official_app_id") || config.qqOfficialAppId || "",
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
export async function upsertSetting(key: string, value: string): Promise<void> {
  await database.db
    .insert(systemSettings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value, updatedAt: new Date() },
    });
  await refreshRuntimeSettings();
}
