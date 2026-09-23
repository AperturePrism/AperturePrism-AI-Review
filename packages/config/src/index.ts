import { z } from "zod";

export * from "./credentials.js";
export * from "./settings-registry.js";

export function isProtocolConfig(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.baseUrl !== "string" || entry.baseUrl.length === 0)
    return false;
  if (
    entry.accessToken !== undefined &&
    entry.accessToken !== null &&
    typeof entry.accessToken !== "string"
  )
    return false;
  if (
    entry.gatewayUrl !== undefined &&
    entry.gatewayUrl !== null &&
    typeof entry.gatewayUrl !== "string"
  )
    return false;
  return true;
}

export type QqBotProtocolConfig = {
  baseUrl: string;
  accessToken?: string;
  /** WebSocket endpoint for a forward connection (message events). */
  gatewayUrl?: string;
};

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(30001),
  HOST: z.string().min(1).default("0.0.0.0"),
  DATABASE_URL: z
    .url()
    .refine(
      (value) =>
        value.startsWith("postgres://") || value.startsWith("postgresql://"),
      {
        message: "DATABASE_URL must use postgres:// or postgresql://",
      },
    ),
  REDIS_URL: z
    .url()
    .refine(
      (value) => value.startsWith("redis://") || value.startsWith("rediss://"),
      {
        message: "REDIS_URL must use redis:// or rediss://",
      },
    ),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  HEALTH_CHECK_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(10_000)
    .default(1_000),
  GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),
  /** GitHub App used to mint installation tokens for API reads and writes. */
  GITHUB_APP_ID: z.string().min(1).optional(),
  /** Path to the GitHub App private key PEM file. */
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().min(1).optional(),
  /** Defaults to the public GitHub API; override for GitHub Enterprise. */
  GITHUB_API_BASE_URL: z.url().optional(),
  /**
   * JSON object mapping model provider names to OpenAI-compatible base URLs,
   * e.g. {"openai-compatible":"https://models.example/v1"}. Used by the
   * analysis worker to build adapters for the candidates in the role policy.
   */
  MODEL_PROVIDER_BASE_URLS: z
    .string()
    .refine(
      (value) => {
        if (value.length === 0) return true;
        try {
          const parsed: unknown = JSON.parse(value);
          return (
            typeof parsed === "object" &&
            parsed !== null &&
            !Array.isArray(parsed) &&
            Object.values(parsed).every((entry) => typeof entry === "string")
          );
        } catch {
          return false;
        }
      },
      { message: "MODEL_PROVIDER_BASE_URLS must be a JSON object of strings" },
    )
    .optional(),
  /** Base64-encoded 32-byte key that wraps stored provider credentials. */
  CREDENTIAL_MASTER_KEY: z
    .string()
    .refine((value) => Buffer.from(value, "base64").length === 32, {
      message: "CREDENTIAL_MASTER_KEY must be 32 bytes encoded as base64",
    })
    .optional(),
  /**
   * JSON object configuring NTQQ bot gateways per protocol, e.g.
   * {"onebot11":{"baseUrl":"http://127.0.0.1:3000","accessToken":"...","gatewayUrl":"ws://127.0.0.1:3001"}}
   * Supported protocols: onebot11, satori, milky.
   */
  QQ_BOT_PROTOCOLS: z
    .string()
    .refine(
      (value) => {
        if (value.length === 0) return true;
        try {
          const parsed: unknown = JSON.parse(value);
          return (
            typeof parsed === "object" &&
            parsed !== null &&
            !Array.isArray(parsed)
          );
        } catch {
          return false;
        }
      },
      { message: "QQ_BOT_PROTOCOLS must be a JSON object of protocol configs" },
    )
    .optional(),
  /** Official QQ open-platform bot (api-v2) access credentials. */
  QQ_OFFICIAL_APP_ID: z.string().min(1).optional(),
  /** Official QQ open-platform AppSecret, used to refresh the access token. */
  QQ_OFFICIAL_APP_SECRET: z.string().min(1).optional(),
  /** Official QQ WebSocket gateway. */
  QQ_OFFICIAL_GATEWAY_URL: z.string().min(1).optional(),
  /**
   * Bitmask of intents the official bot subscribes to. Defaults to the value
   * that enables C2C and GROUP_AT message events (1 << 25).
   */
  QQ_OFFICIAL_INTENTS: z.coerce
    .number()
    .int()
    .default(1 << 25),
  /**
   * Base URL of the AperturePrism API that the bot calls to trigger manual
   * analysis/review tasks (POST /tasks/manual). Defaults to the in-compose
   * service name so the qq-bot container can reach the API without extra env.
   */
  QQ_BOT_API_BASE_URL: z.string().min(1).default("http://api:3300"),
  /** Optional separate embedding endpoint (review vs embedding must differ). */
  EMBEDDING_BASE_URL: z.string().min(1).optional(),
  /** Separate embedding API key; if unset, EMBEDDING_BASE_URL is ignored. */
  EMBEDDING_API_KEY: z.string().min(1).optional(),
  EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),
  /**
   * Default review/analysis model used by the setup wizard when seeding role
   * policies before any model list has been fetched. Deployment-specific: set
   * it to whatever your OpenAI-compatible gateway serves. No hard-coded vendor
   * model is assumed.
   */
  DEFAULT_LLM_MODEL: z.string().min(1).default("gpt-4o-mini"),
  /** Optional bearer token guarding the WebUI-facing API routes (/tasks, /results, /providers, /events). */
  WEBUI_API_TOKEN: z.string().min(1).optional(),
  /** Per-IP webhook request budget per minute (in-memory token bucket). */
  WEBHOOK_RATE_LIMIT: z.coerce.number().int().positive().default(60),
  /** Per-IP budget for protected API routes per minute. */
  API_RATE_LIMIT: z.coerce.number().int().positive().default(300),
});

