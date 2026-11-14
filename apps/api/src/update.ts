import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../../../packages/database/src/schema.js";
import { serializeSseEvent } from "../../../packages/event-stream/src/index.js";
import {
  finishUpdate,
  normalizeUpdateVersion,
  normalizeVersionLabel,
  readUpdateHistory,
  reserveUpdate,
  type UpdateHistoryEntry,
} from "./update-history.js";

export type { UpdateHistoryEntry } from "./update-history.js";

/* ---------- GitHub Container Registry version check ----------
   Public images can be queried anonymously via the Docker Registry HTTP API:
     GET https://ghcr.io/v2/apertureprism/apertureprism-ai-review/<svc>/tags/list
     GET https://ghcr.io/v2/.../<svc>/manifests/<tag>  -> Docker-Content-Digest
   No read:packages token required. */

const REGISTRY_HOST = "ghcr.io";
/**
 * 镜像站 fallback（9.5）：ghcr.io 直连在中国大陆网络下经常超时（表现为更新面板
 * 「最新版本：未知」）。NAS 生产环境实际通过 ghcr.nju.edu.cn 拉取，探测失败时
 * 逐个尝试镜像站 —— 它们的 v2 API 与 ghcr.io 兼容且支持匿名 token。
 */
const REGISTRY_FALLBACK_HOSTS = ["ghcr.nju.edu.cn", "docker.1ms.run"] as const;
const REGISTRY_BASE = "apertureprism/apertureprism-ai-review";
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
export function isValidUpdateTarget(target: string): boolean {
  return target === "latest" || target === "stable" || normalizeUpdateVersion(target) !== null;
}

let cachedPackageVersion: string | null = null;
// Durable history survives restart; this guard also protects a still-live local
// child if a read expires its running entry without cancelling the script.
let updateRunning = false;

/** The root package is baked into the running image; compose env can be stale. */
function packageVersion(): string {
  if (cachedPackageVersion !== null) return cachedPackageVersion;
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
    ) as { version?: unknown };
    const version =
      typeof pkg.version === "string" ? normalizeVersionLabel(pkg.version) : null;
    cachedPackageVersion = version === null ? "unknown" : `v${version}`;
  } catch {
    cachedPackageVersion = "unknown";
  }
  return cachedPackageVersion;
}

/** Env is only a display fallback, never runtime-confirmation evidence. */
export function currentVersion(): string {
  const baked = packageVersion();
  if (baked !== "unknown") return baked;
  for (const value of [process.env.UPDATE_VERSION, process.env.IMAGE_TAG]) {
    const trimmed = value?.trim() ?? "";
    if (normalizeVersionLabel(trimmed) !== null) return trimmed;
  }
  return "unknown";
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
    if (!m) return tags;
    const nextLast = decodeURIComponent(m[0].replace(/^[?&]last=/, ""));
    if (!nextLast || nextLast === last) throw new Error("registry pagination did not advance");
    last = nextLast;
  }
  throw new Error("registry tag pagination exceeded limit");
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

/** 解析 semver 主版本与预发布标识，预发布部分按 semver 规则逐段比较。 */
function parseVersion(value: string): { core: bigint[]; pre: string[] } {
  const clean = value.replace(/^v/, "").replace(/\+.*$/, "");
  const dash = clean.indexOf("-");
  const core = dash === -1 ? clean : clean.slice(0, dash);
  const pre = dash === -1 ? "" : clean.slice(dash + 1);
  return {
    core: core.split(".").map((part) => BigInt(part || "0")),
    pre: pre ? pre.split(".") : [],
  };
}

function compareVersion(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    const da = pa.core[i] ?? 0n;
    const db = pb.core[i] ?? 0n;
    if (da !== db) return da > db ? 1 : -1;
  }
  // 正式版优先于同号预发布版（1.3.0 > 1.3.0-beta）。
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const length = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < length; i += 1) {
    const ia = pa.pre[i];
    const ib = pb.pre[i];
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    const na = /^\d+$/.test(ia) ? BigInt(ia) : null;
    const nb = /^\d+$/.test(ib) ? BigInt(ib) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na > nb ? 1 : -1;
    } else if (na !== null) {
      return -1;
    } else if (nb !== null) {
      return 1;
    } else if (ia !== ib) {
      return ia > ib ? 1 : -1;
    }
  }
  return 0;
}

/** Channels must be pinned from the primary registry, never mirror/cache data. */
async function resolveUpdateTarget(target: string): Promise<string> {
  if (target !== "latest" && target !== "stable") return target;
  const tags = await registryTags(REGISTRY_HOST, "api");
  const latest = tags
    .filter((tag) => normalizeUpdateVersion(tag) !== null)
    .sort((a, b) => compareVersion(b, a))[0];
  if (!latest) throw new Error("No authoritative semver update target");
  return latest;
}

