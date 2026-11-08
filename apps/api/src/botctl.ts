/**
 * qq-bot 容器生命周期控制（WebUI「机器人」页的启动 / 关闭开关）。
 * 复用 update.sh 的容器内 compose 模式：api 容器挂载 docker.sock + docker CLI，
 * botctl.sh 在容器内重建 env 文件后执行 `compose --profile qq up -d` / `stop`。
 * 仅支持同步状态查询与启停（无 SSE 流），失败返回 502。
 */

import { spawnSync } from "node:child_process";
import type { ServerResponse } from "node:http";

const BOTCTL_SCRIPT = process.env.BOTCTL_SCRIPT ?? "/app/scripts/botctl.sh";

type BotCtlResult = { ok: boolean; output: string; code: number | null };

/** 同步执行 botctl.sh，返回 stdout 与退出码（含 30s 超时保护）。 */
function runBotctl(action: string): BotCtlResult {
  const child = spawnSync("/bin/sh", [BOTCTL_SCRIPT, action], {
    env: { ...process.env, FORCE_COLOR: "0" },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (child.error && (child.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    return { ok: false, output: "botctl timed out", code: null };
  }
  return {
    ok: child.status === 0,
    output: (child.stdout ?? "").trim() || (child.stderr ?? "").trim(),
    code: child.status,
  };
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  requestId: string,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-request-id": requestId,
  });
  response.end(JSON.stringify(body));
}

/** GET /bot/status — qq-bot 容器运行状态（running / exited / absent）。管理员可见。 */
export async function handleBotStatus(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const { ok, output } = runBotctl("status");
  // 凭据是否配置以 DB runtime settings 为准（qq-bot 启动时从 DB 覆盖 env）。
  json(response, ok ? 200 : 502, {
    status: ok ? (output || "unknown") : "unknown",
    ok,
  }, requestId);
}

/** POST /bot/start — 启动 qq-bot 容器（compose --profile qq up -d）。管理员。 */
export async function handleBotStart(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const { ok, output, code } = runBotctl("start");
  if (!ok) {
    json(response, 502, { status: "error", reason: "bot_start_failed", detail: output, code }, requestId);
    return;
  }
  json(response, 200, { status: "ok", detail: output }, requestId);
}

/** POST /bot/stop — 停止 qq-bot 容器（compose stop）。管理员。 */
export async function handleBotStop(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const { ok, output, code } = runBotctl("stop");
  if (!ok) {
    json(response, 502, { status: "error", reason: "bot_stop_failed", detail: output, code }, requestId);
    return;
  }
  json(response, 200, { status: "ok", detail: output }, requestId);
}

/** 供测试 / 非路由使用：导出 raw 执行函数便于单测 mock 脚本。 */
export { runBotctl };
