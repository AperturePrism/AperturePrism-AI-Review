/**
 * 全局审核规则：读取、带内容指纹保存，以及不修改设置的 URL 导入预览。
 * @example GET /repo-rules/global; PUT {content,expectedContentHash}; POST /from-url {url}
 */
import type { IncomingMessage } from "node:http";
import {
  MAX_GLOBAL_REVIEW_RULES_CHARS,
  resolveGlobalReviewRulesLimits,
} from "../../../../packages/config/src/index.js";
import {
  GlobalReviewRulesConflict,
  loadGlobalReviewRules,
  saveGlobalReviewRules,
  type GlobalReviewRules,
} from "../../../../packages/database/src/global-review-rules.js";
import { loadSettings } from "../../../../packages/database/src/settings-store.js";
import {
  fetchPublicRuleSourceText,
  RuleSourceError,
} from "../../../../packages/github-adapter/src/rule-source.js";
import { audit, isAdminRequest, isReadOnlyRequest } from "../identity.js";
import { database } from "../runtime.js";
import { HttpError, json, readBody } from "../utils/http.js";
import type { HttpRoute } from "../utils/routes.js";

/** 硬上限字节数：大型档 64000 字符按每字符最多 4 字节。 */
export const MAX_GLOBAL_RULES_BYTES = MAX_GLOBAL_REVIEW_RULES_CHARS * 4;
const bodyLimit = MAX_GLOBAL_REVIEW_RULES_CHARS * 6 + 1024;
const urlLimit = 4096;

export const GLOBAL_REVIEW_RULES_TIER_KEY = "review_rules_global_tier";

export type GlobalRulesLimits = { maxChars: number; maxBytes: number };

export type GlobalRulesServices = {
  isAdmin: (request: IncomingMessage) => Promise<boolean>;
  isReadOnly: (request: IncomingMessage) => Promise<boolean>;
  load: () => Promise<GlobalReviewRules>;
  save: (input: {
    content: string;
    expectedContentHash: string;
  }) => Promise<GlobalReviewRules>;
  /** 当前容量档位；读取失败按标准档处理，绝不放宽上限。 */
  limits: () => Promise<GlobalRulesLimits>;
  fetchSource: (
    url: string,
    signal: AbortSignal,
    limits: GlobalRulesLimits,
  ) => Promise<{ content: string; sourceUrl: string }>;
  audit: (
    request: IncomingMessage,
    action: string,
    metadata: Record<string, unknown>,
  ) => void;
};

async function objectBody(
  request: IncomingMessage,
  limit = bodyLimit,
): Promise<Record<string, unknown>> {
  const type = request.headers["content-type"]
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (type !== "application/json")
    throw new HttpError(415, "请求正文必须使用 application/json");
  const raw = await readBody(request, limit);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new HttpError(400, "请求正文必须是有效 UTF-8 JSON 对象");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "请求正文必须是 JSON 对象");
  return value as Record<string, unknown>;
}

/** 限制与 worker 注入预算相同，导入时不静默截断规则。 */
export function validateGlobalRulesContent(
  value: unknown,
  limits: GlobalRulesLimits = resolveGlobalReviewRulesLimits(undefined),
): string {
  if (typeof value !== "string") throw new HttpError(400, "content 必须是文本");
  if (
    value.length > limits.maxChars ||
    Buffer.byteLength(value, "utf8") > limits.maxBytes
  )
    throw new HttpError(
      413,
      `全局规则最多 ${limits.maxChars} 字符、${limits.maxBytes} UTF-8 字节`,
    );
  const binaryControl = [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
  });
  if (Buffer.from(value, "utf8").toString("utf8") !== value || binaryControl)
    throw new HttpError(
      400,
      "全局规则必须是有效 UTF-8 文本，不能包含二进制控制字符",
    );
  return value;
}

export function parseGlobalRulesUpdate(
  input: Record<string, unknown>,
  limits: GlobalRulesLimits = resolveGlobalReviewRulesLimits(undefined),
) {
  if (
    Object.keys(input).length !== 2 ||
    Object.keys(input).some(
      (key) => !["content", "expectedContentHash"].includes(key),
    )
  )
    throw new HttpError(
      400,
      "需要 content 和 expectedContentHash，不能附带其他字段",
    );
  const content = validateGlobalRulesContent(input.content, limits);
  if (
    typeof input.expectedContentHash !== "string" ||
    !/^[0-9a-f]{64}$/i.test(input.expectedContentHash)
  )
    throw new HttpError(
      400,
      "expectedContentHash 必须是当前内容指纹，请先读取全局规则",
    );
  return {
    content,
    expectedContentHash: input.expectedContentHash.toLowerCase(),
  };
}

/** Node 的 HTTP 超时会包装成 AbortError；只查看稳定类型和原因，不回显网络错误文本。 */
function sourceTimedOut(error: unknown): boolean {
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const value = current as {
      name?: unknown;
      code?: unknown;
      cause?: unknown;
    };
    if (
      value.name === "TimeoutError" ||
      value.code === "ETIMEDOUT" ||
      value.code === "ESOCKETTIMEDOUT" ||
      value.code === "UND_ERR_CONNECT_TIMEOUT" ||
      value.code === "UND_ERR_HEADERS_TIMEOUT" ||
      value.code === "UND_ERR_BODY_TIMEOUT"
    )
      return true;
    if (seen.size >= 8) break;
    current = value.cause;
  }
  return false;
}

