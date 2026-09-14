import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../../../packages/database/src/schema.js";
import { serializeSseEvent } from "../../../packages/event-stream/src/index.js";

/* ---------- GitHub Container Registry version check ----------
   Public images can be queried anonymously via the Docker Registry HTTP API:
     GET https://ghcr.io/v2/bb0813/apertureprism-ai-review/<svc>/tags/list
     GET https://ghcr.io/v2/.../<svc>/manifests/<tag>  -> Docker-Content-Digest
   No read:packages token required. */

const REGISTRY_HOST = "ghcr.io";
/**
 * 镜像站 fallback（9.5）：ghcr.io 直连在中国大陆网络下经常超时（表现为更新面板
 * 「最新版本：未知」）。NAS 生产环境实际通过 ghcr.nju.edu.cn 拉取，探测失败时
 * 逐个尝试镜像站 —— 它们的 v2 API 与 ghcr.io 兼容且支持匿名 token。
 */
const REGISTRY_FALLBACK_HOSTS = ["ghcr.nju.edu.cn", "docker.1ms.run"] as const;
const REGISTRY_BASE = "bb0813/apertureprism-ai-review";
const UPDATE_SERVICES = [
  "api",
  "web",
  "analysis-worker",
  "index-worker",
  "scheduler",
  "scan-worker",
  "migrate",
  "qq-bot",
] as const;
const TARGET_PATTERN = /^v?\d+\.\d+\.\d+$|^latest$|^stable$/;
const HISTORY_SETTING_KEY = "update_history";

export type UpdateHistoryEntry = {
  at: string;
  from: string;
  to: string;
  ok: boolean;
  reason?: string;
};

export function isValidUpdateTarget(target: string): boolean {
  return TARGET_PATTERN.test(target);
}

let cachedPackageVersion: string | null = null;

/**
 * In-image version fallback: reads the root package.json version once so the
 * UI can always show a real version, even when compose does not inject
 * IMAGE_TAG / UPDATE_VERSION.
 */
function packageVersion(): string {
  if (cachedPackageVersion) return cachedPackageVersion;
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
    ) as { version?: string };
    cachedPackageVersion = pkg.version ? `v${pkg.version}` : "unknown";
  } catch {
    cachedPackageVersion = "unknown";
  }
  return cachedPackageVersion;
}

/** Current running version, injected by compose as IMAGE_TAG / UPDATE_VERSION. */
export function currentVersion(): string {
  const value = process.env.UPDATE_VERSION ?? process.env.IMAGE_TAG ?? "";
  const trimmed = value.trim();
  if (trimmed.length > 0 && trimmed !== "latest") return trimmed;
  return packageVersion();
}

async function registryToken(host: string, service: string): Promise<string> {
  const url =
    `https://${host}/token?service=${host}` +
    `&scope=repository:${REGISTRY_BASE}/${service}:pull`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`registry token ${response.status}`);
  const data = (await response.json()) as { token?: string; access_token?: string };
  return data.token ?? data.access_token ?? "";
}

async function registryTags(
  host: string,
  service: string,
): Promise<string[]> {
  const token = await registryToken(host, service);
  const tags: string[] = [];
  // GHCR 的 tags/list 可能分页（随 tag 增多返回子集）。逐页拉全，直到无 next
  // 分页指针；镜像站若实现分页也同样适用，避免把“最新”错判成某个旧子集。
  let last = "";
  for (let page = 0; page < 20; page += 1) {
    const sep = last ? `&last=${encodeURIComponent(last)}` : "";
    const url = `https://${host}/v2/${REGISTRY_BASE}/${service}/tags/list?n=200${sep}`;
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "user-agent": "apertureprism-updater",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`registry ${response.status}`);
    const data = (await response.json()) as { tags?: string[] };
    if (Array.isArray(data.tags)) tags.push(...data.tags);
    // 分页指针：Link: <...?last=<tag>>; rel="next"
    const link = response.headers.get("link") ?? "";
    const m = link.match(/[?&]last=[^&>;]+/i);
    if (!m) break;
    const nextLast = decodeURIComponent(m[0].replace(/^[?&]last=/, ""));
    if (!nextLast || nextLast === last) break;
    last = nextLast;
  }
  return tags;
}