export type AppConfig = Readonly<{
  environment: z.infer<typeof environmentSchema>["NODE_ENV"];
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  logLevel: z.infer<typeof environmentSchema>["LOG_LEVEL"];
  healthCheckTimeoutMs: number;
  githubWebhookSecret: string | undefined;
  githubAppId: string | undefined;
  githubAppPrivateKeyPath: string | undefined;
  githubApiBaseUrl: string | undefined;
  modelProviderBaseUrls: Readonly<Record<string, string>>;
  credentialMasterKey: string | undefined;
  qqBotProtocols: Readonly<Partial<Record<string, QqBotProtocolConfig>>>;
  qqOfficialAppId: string | undefined;
  qqOfficialAppSecret: string | undefined;
  qqOfficialGatewayUrl: string | undefined;
  qqOfficialIntents: number;
  qqBotApiBaseUrl: string;
  webuiApiToken: string | undefined;
  webhookRateLimit: number;
  apiRateLimit: number;
  defaultLlmModel: string;
  embedding: Readonly<{
    baseUrl: string | undefined;
    apiKey: string | undefined;
    model: string;
  }>;
}>;

export function loadConfig(environment: NodeJS.ProcessEnv): AppConfig {
  const parsed = environmentSchema.parse(environment);
  return Object.freeze({
    environment: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    logLevel: parsed.LOG_LEVEL,
    healthCheckTimeoutMs: parsed.HEALTH_CHECK_TIMEOUT_MS,
    githubWebhookSecret: parsed.GITHUB_WEBHOOK_SECRET,
    githubAppId: parsed.GITHUB_APP_ID,
    githubAppPrivateKeyPath: parsed.GITHUB_APP_PRIVATE_KEY_PATH,
    githubApiBaseUrl: parsed.GITHUB_API_BASE_URL,
    modelProviderBaseUrls: Object.freeze(
      parsed.MODEL_PROVIDER_BASE_URLS
        ? (JSON.parse(parsed.MODEL_PROVIDER_BASE_URLS) as Record<
            string,
            string
          >)
        : {},
    ),
    credentialMasterKey: parsed.CREDENTIAL_MASTER_KEY,
    qqBotProtocols: Object.freeze(parseQqBotProtocols(parsed.QQ_BOT_PROTOCOLS)),
    qqOfficialAppId: parsed.QQ_OFFICIAL_APP_ID,
    qqOfficialAppSecret: parsed.QQ_OFFICIAL_APP_SECRET,
    qqOfficialGatewayUrl: parsed.QQ_OFFICIAL_GATEWAY_URL,
    qqOfficialIntents: parsed.QQ_OFFICIAL_INTENTS,
    qqBotApiBaseUrl: parsed.QQ_BOT_API_BASE_URL,
    webuiApiToken: parsed.WEBUI_API_TOKEN,
    webhookRateLimit: parsed.WEBHOOK_RATE_LIMIT,
    apiRateLimit: parsed.API_RATE_LIMIT,
    defaultLlmModel: parsed.DEFAULT_LLM_MODEL,
    embedding: Object.freeze({
      baseUrl: parsed.EMBEDDING_BASE_URL,
      apiKey: parsed.EMBEDDING_API_KEY,
      model: parsed.EMBEDDING_MODEL,
    }),
  });
}

function parseQqBotProtocols(
  raw: string | undefined,
): Record<string, QqBotProtocolConfig> {
  if (!raw || raw.length === 0) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return {};
  const result: Record<string, QqBotProtocolConfig> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!isProtocolConfig(value)) continue;
    const accessToken = value.accessToken;
    const gatewayUrl = value.gatewayUrl;
    result[key] = {
      baseUrl: value.baseUrl,
      ...(accessToken === undefined || accessToken === null
        ? {}
        : { accessToken }),
      ...(gatewayUrl === undefined || gatewayUrl === null
        ? {}
        : { gatewayUrl }),
    };
  }
  return result;
}
