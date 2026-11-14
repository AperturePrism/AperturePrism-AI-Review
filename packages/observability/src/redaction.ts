/**
 * 诊断脱敏：统一处理日志中的嵌套凭据、URL 密码和常见令牌。
 * @example
 * logger.info(redactDiagnosticValue({ headers, failure: error.message }));
 *
 * 脱敏是最后一道保护；源代码、提示词、上游响应正文应在采集时直接省略。
 */
export type RedactionOptions = {
  maxDepth?: number;
  maxStringLength?: number;
  maxItems?: number;
  censor?: string;
};

const SENSITIVE_KEY =
  /(?:authorization|cookie|password|passwd|secret|credential|privatekey|apikey|accesstoken|refreshtoken|sessiontoken|githubinstallationtoken|prompt|repositorysource|messages)/i;

/** 对短诊断文字做保守脱敏；不应把它用于允许记录整段不可信正文。 */
export function redactDiagnosticText(value: string, maxLength = 500): string {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1)
    throw new RangeError("maxLength must be a positive integer");
  return value
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(
      /\b(?:sk|ghp|github_pat|gho|ghu|ghs|ghr)[-_][A-Za-z0-9_-]{8,}/g,
      "[REDACTED TOKEN]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[REDACTED JWT]",
    )
    .replace(
      /(https?:\/\/|postgres(?:ql)?:\/\/|rediss?:\/\/)([^\s/@]+)@/gi,
      "$1[REDACTED]@",
    )
    .replace(
      /([?&](?:token|key|secret|password|signature|authorization|access_token|api_key)=)[^&#\s]*/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;&#]+/gi,
      "$1[REDACTED]",
    )
    .slice(0, maxLength);
}

/** 保留诊断对象结构，但限制深度、元素和文本，循环引用不会让日志崩溃。 */
export function redactDiagnosticValue(
  value: unknown,
  options: RedactionOptions = {},
): unknown {
  const maxDepth = options.maxDepth ?? 8;
  const maxStringLength = options.maxStringLength ?? 500;
  const maxItems = options.maxItems ?? 100;
  for (const [name, limit] of Object.entries({
    maxDepth,
    maxStringLength,
    maxItems,
  })) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError(`${name} must be a positive integer`);
  }
  const seen = new WeakSet<object>();
  const censor = options.censor ?? "[REDACTED]";
  const visit = (item: unknown, depth: number): unknown => {
    if (typeof item === "string")
      return redactDiagnosticText(item, maxStringLength);
    if (typeof item === "bigint") return item.toString();
    if (item === null || typeof item !== "object") return item;
    if (seen.has(item)) return "[Circular]";
    if (depth >= maxDepth) return "[Depth limit]";
    seen.add(item);
    if (item instanceof Date)
      return Number.isFinite(item.getTime())
        ? item.toISOString()
        : "[Invalid date]";
    if (item instanceof Error)
      return {
        name: item.name,
        message: redactDiagnosticText(item.message, maxStringLength),
      };
    if (Array.isArray(item))
      return item.slice(0, maxItems).map((entry) => visit(entry, depth + 1));
    const result: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const [key, nested] of Object.entries(item).slice(0, maxItems)) {
      result[key] = SENSITIVE_KEY.test(key.replace(/[_-]/g, ""))
        ? censor
        : visit(nested, depth + 1);
    }
    return result;
  };
  return visit(value, 0);
}