async function registryDigest(
  host: string,
  service: string,
  tag: string,
): Promise<string | null> {
  const token = await registryToken(host, service);
  const url = `https://${host}/v2/${REGISTRY_BASE}/${service}/manifests/${encodeURIComponent(tag)}`;
  const response = await fetch(url, {
    headers: {
      accept:
        "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
      authorization: `Bearer ${token}`,
      "user-agent": "apertureprism-updater",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  return response.headers.get("docker-content-digest");
}

/**
 * 探测第一个可达的 registry 主机：ghcr.io 直连优先（数据最新），超时/报错后
 * 依次尝试镜像站。全部失败才抛错 —— 上层据此返回 registry_unreachable。
 */
async function reachableHost(): Promise<string> {
  for (const host of [REGISTRY_HOST, ...REGISTRY_FALLBACK_HOSTS]) {
    try {
      await registryToken(host, UPDATE_SERVICES[0]);
      return host;
    } catch {
      // 试下一个镜像站。
    }
  }
  throw new Error("all registries unreachable");
}

function compareVersion(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/** Sorted distinct semver tags (vX.Y.Z) across the main services, newest first. */
async function fetchLatestTags(host: string): Promise<string[]> {
  const seen = new Set<string>();
  for (const service of UPDATE_SERVICES) {
    try {
      for (const tag of await registryTags(host, service)) {
        if (/^v?\d+\.\d+\.\d+$/.test(tag)) seen.add(tag);
      }
    } catch {
      // one service failing should not fail the whole check
    }
  }
  return [...seen].sort((a, b) => compareVersion(b, a));
}

/** Handles GET /update/status — current vs latest version comparison. */
export async function handleUpdateStatus(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const current = currentVersion();
  try {
    // ghcr.io 直连超时时自动落到镜像站（9.5），而不是把「未知」甩给用户。
  const host = await reachableHost();
  // 只有 ghcr.io 才视作权威、最新的 tag 来源；镜像站元数据可能滞后，若
  // 被迫落到镜像站要把“来源/是否滞后”一并透出，避免把旧 tag 当“最新”。
  const primary = host === REGISTRY_HOST;
  const tags = await fetchLatestTags(host);
  const latestTag = tags[0];
  const latestDigest = latestTag ? await registryDigest(host, "web", latestTag) : null;
  const currentDigest =
    current !== "unknown" ? await registryDigest(host, "web", current) : null;
  json(
    response,
    200,
    {
      current: {
        version: current,
        composeProject:
          process.env.COMPOSE_PROJECT_NAME ?? "apertureprism-ai-review",
      },
      latest: {
        tags: tags.slice(0, 10),
        version: latestTag ?? null,
        digest: latestDigest,
        // 数据来源与权威性：镜像站的 tags 常滞后于 ghcr.io，UI 应据此刻意弱化
        // “最新版本”文案，避免误报（曾把镜像站残留的 v1.0.116 当成最新）。
        source: host,
        stale: !primary,
      },
      updateAvailable: Boolean(
        latestTag &&
          current !== latestTag &&
          latestDigest &&
          latestDigest !== currentDigest &&
          primary,
      ),
      updateChannel: "latest",
      // 是否正在执行更新（进程内锁）。暴露给前端：更新进行中时禁用「更新到
      // 最新」按钮，避免刷新后封面按钮可点、一点就撞上 409 update_in_progress
      // 却看不到任何"正在更新"的提示（#43）。
      inProgress: updateRunning,
    },
    requestId,
  );
  } catch {
    json(
      response,
      503,
      { status: "error", reason: "registry_unreachable", degraded: true },
      requestId,
    );
  }
}

/* ---------- update execution ---------- */

const UPDATE_SCRIPT_PATH = process.env.UPDATE_SCRIPT ?? "/app/scripts/update.sh";
let updateRunning = false;

/**
 * Executes the in-container update script, streaming each JSON line to the
 * SSE client as `log` events and finishing with a `done` event. `onDone` runs
 * once the script exits (success or rollback) so history can be recorded.
 */
async function runUpdate(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  target: string,
  backupBefore: boolean,
  onDone: (ok: boolean, reason: string | undefined) => void,
): Promise<void> {
  if (updateRunning) {
    json(response, 409, { status: "error", reason: "update_in_progress" }, requestId);
    return;
  }
  updateRunning = true;
  const previous = currentVersion();
  let seq = 0;
  // 心跳定时器可能因设置阶段异常而从未启动，故可空，方便兜底清理。
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const push = (level: string, message: string): void => {
    seq += 1;
    response.write(serializeSseEvent({ seq, type: "log", data: { level, message } }));
  };
  const done = (ok: boolean, reason: string | undefined): void => {
    if (heartbeat) clearInterval(heartbeat);
    response.write(
      serializeSseEvent({
        seq: seq + 1,
        type: "done",
        data: ok
          ? { ok, previous, applied: target }
          : { ok, previous, applied: target, reason },
      }),
    );
    response.end();
    onDone(ok, reason);
  };

  // 同步设置阶段可能抛错（例如客户端在设置响应头之前就断开、writeHead 打到已
  // 销毁的 socket、write 抛 ERR_STREAM_DESTROYED 等）。`updateRunning` 一旦置位，
  // 若此处异常漏掉（此前无 finally），锁会永久卡住——之后一切更新请求都误返
  // 409 update_in_progress、而实际并没有更新在跑，只能等 api 重启（#43 根因）。
  // 这里 try/catch 兜底复位，绝不泄漏锁。
  try {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-request-id": requestId,
    });
    response.write(": update stream\n\n");

    // 更新可能长时间静默（compose pull 的进度条用 `\r` 原地刷新、不产生换行，
    // api 按 `\n` 切分后攒在缓冲区）。nginx 的 proxy_read_timeout 一旦超过静默
    // 期就掐断连接，浏览器报 "network error"。每 30s 写一个 SSE 注释字节保持
    // 连接存活；EventSource/手动 reader 都会忽略注释行。
    heartbeat = setInterval(() => {
      response.write(": keepalive\n\n");
    }, 30_000);
  } catch {
    // 连接已坏：不能再用 response 写 SSE，直接复位锁 + 结束，避免永久占用。
    updateRunning = false;
    if (heartbeat) clearInterval(heartbeat);
    try {
      response.destroy();
    } catch {
      /* ignore */
    }
    try {
      onDone(false, "stream_setup_failed");
    } catch {
      /* ignore */
    }
    return;
  }

  const args = [
    "--target", target,
    "--project", process.env.COMPOSE_PROJECT_NAME ?? "apertureprism-ai-review",
    "--api", `http://127.0.0.1:${process.env.PORT ?? "30001"}`,
    "--token", process.env.WEBUI_API_TOKEN ?? "",
    ...(backupBefore ? ["--backup"] : []),
  ];

  const child = spawn("/bin/sh", [UPDATE_SCRIPT_PATH, ...args], {
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const handleChunk = (chunk: Buffer): void => {
    for (const line of chunk.toString("utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as {
          level?: string;
          stage?: string;
          message?: string;
        };
        // update.sh emits {"level":"stage","stage":"backup","message":"备份配置"}
        // so the WebUI can advance a progress bar instead of only dumping logs.
        if (parsed.level === "stage") {
          seq += 1;
          response.write(
            serializeSseEvent({
              seq,
              type: "stage",
              data: { stage: parsed.stage ?? "unknown", message: parsed.message ?? "" },
            }),
          );
        } else {
          push(parsed.level ?? "info", parsed.message ?? trimmed);
        }
      } catch {
        push("info", trimmed);
      }
    }
  };
  child.stdout.on("data", handleChunk);
  child.stderr.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed) push("warn", trimmed);
    }
  });

  child.on("error", (error) => {
    updateRunning = false;
    push("error", `无法启动更新脚本：${error.message}`);
    done(false, "script_start_failed");
  });

  child.on("close", (code) => {
    updateRunning = false;
    const ok = code === 0;
    push(ok ? "info" : "error", ok ? `更新完成（${target}）` : `更新脚本退出码 ${code}`);
    done(ok, ok ? undefined : `script_exit_${code}`);
  });

  response.on("close", () => {
    // 客户端断开是更新流程中的预期事件：update.sh 中途会重建 web（nginx）容器，
    // 经 nginx 的 SSE 连接随之断开；用户也可能中途关掉页面。绝不能在此 SIGKILL
    // 更新脚本 —— 否则更新永远卡在「重建 web」那一步（历史里的 script_exit_null）。
    // 让 update.sh 在后台继续跑完，状态由子进程 close 事件写回更新历史；
    // updateRunning 由子进程 close 复位，避免并发更新。
    if (heartbeat) clearInterval(heartbeat);
  });
}

