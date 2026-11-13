/**
 * 经过宿主认证后挂载：身份与授权只能来自宿主，绝不读取请求里的 actor。
 * @example if (await createWorkbenchHttp(workbench)(request,response,actor)) return;
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Actor, ReportArtifact, Workbench } from "./types.js";
import { WORKBENCH_COLLECTIONS } from "./types.js";
import { object, WorkbenchError } from "./utils/input.js";

const prefix = "/api/workbench";
const bodyLimit = 2 * 1024 * 1024;
const collectionNames: ReadonlySet<string> = new Set(WORKBENCH_COLLECTIONS);
const queryNumbers = new Set(["limit", "offset", "from", "to", "days"]);
const queryBooleans = new Set(["humanApproved"]);
const detailReads: Record<string, readonly string[]> = {
  policies: ["compare"],
  baselines: ["compare"],
  suppressions: ["preview"],
  batches: ["preview"],
  budgets: ["availability"],
  evaluations: ["result", "compare"],
};
const detailWrites: Record<string, readonly string[]> = {
  policies: ["version", "activate", "toggle"],
  baselines: ["activate", "archive"],
  findings: ["transition", "assign"],
  suppressions: ["toggle", "renew"],
  batches: ["start", "pause", "resume", "cancel", "retry"],
  feedback: ["resolve"],
  budgets: ["toggle", "limits", "reserve", "settle", "release"],
};

function queryInput(url: URL): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(result, key))
      throw new WorkbenchError("duplicate_query", `查询参数 ${key} 不能重复`);
    if (queryNumbers.has(key)) {
      if (!/^\d+$/.test(value))
        throw new WorkbenchError("invalid_input", `${key} 必须是非负整数`);
      result[key] = Number(value);
    } else if (queryBooleans.has(key)) {
      if (value !== "true" && value !== "false")
        throw new WorkbenchError(
          "invalid_input",
          `${key} 必须是 true 或 false`,
        );
      result[key] = value === "true";
    } else result[key] = value;
  }
  return result;
}

async function readBody(
  request: IncomingMessage,
  limit = bodyLimit,
): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json")
    throw new WorkbenchError(
      "unsupported_media_type",
      "请求正文必须使用 application/json",
      415,
    );
  const declared = request.headers["content-length"];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit))
    throw new WorkbenchError(
      "body_too_large",
      `请求正文超过 ${Math.floor(limit / 1024 / 1024)} MiB`,
      413,
    );
  const content = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const clear = (): void => {
      request.off("data", receive);
      request.off("end", finish);
      request.off("aborted", aborted);
      request.off("error", failed);
    };
    const receive = (raw: Buffer | string): void => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      size += chunk.length;
      if (size > limit) {
        clear();
        request.resume();
        reject(
          new WorkbenchError(
            "body_too_large",
            `请求正文超过 ${Math.floor(limit / 1024 / 1024)} MiB`,
            413,
          ),
        );
        return;
      }
      chunks.push(chunk);
    };
    const finish = (): void => {
      clear();
      resolve(Buffer.concat(chunks));
    };
    const aborted = (): void => {
      clear();
      reject(new WorkbenchError("request_aborted", "请求已中断"));
    };
    const failed = (): void => {
      clear();
      reject(new WorkbenchError("request_failed", "无法读取请求正文"));
    };
    request.on("data", receive);
    request.once("end", finish);
    request.once("aborted", aborted);
    request.once("error", failed);
  });
  let data: unknown;
  try {
    data = JSON.parse(content.toString("utf8"));
  } catch {
    throw new WorkbenchError("invalid_json", "请求正文不是有效 JSON");
  }
  return object(data);
}

function json(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(data));
}

/** URL 路由只定义入口编排，业务检查都在 execute 内部。 */
function route(method: string, segments: string[]): string {
  if (method === "GET") {
    if (segments.length === 1 && segments[0] === "summary") return "summary";
    if (segments.length === 1 && segments[0] === "trends") return "trends";
    if (segments.length === 1 && segments[0] === "archive")
      return "archive.export";
    if (segments.length === 1 && segments[0] === "gate") return "gate.evaluate";
    if (segments.length === 1 && segments[0] === "reports")
      return "reports.render";
    if (
      segments.length === 2 &&
      segments[0] === "reports" &&
      segments[1] === "formats"
    )
      return "reports.formats";
    if (
      segments.length === 2 &&
      segments[0] === "policies" &&
      segments[1] === "templates"
    )
      return "policies.templates";
    if (
      segments.length === 2 &&
      segments[0] === "feedback" &&
      segments[1] === "summary"
    )
      return "feedback.summary";
    if (
      segments.length === 2 &&
      segments[0] === "audit" &&
      segments[1] === "verify"
    )
      return "audit.verify";
    if (collectionNames.has(segments[0] ?? "")) {
      if (segments.length === 1) return `${segments[0]}.list`;
      if (segments.length === 2) return `${segments[0]}.get`;
      if (
        segments.length === 3 &&
        detailReads[segments[0]!]?.includes(segments[2]!)
      )
        return `${segments[0]}.${segments[2]}`;
    }
  }
  if (method === "POST") {
    if (
      segments.length === 2 &&
      segments[0] === "archive" &&
      ["preview", "restore"].includes(segments[1]!)
    )
      return `archive.${segments[1]}`;
    if (
      segments.length === 2 &&
      segments[0] === "findings" &&
      ["import", "bulk_transition"].includes(segments[1]!)
    )
      return `findings.${segments[1]}`;
    if (
      segments.length === 2 &&
      segments[0] === "budgets" &&
      segments[1] === "expire"
    )
      return "budgets.expire";
    if (collectionNames.has(segments[0] ?? "") && segments[0] !== "audit") {
      if (segments.length === 1) return `${segments[0]}.create`;
      // 领取、续租、关联和回传结果只供宿主内部工作进程调用，HTTP 写权限不能冒充它。
      if (
        segments.length === 3 &&
        detailWrites[segments[0]!]?.includes(segments[2]!)
      )
        return `${segments[0]}.${segments[2]}`;
    }
  }
  throw new WorkbenchError("route_not_found", "工作台接口不存在", 404);
}

