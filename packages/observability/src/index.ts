import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from "pino";
import { redactDiagnosticValue } from "./redaction.js";

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

export function createLogger(
  level: LoggerOptions["level"] = "info",
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      level,
      hooks: {
        logMethod(args, method) {
          // 所有深度先做同一套脱敏；pino 的 paths 再保护已知的顶层字段。
          const safeArgs = args.map((argument) =>
            redactDiagnosticValue(argument),
          );
          Reflect.apply(method, this, safeArgs);
        },
      },
      redact: { paths: sensitivePaths, censor: "[REDACTED]" },
      base: { service: "apertureprism" },
    },
    destination,
  );
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
export type {
  DurationBucket,
  DurationSummary,
  MetricsOptions,
  MetricsSnapshot,
} from "./metrics.js";
export { redactDiagnosticText, redactDiagnosticValue } from "./redaction.js";
export type { RedactionOptions } from "./redaction.js";