/** Handles POST /update/apply — admin only, SSE log stream. */
export async function handleUpdateApply(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  isAdmin: boolean,
  db: PostgresJsDatabase<typeof schema>,
  onAudit?: (detail: Record<string, unknown>) => void,
): Promise<void> {
  if (!isAdmin) {
    json(response, 403, { status: "error", reason: "admin required" }, requestId);
    return;
  }
  const body = await readBody(request);
  let parsed: { target?: unknown; backupBefore?: unknown } = {};
  try {
    parsed = JSON.parse(body.toString("utf8") || "{}");
  } catch {
    json(response, 400, { status: "error", reason: "invalid JSON" }, requestId);
    return;
  }
  const target = typeof parsed.target === "string" ? parsed.target : "latest";
  if (!isValidUpdateTarget(target)) {
    json(response, 400, { status: "error", reason: "invalid target" }, requestId);
    return;
  }
  const backupBefore = parsed.backupBefore !== false;
  // 在线更新是高敏感操作：目标版本与是否备份留痕（由 main.ts 注入审计回调）。
  onAudit?.({ target, backupBefore });
  await runUpdate(request, response, requestId, target, backupBefore, (ok, reason) => {
    void writeHistory(db, {
      at: new Date().toISOString(),
      from: currentVersion(),
      to: target,
      ok,
      ...(reason ? { reason } : {}),
    });
  });
}