/**
 * 返回 false 表示不属于本模块；所有模块内错误在这里统一转为安全响应。
 * 未预期异常只返回通用提示，避免把磁盘路径或内部堆栈泄露给浏览器。
 */
export function createWorkbenchHttp(
  workbench: Workbench,
  options: { onError?: (error: unknown) => void } = {},
): (
  request: IncomingMessage,
  response: ServerResponse,
  actor: Actor,
) => Promise<boolean> {
  return async (request, response, actor) => {
    const url = new URL(request.url ?? "/", "http://workbench.local");
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))
      return false;
    try {
      const method = request.method ?? "GET";
      if (method !== "GET" && method !== "POST") {
        response.setHeader("allow", "GET, POST");
        throw new WorkbenchError(
          "method_not_allowed",
          "接口只支持 GET 和 POST",
          405,
        );
      }
      const segments = url.pathname
        .slice(prefix.length)
        .split("/")
        .filter(Boolean)
        .map((part) => {
          try {
            return decodeURIComponent(part);
          } catch {
            throw new WorkbenchError("invalid_url", "URL 编码无效");
          }
        });
      const action = route(method, segments);
      const query = queryInput(url);
      const input =
        method === "POST"
          ? {
              ...query,
              ...(await readBody(
                request,
                action.startsWith("archive.")
                  ? 32 * 1024 * 1024 + 4096
                  : bodyLimit,
              )),
            }
          : query;
      if (
        segments.length === 3 ||
        (segments.length === 2 &&
          collectionNames.has(segments[0] ?? "") &&
          ![
            "templates",
            "summary",
            "verify",
            "expire",
            "import",
            "bulk_transition",
          ].includes(segments[1]!))
      )
        input.id = segments[1];
      const result = await workbench.execute(actor, { action, input });
      if (action === "reports.render") {
        const artifact = result as ReportArtifact;
        response.writeHead(200, {
          "content-type": artifact.mimeType,
          "content-disposition": `attachment; filename="${artifact.filename}"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(artifact.content);
      } else {
        if (action === "archive.export")
          response.setHeader(
            "content-disposition",
            'attachment; filename="workbench-backup.json"',
          );
        json(response, 200, result);
      }
    } catch (error) {
      if (error instanceof WorkbenchError)
        json(response, error.status, {
          error: { code: error.code, message: error.message },
        });
      else {
        if (options.onError) options.onError(error);
        else console.error("workbench request failed", error);
        json(response, 500, {
          error: {
            code: "internal_error",
            message: "工作台处理失败，请查看服务端日志",
          },
        });
      }
    }
    return true;
  };
}