export function createGlobalRulesRoutes(
  services: GlobalRulesServices,
): readonly HttpRoute[] {
  const requireAdmin = async (request: IncomingMessage, write: boolean) => {
    if (!(await services.isAdmin(request)))
      throw new HttpError(403, "仅管理员可以管理全局审核规则");
    if (write && (await services.isReadOnly(request)))
      throw new HttpError(403, "只读账号不能修改或导入全局审核规则");
  };
  return [
    {
      path: "/repo-rules/global",
      methods: ["GET", "PUT"],
      admin: true,
      handle: async (request, response, requestId) => {
        const write = request.method === "PUT";
        await requireAdmin(request, write);
        const limits = await services.limits();
        if (!write) {
          json(
            response,
            200,
            {
              ...(await services.load()),
              canManage: !(await services.isReadOnly(request)),
              ...limits,
            },
            requestId,
          );
          return;
        }
        const input = parseGlobalRulesUpdate(
          await objectBody(request, limits.maxChars * 6 + 1024),
          limits,
        );
        try {
          const saved = await services.save(input);
          services.audit(request, "review_rules_global.update", {
            length: saved.content.length,
            contentHash: saved.contentHash,
          });
          json(
            response,
            200,
            {
              ...saved,
              canManage: true,
              ...limits,
            },
            requestId,
          );
        } catch (error) {
          if (!(error instanceof GlobalReviewRulesConflict)) throw error;
          json(
            response,
            409,
            {
              status: "error",
              reason: "global_rules_conflict",
              message: error.message,
              currentContentHash: error.currentContentHash,
            },
            requestId,
          );
        }
      },
    },
    {
      path: "/repo-rules/global/from-url",
      methods: ["POST"],
      admin: true,
      handle: async (request, response, requestId) => {
        await requireAdmin(request, true);
        const input = await objectBody(request, urlLimit * 6 + 1024);
        if (
          Object.keys(input).length !== 1 ||
          typeof input.url !== "string" ||
          !input.url.trim() ||
          input.url.length > urlLimit
        )
          throw new HttpError(400, "请提供不超过 4096 字符的规则 URL");
        const controller = new AbortController();
        const abort = () => controller.abort(new Error("规则导入请求已取消"));
        request.once("aborted", abort);
        response.once("close", abort);
        try {
          const limits = await services.limits();
          const source = await services.fetchSource(
            input.url.trim(),
            controller.signal,
            limits,
          );
          const content = validateGlobalRulesContent(source.content, limits);
          if (!content.trim()) throw new HttpError(400, "规则链接返回了空文本");
          json(
            response,
            200,
            { content, sourceUrl: source.sourceUrl },
            requestId,
          );
        } catch (error) {
          if (error instanceof HttpError) throw error;
          if (!(error instanceof RuleSourceError)) {
            const timeout = sourceTimedOut(error);
            json(
              response,
              timeout ? 504 : 502,
              {
                status: "error",
                reason: timeout ? "rules_url_timeout" : "rules_url_unreachable",
                message: timeout
                  ? "规则链接读取超时，请检查链接或稍后重试"
                  : "服务器暂时无法解析或连接规则链接，请检查链接或稍后重试",
              },
              requestId,
            );
            return;
          }
          const bounded = ["byte_limit", "character_limit"].includes(
            error.code,
          );
          const active = await services
            .limits()
            .catch(() => resolveGlobalReviewRulesLimits(undefined));
          json(
            response,
            bounded ? 413 : 400,
            {
              status: "error",
              reason: "rules_url_import_failed",
              code: error.code,
              message: bounded
                ? `规则内容超过导入上限：当前档位最多 ${active.maxChars} 字符、${active.maxBytes} UTF-8 字节；可在「全局规则容量档位」提高上限`
                : `无法导入规则：请使用公开的 HTTP(S) UTF-8 文本链接，最多 ${active.maxChars} 字符`,
            },
            requestId,
          );
        } finally {
          request.off("aborted", abort);
          response.off("close", abort);
        }
      },
    },
  ];
}

export const routes = createGlobalRulesRoutes({
  isAdmin: isAdminRequest,
  isReadOnly: isReadOnlyRequest,
  load: () => loadGlobalReviewRules(database.db),
  save: (input) => saveGlobalReviewRules(database.db, input),
  limits: async () => {
    try {
      const values = await loadSettings(database.db, [
        GLOBAL_REVIEW_RULES_TIER_KEY,
      ]);
      return resolveGlobalReviewRulesLimits(
        values.get(GLOBAL_REVIEW_RULES_TIER_KEY),
      );
    } catch {
      // 读取档位失败时按标准档处理：宁可拒绝导入，也不放宽提示词预算。
      return resolveGlobalReviewRulesLimits(undefined);
    }
  },
  fetchSource: (url, signal, limits) =>
    fetchPublicRuleSourceText(url, {
      signal,
      maxBytes: limits.maxBytes,
      maxChars: limits.maxChars,
      strictUtf8: true,
      rejectTruncation: true,
    }),
  audit: (request, action, metadata) =>
    audit(request, action, "global", metadata),
});