/** Sorted distinct semver tags (vX.Y.Z) across the main services, newest first. */
async function fetchLatestTags(host: string): Promise<string[]> {
  const seen = new Set<string>();
  for (const service of UPDATE_SERVICES) {
    try {
      for (const tag of await registryTags(host, service)) {
        if (normalizeUpdateVersion(tag) !== null) seen.add(tag);
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
  db: PostgresJsDatabase<typeof schema>,
): Promise<void> {
  const current = currentVersion();
  let inProgress: boolean;
  try {
    inProgress = (await readUpdateHistory(db, packageVersion())).inProgress;
  } catch {
    json(response, 503, { status: "error", reason: "history_read_failed" }, requestId);
    return;
  }
  try {
    const host = await reachableHost();
    const primary = host === REGISTRY_HOST;
    const tags = await fetchLatestTags(host);
    const latestTag = tags[0];
    const latestDigest = latestTag ? await registryDigest(host, "web", latestTag) : null;
    const currentDigest =
      current !== "unknown"
        ? ((await registryDigest(host, "web", current)) ??
          // 预发布镜像可能只以去掉 v 前缀的形式存在，回退再探测一次。
          (current.startsWith("v") ? await registryDigest(host, "web", current.slice(1)) : null))
        : null;
    let updateAvailable: boolean | null = null;
    if (primary && latestTag && normalizeVersionLabel(current) !== null) {
      if (compareVersion(latestTag, current) <= 0) updateAvailable = false;
      else if (latestDigest && currentDigest) updateAvailable = latestDigest !== currentDigest;
    }
    json(
      response,
      200,
      {
        current: {
          version: current,
          composeProject: process.env.COMPOSE_PROJECT_NAME ?? "apertureprism-ai-review",
        },
        latest: {
          tags: tags.slice(0, 10),
          version: latestTag ?? null,
          digest: latestDigest,
          source: host,
          stale: !primary,
        },
        updateAvailable,
        updateChannel: "latest",
        inProgress: inProgress || updateRunning,
      },
      requestId,
    );
  } catch {
    json(
      response,
      503,
      {
        status: "error",
        reason: "registry_unreachable",
        degraded: true,
        current: { version: current },
        updateAvailable: null,
        inProgress: inProgress || updateRunning,
      },
      requestId,
    );
  }
}

/* ---------- update execution ---------- */

const UPDATE_SCRIPT_PATH = process.env.UPDATE_SCRIPT ?? "/app/scripts/update.sh";

/** Script completion only advances the already-durable running attempt to pending. */
async function runUpdate(
  response: ServerResponse,
  requestId: string,
  entry: UpdateHistoryEntry & { id: string },
  backupBefore: boolean,
  db: PostgresJsDatabase<typeof schema>,
): Promise<void> {
  const { from: previous, to: target, id } = entry;
  let seq = 0;
  let streaming = true;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stopStreaming = (): void => {
    streaming = false;
    if (heartbeat) clearInterval(heartbeat);
  };
  const write = (chunk: string): void => {
    if (!streaming) return;
    try {
      response.write(chunk);
    } catch {
      stopStreaming();
    }
  };
  const send = (type: string, data: unknown): void => {
    write(serializeSseEvent({ seq: ++seq, type, data }));
  };
  const push = (level: string, message: string): void => send("log", { level, message });

  // A broken client stream is not an updater failure after launch. Never kill
  // the child: nginx recreation and tab closes are expected during an update.
  response.on("close", stopStreaming);
  response.on("error", stopStreaming);
  try {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-request-id": requestId,
    });
    response.write(": update stream\n\n");
  } catch {
    stopStreaming();
    try {
      await finishUpdate(db, id, false, "stream_setup_failed");
    } catch {
      console.error("Failed to persist update stream setup failure");
    }
    try {
      response.destroy();
    } catch {
      // The client may already have destroyed the response.
    }
    return;
  }
  send("started", { id, previous, target });
  if (streaming) heartbeat = setInterval(() => write(": keepalive\n\n"), 30_000);

  const args = [
    "--target", target,
    "--project", process.env.COMPOSE_PROJECT_NAME ?? "apertureprism-ai-review",
    "--api", `http://127.0.0.1:${process.env.PORT ?? "30001"}`,
    "--token", process.env.WEBUI_API_TOKEN ?? "",
    ...(backupBefore ? ["--backup"] : []),
  ];

  await new Promise<void>((resolveDone) => {
    let finishing = false;
    const complete = async (scriptOk: boolean, reason?: string): Promise<void> => {
      // spawn can emit error followed by close. Claim completion synchronously,
      // before awaiting persistence, so history and SSE each finish exactly once.
      if (finishing) return;
      finishing = true;
      if (heartbeat) clearInterval(heartbeat);
      let ok = false;
      try {
        const saved = await finishUpdate(db, id, scriptOk, reason);
        ok = scriptOk && saved.status === "pending";
        if (!ok) reason = saved.reason ?? reason ?? "update_no_longer_running";
      } catch {
        reason = "history_write_failed";
        console.error("Failed to persist update completion");
        // Best effort only for the failure path, never report fake script success.
        try {
          await finishUpdate(db, id, false, reason);
        } catch {
          console.error("Failed to persist update failure");
        }
      }
      push(ok ? "info" : "error", ok ? `等待运行版本确认（${target}）` : (reason ?? "update_failed"));
      send("done", {
        ok,
        previous,
        applied: target,
        restartPending: ok,
        ...(!ok && reason ? { reason } : {}),
      });
      if (streaming) {
        try {
          response.end();
        } catch {
          stopStreaming();
        }
      }
      stopStreaming();
      resolveDone();
    };

    try {
      const child = spawn("/bin/sh", [UPDATE_SCRIPT_PATH, ...args], {
        env: { ...process.env, FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout = createLineReader((line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const parsed = JSON.parse(trimmed) as {
            level?: string;
            stage?: string;
            message?: string;
          };
          if (parsed.level === "stage") {
            send("stage", {
              stage: parsed.stage ?? "unknown",
              message: parsed.message ?? "",
            });
          } else {
            push(parsed.level ?? "info", parsed.message ?? trimmed);
          }
        } catch {
          push("info", trimmed);
        }
      });
      const stderr = createLineReader((line) => {
        const trimmed = line.trim();
        if (trimmed) push("warn", trimmed);
      });
      child.stdout.on("data", (chunk: Buffer) => stdout.write(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.write(chunk));
      child.on("error", () => void complete(false, "script_start_failed"));
      child.on("close", (code) => {
        // 关闭前冲刷解码器与最后一个不带换行的尾行，避免截断多字节字符。
        stdout.end();
        stderr.end();
        void complete(
          code === 0,
          code === 0 ? undefined : `script_exit_${code}`,
        );
      });
    } catch {
      void complete(false, "script_start_failed");
    }
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
  let parsed: { target?: unknown; backupBefore?: unknown };
  try {
    const body: unknown = JSON.parse((await readBody(request)).toString("utf8") || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid body");
    parsed = body;
  } catch {
    json(response, 400, { status: "error", reason: "invalid JSON" }, requestId);
    return;
  }
  const requested = parsed.target === undefined ? "latest" : parsed.target;
  if (typeof requested !== "string" || !isValidUpdateTarget(requested)) {
    json(response, 400, { status: "error", reason: "invalid target" }, requestId);
    return;
  }
  const backupBefore = parsed.backupBefore !== false;
  if (updateRunning) {
    json(response, 409, { status: "error", reason: "update_in_progress" }, requestId);
    return;
  }
  // Check persisted state before any registry request (including after restart).
  try {
    if ((await readUpdateHistory(db, packageVersion())).inProgress) {
      json(response, 409, { status: "error", reason: "update_in_progress" }, requestId);
      return;
    }
  } catch {
    json(response, 503, { status: "error", reason: "history_read_failed" }, requestId);
    return;
  }
  let target: string;
  try {
    target = await resolveUpdateTarget(requested);
  } catch {
    json(response, 503, { status: "error", reason: "target_resolution_failed" }, requestId);
    return;
  }
  if (updateRunning) {
    json(response, 409, { status: "error", reason: "update_in_progress" }, requestId);
    return;
  }
  updateRunning = true;
  try {
    let entry: (UpdateHistoryEntry & { id: string }) | null;
    try {
      // The second check and durable running write are atomic. Network resolution
      // stays outside this lock so one slow registry never holds a DB transaction.
      entry = await reserveUpdate(db, currentVersion(), target, packageVersion());
    } catch {
      json(response, 503, { status: "error", reason: "history_write_failed" }, requestId);
      return;
    }
    if (!entry) {
      json(response, 409, { status: "error", reason: "update_in_progress" }, requestId);
      return;
    }
    try {
      onAudit?.({ id: entry.id, target, backupBefore });
    } catch {
      console.error("Failed to set up update audit");
      try {
        await finishUpdate(db, entry.id, false, "update_setup_failed");
      } catch {
        console.error("Failed to persist update setup failure");
      }
      json(response, 503, { status: "error", reason: "update_setup_failed" }, requestId);
      return;
    }
    await runUpdate(response, requestId, entry, backupBefore, db);
  } finally {
    updateRunning = false;
  }
}

/** Handles GET /update/history — admin only. */
export async function handleUpdateHistory(
  response: ServerResponse,
  requestId: string,
  db: PostgresJsDatabase<typeof schema>,
): Promise<void> {
  try {
    const state = await readUpdateHistory(db, packageVersion());
    json(response, 200, { ...state, currentVersion: currentVersion(), inProgress: state.inProgress || updateRunning }, requestId);
  } catch {
    json(response, 503, { status: "error", reason: "history_read_failed" }, requestId);
  }
}

/* ---------- helpers ---------- */

/**
 * 子进程 chunk 不保证按行或按 UTF-8 字符边界到达；按解码后的完整行回调，
 * 并在 end() 时冲刷残留的多字节字符与无换行尾行。
 */
export function createLineReader(onLine: (line: string) => void): {
  write: (chunk: Buffer) => void;
  end: () => void;
} {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const consume = (text: string): void => {
    const lines = (pending + text).split(/\r\n|\r|\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  };
  return {
    write: (chunk) => consume(decoder.write(chunk)),
    end: () => {
      consume(decoder.end());
      if (pending) onLine(pending);
      pending = "";
    },
  };
}

function json(response: ServerResponse, status: number, body: unknown, requestId: string): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-request-id": requestId,
  });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
