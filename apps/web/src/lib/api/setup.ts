/**
 * 首次安装状态与初始化。
 * 本文件保留原有请求路径与返回契约；认证和 GET 缓存由 http.ts 统一提供。
 * @example import { fetchSetupStatus } from './api/setup';
 */
import { postSetup } from "./http";

export type SetupStatus = {
  database: { ok: boolean; tablesReady: number; tablesTotal: number };
  provider: { count: number; providerKey: string; model: string };
  policies: { count: number; required: number };
  githubWebhookConfigured: boolean;
  githubAppConfigured: boolean;
  oauthConfigured: boolean;
  embeddingConfigured: boolean;
  initialized: boolean;
  /** WEBUI_API_TOKEN surfaced only while the system is uninitialized. */
  webuiToken?: string;
};

/** Install wizard diagnostics (public endpoint). */
export async function fetchSetupStatus(): Promise<SetupStatus> {
  const response = await fetch("/setup/status", {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`setup status ${response.status}`);
  return (await response.json()) as SetupStatus;
}

export type SetupInitResult = {
  status: string;
  created: number;
  roles?: string[];
  reason?: string;
  skipped?: string;
};

/** One-click init: seed default model policies when uninitialized. */
export async function setupInit(): Promise<SetupInitResult> {
  const response = await fetch("/setup/init", { method: "POST" });
  if (!response.ok) throw new Error(`setup init ${response.status}`);
  return (await response.json()) as SetupInitResult;
}

/** Generates and persists a GitHub webhook secret; returns it once. */
export async function genWebhookSecret(): Promise<string> {
  const data = (await postSetup("/setup/webhook-secret", {})) as {
    secret?: string;
  };
  if (!data.secret) throw new Error("no secret returned");
  return data.secret;
}

/** Generates a GitHub OAuth client secret (and stores client id if given). */
export async function saveOAuth(input: {
  clientId?: string;
}): Promise<{ clientId: string; clientSecret: string; callbackPath: string }> {
  return (await postSetup("/setup/oauth", input)) as {
    clientId: string;
    clientSecret: string;
    callbackPath: string;
  };
}

/**
 * 保存 GitHub App 凭据。私钥加密存储，后端会先签 JWT 调 GitHub 验证再落库，
 * 因此保存失败即说明凭据本身有问题。
 */
export async function saveGithubApp(input: {
  appId: string;
  privateKeyPem: string;
}): Promise<{ status: string; appId: string; appSlug: string }> {
  return (await postSetup("/setup/github-app", input)) as {
    status: string;
    appId: string;
    appSlug: string;
  };
}
