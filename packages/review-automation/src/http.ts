/**
 * 自动化 HTTP 边界：由宿主先完成登录，再传入可信 actor。
 * 调用：await createAutomationHttp(automation)(request,response,actor)。
 * GET /api/automation?action=rules.list&repository=owner/repo；POST 接收 {action,input}。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Automation, AutomationActor } from "./types.js";
import { isAutomationReadAction } from "./index.js";
import { AutomationError, object } from "./utils/input.js";

async function readJson(request: IncomingMessage): Promise<unknown> {
  const limit = 1024 * 1024;
  if (Number(request.headers["content-length"]) > limit) {
    request.resume();
    throw new AutomationError(
      "input_too_large",
      "automation HTTP input exceeds 1 MiB",
      413,
    );
  }
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onAborted = (): void => {
      cleanup();
      reject(new AutomationError("invalid_input", "request aborted"));
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) {
        cleanup();
        request.resume();
        reject(
          new AutomationError(
            "input_too_large",
            "automation HTTP input exceeds 1 MiB",
            413,
          ),
        );
        return;
      }
      chunks.push(bytes);
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new AutomationError(
      "invalid_input",
      "automation input must be valid JSON",
    );
  }
}

export function createAutomationHttp(automation: Automation) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: AutomationActor,
  ): Promise<boolean> => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (
      url.pathname !== "/api/automation" &&
      !url.pathname.startsWith("/api/automation/")
    )
      return false;
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(JSON.stringify(body));
    };
    try {
      if (url.pathname !== "/api/automation")
        throw new AutomationError(
          "not_found",
          "automation endpoint not found",
          404,
        );
      let action: string;
      let input: Record<string, unknown>;
      if (request.method === "GET") {
        action = url.searchParams.get("action") ?? "summary";
        if (!isAutomationReadAction(action))
          throw new AutomationError(
            "method_not_allowed",
            "GET may only read or preview automation rules",
            405,
          );
        input = Object.fromEntries(url.searchParams.entries());
        delete input.action;
        for (const key of ["limit", "offset"])
          if (input[key] !== undefined) input[key] = Number(input[key]);
      } else if (request.method === "POST") {
        const command = object(await readJson(request));
        if (typeof command.action !== "string")
          throw new AutomationError("invalid_input", "action is required");
        action = command.action;
        input = object(command.input);
      } else {
        response.setHeader("allow", "GET, POST");
        throw new AutomationError(
          "method_not_allowed",
          "automation supports GET and POST",
          405,
        );
      }
      const result = await automation.execute(actor, { action, input });
      send(200, { status: "ok", data: result });
    } catch (error) {
      if (error instanceof AutomationError)
        send(error.status, {
          status: "error",
          code: error.code,
          reason: error.message,
        });
      else
        send(500, {
          status: "error",
          code: "internal_error",
          reason: "automation request failed",
        });
    }
    return true;
  };
}
