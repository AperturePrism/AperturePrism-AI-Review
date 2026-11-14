/**
 * 运行时配置与设置来源。
 * 本文件保留原有请求路径与返回契约；认证和 GET 缓存由 http.ts 统一提供。
 * @example import { fetchConfig } from './api/settings';
 */
import { authHeaders, notifyUnauthorized } from "../auth";
import { bumpCache, getJson } from "./http";

export type RuntimeConfig = {
  host: string;
  port: number;
  logLevel: string;
  githubWebhookConfigured: boolean;
  githubAppConfigured: boolean;
  /** GitHub App slug（如 clodbreeze-ai-reviewer）；用于生成安装/授权仓库链接。 */
  githubAppSlug: string | null;
  webuiAuthEnabled: boolean;
  modelProviders: string[];
  embeddingModel: string;
  embeddingConfigured: boolean;
  qqBotProtocols: string[];
  qqOfficialConfigured: boolean;
  oauthConfigured: boolean;
  oauthEnabled: boolean;
  apiRateLimit: number;
  webhookRateLimit: number;
};

/** Non-secret runtime configuration snapshot. */
export async function fetchConfig(): Promise<RuntimeConfig> {
  return (await getJson("/config")) as RuntimeConfig;
}

/** 生效值的来源，界面据此显示徽章：数据库覆盖 / 环境变量 / 应用默认。 */
export type SettingSource = "database" | "env" | "default";

export type SettingItem = {
  key: string;
  /** 后端注册表提供的元数据，前端不再自己维护一份文案。 */
  group: string;
  kind: "boolean" | "string" | "secret" | "enum" | "number" | "multicheck";
  label: string;
  hint: string;
  secret: boolean;
  repoScoped: boolean;
  /** `restart` 表示改完必须重启对应容器（目前只有 QQ 相关项）。 */
  hotReload: "poll" | "restart";
  options?: string[];
  multiline?: boolean;
  maxLength?: number;
  source: SettingSource;
  /** 当前生效值；secret 一律为掩码。 */
  value: string;
  /** env 是否提供了兜底值（不回显内容）。 */
  envConfigured: boolean;
  envVar: string | null;
  defaultValue: string;
  /** 数据库里是否有覆盖。 */
  hasValue: boolean;
  updatedAt: string | null;
  /** 密钥轮换：旧值在回滚窗口内（换错了可回滚）。仅 secret 且有轮换时存在。 */
  rotation?: {
    hasPrevious: boolean;
    rotatedAt: string | null;
    previousExpiresAt: string | null;
  };
};

export type SettingsList = { items: SettingItem[] };

/** Runtime-overridable settings. Secret values come back masked. */
export async function fetchSettings(): Promise<SettingsList> {
  return (await getJson("/settings")) as SettingsList;
}

/**
 * 引导层（只能来自环境变量的那几项）的健康度。CREDENTIAL_MASTER_KEY 缺失时
 * Provider 凭据与 GitHub App 私钥都保存不了，此前只在保存失败时才暴露。
 */
export type BootstrapItem = {
  key: string;
  configured: boolean;
  required: boolean;
  label: string;
  hint: string;
};

export type BootstrapStatus = { items: BootstrapItem[]; healthy: boolean };

export async function fetchSettingsBootstrap(): Promise<BootstrapStatus> {
  return (await getJson("/settings/bootstrap")) as BootstrapStatus;
}

/** 清除一个全局设置的覆盖，回落到环境变量 / 应用默认。 */
export async function clearSetting(key: string): Promise<void> {
  await putSettingValue(key, null);
}

/** Upserts a runtime setting; it hot-applies without a restart. */
export async function saveSetting(key: string, value: string): Promise<void> {
  await putSettingValue(key, value);
}

/**
 * 写入或清除一个全局设置。`value: null` 表示删除覆盖、回落到 env / 应用默认。
 *
 * 不走 putJson：后者把 400 一律变成 "request failed with 400"，用户看不到
 * invalid_setting_value 携带的具体原因（比如「只能取 debug / info / …」）。
 */
async function putSettingValue(
  key: string,
  value: string | null,
): Promise<void> {
  const response = await fetch("/settings", {
    method: "PUT",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ key, value }),
  });
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      reason?: unknown;
      detail?: unknown;
    } | null;
    const reason = typeof body?.reason === "string" ? body.reason : "";
    const detail = typeof body?.detail === "string" ? body.detail : "";
    throw new Error(
      // detail 是给人看的原因，reason 是错误码；两者都保留，便于翻译层匹配。
      [reason, detail].filter(Boolean).join("：") ||
        `request failed with ${response.status}`,
    );
  }
  bumpCache();
}
