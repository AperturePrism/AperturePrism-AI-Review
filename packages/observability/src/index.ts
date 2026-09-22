import pino, { type Logger, type LoggerOptions } from "pino";

const sensitivePaths = [
  "authorization",
  "cookie",
  "headers.authorization",
  "headers.cookie",
  "request.headers.authorization",
  "request.headers.cookie",
  "githubInstallationToken",
  "providerCredential",
  "databaseUrl",
  "redisUrl",
  "prompt",
  "repositorySource",
  // 额外的凭据/密钥类字段：防止 Provider 密钥、OAuth/QQ 令牌、私钥等
  // 出现在日志 payload 中（含一层嵌套，如 { provider: { apiKey: … } }）。
  "accessToken",
  "refreshToken",
  "apiKey",
  "clientSecret",
  "privateKey",
  "password",
  "*.accessToken",
  "*.refreshToken",
  "*.apiKey",
  "*.clientSecret",
  "*.privateKey",
  "*.password",
];

export type Correlation = {
  requestId?: string;
  taskId?: string;
  attemptId?: string;
};

export function createLogger(level: LoggerOptions["level"] = "info"): Logger {
  return pino({
    level,
    redact: { paths: sensitivePaths, censor: "[REDACTED]" },
    base: { service: "apertureprism" },
  });
}

export function withCorrelation(
  logger: Logger,
  correlation: Correlation,
): Logger {
  return logger.child(correlation);
}

export function startTimer(): () => number {
  const startedAt = performance.now();
  return () => performance.now() - startedAt;
}

export { MetricsRegistry, metrics } from "./metrics.js";
export type { DurationBucket, MetricsSnapshot } from "./metrics.js";
