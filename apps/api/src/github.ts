/**
 * GitHub 应用：凭据解析、客户端与 App 元数据。
 * 调用示例：const github = await githubClientPromise。
 * HTTP 路径保持兼容；跨文件依赖在下方显式列出。
 */
import { createCredentialCipher } from "../../../packages/config/src/index.js";
import { resolveGithubAppCredentials } from "../../../packages/database/src/index.js";
import {
  type GitHubClient,
  createGitHubClient,
} from "../../../packages/github-adapter/src/index.js";
import { database, config, logger } from "./runtime.js";

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
export let githubClientPromise: Promise<GitHubClient | null> =
  buildGithubClient();

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
export function reloadGithubClient(): void {
  githubClientPromise = buildGithubClient();
}

/** Non-secret runtime configuration snapshot (no keys, no secrets). */
/** GitHub App slug 缓存（60s），供 WebUI 生成「安装 / 授权仓库」链接。 */
let githubAppSlugCache: { slug: string; at: number } | null = null;

/** 当前 GitHub App 的 slug（如 clodbreeze-ai-reviewer）；未配置/失败返回 null。 */
export async function githubAppSlug(): Promise<string | null> {
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
export async function githubAppConfiguredFlag(): Promise<boolean> {
  try {
    return (await loadGithubAppCredentials()) !== null;
  } catch (error) {
    logger.warn({ err: error }, "github app configured check failed");
    return false;
  }
}