/** Handles GET /update/history — admin only. */
export async function handleUpdateHistory(
  response: ServerResponse,
  requestId: string,
  db: PostgresJsDatabase<typeof schema>,
): Promise<void> {
  try {
    const rows = await db
      .select({ value: schema.systemSettings.value })
      .from(schema.systemSettings)
      .where(eq(schema.systemSettings.key, HISTORY_SETTING_KEY))
      .limit(1);
    const items = rows[0]?.value
      ? (JSON.parse(rows[0].value) as UpdateHistoryEntry[])
      : [];
    json(response, 200, { items }, requestId);
  } catch {
    json(response, 200, { items: [] }, requestId);
  }
}

async function writeHistory(
  db: PostgresJsDatabase<typeof schema>,
  entry: UpdateHistoryEntry,
): Promise<void> {
  try {
    const rows = await db
      .select({ value: schema.systemSettings.value })
      .from(schema.systemSettings)
      .where(eq(schema.systemSettings.key, HISTORY_SETTING_KEY))
      .limit(1);
    const existing = rows[0]?.value
      ? (JSON.parse(rows[0].value) as UpdateHistoryEntry[])
      : [];
    const next = [entry, ...existing].slice(0, 50);
    await db
      .insert(schema.systemSettings)
      .values({ key: HISTORY_SETTING_KEY, value: JSON.stringify(next) })
      .onConflictDoUpdate({
        target: schema.systemSettings.key,
        set: { value: JSON.stringify(next), updatedAt: new Date() },
      });
  } catch {
    // history persistence is best-effort
  }
}

/* ---------- helpers ---------- */

function json(response: ServerResponse, status: number, body: unknown, requestId: string): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-request-id": requestId,
  });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
