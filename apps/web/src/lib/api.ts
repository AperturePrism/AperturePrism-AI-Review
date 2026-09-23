import { authHeaders, notifyUnauthorized } from "./auth";

/* ---------- 短期 GET 缓存（改善切页/轮询的响应体感） ----------
   只缓存只读 GET，5s 后自动失效；显式"刷新/写操作"调用 bumpCache()
   递增版本号，使下一个请求绕过缓存拿到最新数据。 */
const CACHE_TTL_MS = 5_000;
let cacheVersion = 0;
const responseCache = new Map<string, { at: number; data: unknown }>();

/** 使下一次请求绕过缓存（页面"刷新"按钮、写操作后调用）。 */
export function bumpCache(): void {
  cacheVersion += 1;
  // 写操作后旧缓存全部失效：直接清空比等 5s TTL 过期更干净，
  // 也避免旧版本键位（cacheKey 带版本号）残留为孤儿条目占用内存。
  responseCache.clear();
}

function cacheKey(url: string): string {
  return `${cacheVersion}|${url}`;
}

async function getJson(url: string): Promise<unknown> {
  const key = cacheKey(url);
  const hit = responseCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  // 快照发起时的缓存版本：若请求期间 bumpCache()（写操作完成）被调用，
  // 该响应已过期，跳过写入，防止旧数据以新版本 key 回填缓存。
  const requestedVersion = cacheVersion;
  const data = await fetchJson(url);
  if (requestedVersion !== cacheVersion) return data;
  responseCache.set(key, { at: Date.now(), data });
  // 防止缓存无限增长
  if (responseCache.size > 100) {
    for (const [k, v] of responseCache) {
      if (Date.now() - v.at >= CACHE_TTL_MS) responseCache.delete(k);
    }
  }
  return data;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { accept: "application/json", ...authHeaders() },
  });
  if (response.status === 401) {
    // 令牌失效：通知应用回到登录页（密码门禁）。仅顶层一次，避免重复触发。
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (!response.ok) {
    const reason =
      response.status === 404
        ? "not found"
        : `request failed with ${response.status}`;
    throw new Error(reason);
  }
  return response.json();
}

export type HealthDependency = {
  name: string;
  status: "ok" | "error";
};

export type ReadyHealth = {
  status: "ok" | "error";
  dependencies: { database: HealthDependency; redis: HealthDependency };
};

export type HealthResult =
  { kind: "live"; status: "ok" } | { kind: "ready"; data: ReadyHealth };

export type TaskSummary = {
  id: string;
  taskType: "issue_analysis" | "pr_review" | "repository_index";
  repositoryId: string | null;
  subjectNumber: number | null;
  subjectRevision: string;
  policyVersion: string;
  status: string;
  priority: number;
  attemptCount: number;
  maxAttempts: number;
  lastErrorCategory: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskList = {
  items: TaskSummary[];
  nextOffset?: number;
};

export type TaskEvent = {
  eventType: string;
  data: unknown;
  createdAt: string;
};

export type TaskAttempt = {
  attemptNumber: number;
  workerId: string;
  startedAt: string;
  finishedAt: string | null;
  errorCategory: string | null;
};

export type Publication = {
  channel: string;
  externalObjectId: string | null;
  createdAt: string;
};

export type TaskDetail = TaskSummary & {
  payload: unknown;
  timeline: TaskEvent[];
  attempts: TaskAttempt[];
  publications?: Publication[];
};

export type ModelPolicy = {
  role: string;
  version: string;
  candidates: { provider: string; model: string; accountName: string }[];
  createdAt: string;
};

export type ProviderOverview = {
  policies: ModelPolicy[];
  accounts: ProviderAccount[];
};

export type ProviderAccount = {
  provider: string;
  name: string;
  baseUrl: string;
};

export type Summary = {
  tasks: {
    total: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
  };
  results: { issue: number; pr: number };
};

export const STATUS_ORDER = [
  "running",
  "queued",
  "publishing",
  "completed",
  "failed",
  "retry_wait",
  "canceled",
] as const;

/** Aggregated task + result counts for the overview KPIs. */
export async function fetchSummary(): Promise<Summary> {
  return (await getJson("/summary")) as Summary;
}

export type Repository = {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  taskCount: number;
  resultCount: number;
  createdAt: string;
};

export type RepositoryList = {
  items: Repository[];
  /** 能否真的实例化出 GitHub App 客户端（含 DB 覆盖）；前端用它区分空态。 */
  githubConfigured?: boolean;
};

export type RepoSyncResult = {
  status: string;
  installations: number;
  synced: number;
  errors: number;
  /** 已取消授权 / 已移除安装的仓库数（本次同步清理）。 */
  removed?: number;
  /** 已有同步在进行，本次被跳过。 */
  skipped?: boolean;
  details?: { installationId: string; reason: string }[];
  /** 本次生效的同步范围（metadata / issues_pr / full）。 */
  scope?: string;
  /** 是否触发了后续扫描/索引（范围 > metadata 时）。 */
  scanned?: boolean;
};

/** Pulls installed repositories from the GitHub App and upserts them (admin). */
export async function syncRepositories(): Promise<RepoSyncResult> {
  const response = await fetch("/repositories/sync", {
    method: "POST",
    headers: { accept: "application/json", ...authHeaders() },
  });
  // 只读一次 body：Response.body 是流，读完再读会抛
  // "Failed to execute 'json' on 'Response': body stream already read"。
  const body = (await response.json().catch(() => null)) as (RepoSyncResult & {
    reason?: string;
    detail?: string;
    rateLimitedUntil?: string | null;
  }) | null;
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (response.status === 403) throw new Error("需要管理员权限（403）");
  if (response.status === 409) {
    throw new Error(body?.reason ?? "sync_in_progress");
  }
  if (response.status === 429) {
    throw new Error(
      body?.detail ??
        (body?.reason === "rate_limited_until"
          ? "GitHub 限流暂停窗口内，请稍后再试"
          : "GitHub 限流，同步已中止"),
    );
  }
  if (!response.ok) {
    throw new Error(body?.detail ?? body?.reason ?? `sync repositories ${response.status}`);
  }
  return body as RepoSyncResult;
}

/** Lists installed GitHub repos + per-repo task/result counts. */
export async function fetchRepositories(): Promise<RepositoryList> {
  return (await getJson("/repositories")) as RepositoryList;
}

export type RepoSubjectItem = { number: number; title: string };

/**
 * Recent open issues / pull requests of an installed repository. Used by the
 * manual-trigger form to offer a pickable dropdown instead of a bare number.
 */
export async function fetchRepoSubjects(
  fullName: string,
  type: "issue" | "pr",
  limit = 20,
): Promise<RepoSubjectItem[]> {
  const params = new URLSearchParams({
    fullName,
    type,
    limit: String(limit),
  });
  const result = (await getJson(
    `/repositories/issues?${params.toString()}`,
  )) as { items: RepoSubjectItem[] };
  return result.items;
}

export type LogEvent = {
  taskId: string;
  eventType: string;
  data: unknown;
  createdAt: string;
};
export type DeliveryEntry = {
  eventName: string;
  status: string;
  outcomeReason: string | null;
  receivedAt: string;
};
export type AuditLog = { events: LogEvent[]; deliveries: DeliveryEntry[] };
export type HistoryPage = {
  events: LogEvent[];
  deliveries: DeliveryEntry[];
  nextOffset?: number;
};

/** Diagnostic bundle: recent events + webhook deliveries. */
export async function fetchLogs(): Promise<AuditLog> {
  return (await getJson("/logs")) as AuditLog;
}

/** Offset-paginated historical task events (newest first). */
export async function fetchLogHistory(
  offset: number,
  limit = 50,
): Promise<HistoryPage> {
  return (await getJson(
    `/logs?history=1&offset=${offset}&limit=${limit}`,
  )) as HistoryPage;
}

/** Events created after a bookmark (resume-from-breakpoint). */
export async function fetchLogsSince(since: string): Promise<AuditLog> {
  return (await getJson(
    `/logs?since=${encodeURIComponent(since)}`,
  )) as AuditLog;
}

export type VectorStats = {
  documents: number;
  withEmbedding: number;
  withSignals: number;
  repositoryCoverage: number;
  embeddingModel: string;
  embeddingConfigured: boolean;
  lastIndexedAt: string | null;
};

/** Duplicate-index / vector-store stats from issue_documents. */
export async function fetchVectorStats(): Promise<VectorStats> {
  return (await getJson("/vector")) as VectorStats;
}

/** Requests an immediate index-worker pass. */
export async function triggerIndexRun(): Promise<void> {
  const response = await fetch("/index/run", {
    method: "POST",
    headers: { accept: "application/json", ...authHeaders() },
  });
  if (!response.ok) throw new Error(`trigger index ${response.status}`);
}

export type IndexPassSummary = {
  pass: number;
  rebuild: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  repos: number;
  indexed: number;
  skippedUnchanged: number;
  embedded: number;
  errors: string[];
};

export type IndexStatus = {
  lastPass: IndexPassSummary | null;
  pendingTrigger: boolean;
  pendingRebuild: boolean;
};

/** Index-worker health: last pass summary + pending trigger/rebuild flags. */
export async function fetchIndexStatus(): Promise<IndexStatus> {
  return (await getJson("/index/status")) as IndexStatus;
}

/** Full index rebuild: clears issue_documents and re-indexes everything. */
export async function rebuildIndex(): Promise<void> {
  const response = await fetch("/index/rebuild", {
    method: "POST",
    headers: { accept: "application/json", ...authHeaders() },
  });
  if (!response.ok) throw new Error(`rebuild index ${response.status}`);
}

export type RelatedIssue = {
  id: string;
  repositoryId: string | null;
  repositoryFullName: string | null;
  issueNumber: number;
  score: number;
  reasons: string[];
};

/** Read-only RAG recall: candidates similar to a lead issue. */
export async function fetchRelatedIssues(input: {
  title: string;
  body: string;
  topK?: number;
  /** Optional: restrict recall to one repository (owner/name) to avoid cross-project hits. */
  repositoryFullName?: string;
}): Promise<{ candidates: RelatedIssue[]; degraded?: boolean }> {
  const params = new URLSearchParams({
    title: input.title,
    body: input.body,
    topK: String(input.topK ?? 5),
  });
  if (input.repositoryFullName) {
    params.set("repositoryFullName", input.repositoryFullName);
  }
  return (await getJson(`/index/related?${params.toString()}`)) as {
    candidates: RelatedIssue[];
    degraded?: boolean;
  };
}

export type RuntimeConfig = {
  host: string;
  port: number;
  logLevel: string;
  githubWebhookConfigured: boolean;
  githubAppConfigured: boolean;
  /** GitHub App slug（如 clodbreeze-ai-reviewer）；用于生成安装/授权仓库链接。 */
  githubAppSlug: string | null;
  webuiAuthEnabled: boolean;
  modelProviders: string[];
  embeddingModel: string;
  embeddingConfigured: boolean;
  qqBotProtocols: string[];
  qqOfficialConfigured: boolean;
  oauthConfigured: boolean;
  oauthEnabled: boolean;
  apiRateLimit: number;
  webhookRateLimit: number;
};

/** Non-secret runtime configuration snapshot. */
export async function fetchConfig(): Promise<RuntimeConfig> {
  return (await getJson("/config")) as RuntimeConfig;
}

/** 生效值的来源，界面据此显示徽章：数据库覆盖 / 环境变量 / 应用默认。 */
export type SettingSource = "database" | "env" | "default";

export type SettingItem = {
  key: string;
  /** 后端注册表提供的元数据，前端不再自己维护一份文案。 */
  group: string;
  kind: "boolean" | "string" | "secret" | "enum" | "number" | "multicheck";
  label: string;
  hint: string;
  secret: boolean;
  repoScoped: boolean;
  /** `restart` 表示改完必须重启对应容器（目前只有 QQ 相关项）。 */
  hotReload: "poll" | "restart";
  options?: string[];
  source: SettingSource;
  /** 当前生效值；secret 一律为掩码。 */
  value: string;
  /** env 是否提供了兜底值（不回显内容）。 */
  envConfigured: boolean;
  envVar: string | null;
  defaultValue: string;
  /** 数据库里是否有覆盖。 */
  hasValue: boolean;
  updatedAt: string | null;
  /** 密钥轮换：旧值在回滚窗口内（换错了可回滚）。仅 secret 且有轮换时存在。 */
  rotation?: {
    hasPrevious: boolean;
    rotatedAt: string | null;
    previousExpiresAt: string | null;
  };
};
export type SettingsList = { items: SettingItem[] };

/** Runtime-overridable settings. Secret values come back masked. */
export async function fetchSettings(): Promise<SettingsList> {
  return (await getJson("/settings")) as SettingsList;
}

/**
 * 引导层（只能来自环境变量的那几项）的健康度。CREDENTIAL_MASTER_KEY 缺失时
 * Provider 凭据与 GitHub App 私钥都保存不了，此前只在保存失败时才暴露。
 */
export type BootstrapItem = {
  key: string;
  configured: boolean;
  required: boolean;
  label: string;
  hint: string;
};
export type BootstrapStatus = { items: BootstrapItem[]; healthy: boolean };

export async function fetchSettingsBootstrap(): Promise<BootstrapStatus> {
  return (await getJson("/settings/bootstrap")) as BootstrapStatus;
}

/** 清除一个全局设置的覆盖，回落到环境变量 / 应用默认。 */
export async function clearSetting(key: string): Promise<void> {
  await putSettingValue(key, null);
}

/** Upserts a runtime setting; it hot-applies without a restart. */
export async function saveSetting(key: string, value: string): Promise<void> {
  await putSettingValue(key, value);
}

/**
 * 写入或清除一个全局设置。`value: null` 表示删除覆盖、回落到 env / 应用默认。
 *
 * 不走 putJson：后者把 400 一律变成 "request failed with 400"，用户看不到
 * invalid_setting_value 携带的具体原因（比如「只能取 debug / info / …」）。
 */
async function putSettingValue(
  key: string,
  value: string | null,
): Promise<void> {
  const response = await fetch("/settings", {
    method: "PUT",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ key, value }),
  });
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { reason?: unknown; detail?: unknown }
      | null;
    const reason = typeof body?.reason === "string" ? body.reason : "";
    const detail = typeof body?.detail === "string" ? body.detail : "";
    throw new Error(
      // detail 是给人看的原因，reason 是错误码；两者都保留，便于翻译层匹配。
      [reason, detail].filter(Boolean).join("：") ||
        `request failed with ${response.status}`,
    );
  }
  bumpCache();
}

/** 仓库级设置项：`overridden` 为 false 时该仓库跟随全局值。 */
export type RepositorySettingItem = {
  key: string;
  /** 字段文案由后端注册表提供，前端不再维护第二份。 */
  label: string;
  hint: string;
  kind: "boolean" | "string" | "secret" | "enum" | "number" | "multicheck";
  secret: boolean;
  options?: string[];
  overridden: boolean;
  value: string;
  globalValue: string;
  /** 全局也没配时的应用默认。 */
  defaultValue: string;
};

export type RepositorySettings = {
  repository: { id: string; fullName: string };
  items: RepositorySettingItem[];
};

export async function fetchRepositorySettings(
  repositoryId: string,
): Promise<RepositorySettings> {
  return (await getJson(
    `/repositories/${encodeURIComponent(repositoryId)}/settings`,
  )) as RepositorySettings;
}

/**
 * 写入或清除一个仓库级覆盖。`value: null` 表示删除覆盖、回到跟随全局。
 *
 * 不走 putJson：后者把 400 一律变成 "request failed with 400"，用户看不到
 * unsupported_setting_key 这类真实原因。
 */
export async function saveRepositorySetting(
  repositoryId: string,
  key: string,
  value: string | null,
): Promise<void> {
  const response = await fetch(
    `/repositories/${encodeURIComponent(repositoryId)}/settings`,
    {
      method: "PUT",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({ key, value }),
    },
  );
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (!response.ok) {
    const reason = await response
      .json()
      .then((body: unknown) =>
        typeof body === "object" && body !== null && "reason" in body
          ? String((body as { reason: unknown }).reason)
          : "",
      )
      .catch(() => "");
    throw new Error(reason || `request failed with ${response.status}`);
  }
  bumpCache();
}

/* ---------- 仓库审核规则（WebUI「审核规则」功能页） ---------- */

export type RepoRulesItem = {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  enabled: boolean;
  hasRulesDir: boolean;
  files: { name: string; path: string }[];
};

export type RepoRulesList = {
  githubConfigured?: boolean;
  items: RepoRulesItem[];
};

export type RepoRulesDetail = {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  enabled: boolean;
  ref: string;
  files: { name: string; path: string }[];
};

/** GET /repo-rules —— 所有仓库 + 规则状态摘要。 */
export async function fetchRepoRulesList(): Promise<RepoRulesList> {
  return (await getJson("/repo-rules")) as RepoRulesList;
}

/** GET /repo-rules/:id —— 单仓库规则文件列表 + 开关状态。 */
export async function fetchRepoRulesDetail(
  repositoryId: string,
): Promise<RepoRulesDetail> {
  return (await getJson(
    `/repo-rules/${encodeURIComponent(repositoryId)}`,
  )) as RepoRulesDetail;
}

/** GET /repo-rules/:id/file?path=… —— 读取单个规则文件内容。 */
export async function fetchRepoRulesFile(
  repositoryId: string,
  filePath: string,
): Promise<{ path: string; content: string }> {
  return (await getJson(
    `/repo-rules/${encodeURIComponent(repositoryId)}/file?path=${encodeURIComponent(filePath)}`,
  )) as { path: string; content: string };
}

/** PUT /repo-rules/:id/file —— 创建 / 更新规则文件。 */
export async function saveRepoRulesFile(
  repositoryId: string,
  filePath: string,
  content: string,
  sha?: string,
): Promise<void> {
  const response = await fetch(
    `/repo-rules/${encodeURIComponent(repositoryId)}/file`,
    {
      method: "PUT",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({ path: filePath, content, ...(sha ? { sha } : {}) }),
    },
  );
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (response.status === 403) throw new Error("需要管理员权限（403）");
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      detail?: unknown;
      reason?: unknown;
    } | null;
    throw new Error(
      String(body?.detail ?? body?.reason ?? `request failed with ${response.status}`),
    );
  }
  bumpCache();
}

/** DELETE /repo-rules/:id/file?path=… —— 删除规则文件。 */
export async function deleteRepoRulesFile(
  repositoryId: string,
  filePath: string,
): Promise<void> {
  const response = await fetch(
    `/repo-rules/${encodeURIComponent(repositoryId)}/file?path=${encodeURIComponent(filePath)}`,
    {
      method: "DELETE",
      headers: { accept: "application/json", ...authHeaders() },
    },
  );
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (response.status === 403) throw new Error("需要管理员权限（403）");
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      detail?: unknown;
      reason?: unknown;
    } | null;
    throw new Error(
      String(body?.detail ?? body?.reason ?? `request failed with ${response.status}`),
    );
  }
  bumpCache();
}

/** POST /repo-rules/:id/from-url —— 从 URL 拉取内容写入规则文件。 */
export async function importRepoRulesFromUrl(
  repositoryId: string,
  remoteUrl: string,
  filePath: string,
): Promise<void> {
  const response = await fetch(
    `/repo-rules/${encodeURIComponent(repositoryId)}/from-url`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({ url: remoteUrl, path: filePath }),
    },
  );
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (response.status === 403) throw new Error("需要管理员权限（403）");
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      detail?: unknown;
      reason?: unknown;
    } | null;
    throw new Error(
      String(body?.detail ?? body?.reason ?? `request failed with ${response.status}`),
    );
  }
  bumpCache();
}

export type CapabilitySkill = {
  id: string;
  name: string;
  appliesTo: "issue" | "pr";
  description: string;
};

export type CapabilityExpert = {
  id: string;
  name: string;
  appliesTo: "issue" | "pr";
};

export type Capabilities = {
  skills: CapabilitySkill[];
  experts: CapabilityExpert[];
  enabled: boolean;
};

/** Agent capabilities catalog: skills + expert team + enablement flag. */
export async function fetchCapabilities(): Promise<Capabilities> {
  return (await getJson("/capabilities")) as Capabilities;
}

/** Toggles the expert-team pipeline (admin only). */
export async function setExpertTeamEnabled(enabled: boolean): Promise<void> {
  const response = await fetch("/capabilities", {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ enabled }),
  });
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (response.status === 403) throw new Error("需要管理员权限（403）");
  if (!response.ok) throw new Error(`capabilities ${response.status}`);
}

export type BackupSetting = {
  key: string;
  value: string | null;
  hasValue: boolean;
};

export type BackupPolicy = {
  role: string;
  version: string;
  candidates: unknown;
};

export type BackupSnapshot = {
  version: string;
  exportedAt: string;
  settings: BackupSetting[];
  policies: BackupPolicy[];
  providers: string[];
};

/** Exports runtime configuration (settings masked, policies, provider names). */
export async function fetchBackup(): Promise<BackupSnapshot> {
  return (await getJson("/backup")) as BackupSnapshot;
}

export type BackupImportResult = {
  status: string;
  settings: number;
  policies: number;
  skippedSecrets: string[];
  skippedProviders: string[];
};

/** Restores non-secret settings + model role policies from a snapshot. */
export async function importBackup(snapshot: unknown): Promise<BackupImportResult> {
  const response = await fetch("/backup/import", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(snapshot),
  });
  const text = await response.text();
  if (!response.ok) {
    let reason = `import backup ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { reason?: string };
      if (parsed.reason) reason = parsed.reason;
    } catch {
      // keep default
    }
    throw new Error(reason);
  }
  return JSON.parse(text) as BackupImportResult;
}

export type LabelRuleItem = {
  key: string;
  label: string;
  enabled: boolean;
};

export type LabelRulesResult = {
  items: LabelRuleItem[];
  prefixes: string[];
};

/** Lists configured label rules (analysis field -> GitHub label). */
export async function fetchLabelRules(): Promise<LabelRulesResult> {
  return (await getJson("/label-rules")) as LabelRulesResult;
}

/** Upserts a label rule; an empty label deletes the rule. */
export async function saveLabelRule(rule: LabelRuleItem): Promise<void> {
  const response = await fetch("/label-rules", {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(rule),
  });
  if (!response.ok) throw new Error(`save label rule ${response.status}`);
}

/** Deletes a label rule by its key. */
export async function deleteLabelRule(key: string): Promise<void> {
  const response = await fetch(
    `/label-rules/${encodeURIComponent(key)}`,
    { method: "DELETE", headers: authHeaders() },
  );
  if (!response.ok && response.status !== 404)
    throw new Error(`delete label rule ${response.status}`);
}

export type RepoMemoryKind = "reflection" | "rule" | "knowledge";

export type RepoMemoryItem = {
  id: string;
  repositoryId: string | null;
  kind: RepoMemoryKind;
  title: string;
  content: string;
  sourceType: string | null;
  sourceRef: string | null;
  consolidated: boolean;
  createdAt: string;
  updatedAt: string;
};

export type RepoMemoryList = {
  items: RepoMemoryItem[];
  counts: { reflection: number; rule: number; knowledge: number };
  nextOffset?: number;
};

export type MemoryFilter = {
  repositoryId?: string;
  kind?: RepoMemoryKind;
  limit?: number;
  offset?: number;
};

/** Lists repository memory, newest first; counts always included. */
export async function fetchRepoMemory(
  filter: MemoryFilter = {},
): Promise<RepoMemoryList> {
  const params = new URLSearchParams();
  if (filter.repositoryId) params.set("repositoryId", filter.repositoryId);
  if (filter.kind) params.set("kind", filter.kind);
  if (filter.limit !== undefined) params.set("limit", String(filter.limit));
  if (filter.offset !== undefined) params.set("offset", String(filter.offset));
  const query = params.toString();
  return (await getJson(`/memory${query ? `?${query}` : ""}`)) as RepoMemoryList;
}

export type MemoryConsolidationResult = {
  status: string;
  repositories: number;
  rules: number;
};

/** 手动创建仓库记忆条目（规则/知识，管理员）；kind 限 rule | knowledge。 */
export async function createRepoMemory(input: {
  kind: "rule" | "knowledge";
  title: string;
  content: string;
  repositoryId?: string;
}): Promise<void> {
  const response = await fetch("/memory", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (!response.ok) {
    const reason =
      response.status === 403
        ? "需要管理员权限（403）"
        : `memory create ${response.status}`;
    throw new Error(reason);
  }
}

/** Runs one memory-consolidation sweep (admin only). */
export async function triggerMemoryConsolidation(): Promise<MemoryConsolidationResult> {
  const response = await fetch("/memory/consolidate", {
    method: "POST",
    headers: { accept: "application/json", ...authHeaders() },
  });
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (!response.ok) {
    const reason =
      response.status === 403
        ? "需要管理员权限（403）"
        : `memory consolidate ${response.status}`;
    throw new Error(reason);
  }
  return (await response.json()) as MemoryConsolidationResult;
}

/** Deletes a single memory row (admin only); missing row is not an error. */
export async function deleteRepoMemory(id: string): Promise<void> {
  const response = await fetch(`/memory/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (!response.ok && response.status !== 403 && response.status !== 404) {
    throw new Error(`memory delete ${response.status}`);
  }
}

export type OAuthStatus = { oauthConfigured: boolean };

/** Whether GitHub OAuth login is wired up (unauthenticated endpoint). */
export async function fetchOAuthStatus(): Promise<OAuthStatus> {
  const response = await fetch("/auth/status", {
    headers: { accept: "application/json" },
  });
  if (!response.ok) return { oauthConfigured: false };
  return (await response.json()) as OAuthStatus;
}

export type AccountInfo = {
  login: string | null;
  displayName: string | null;
  isAdmin: boolean;
  isReadOnly: boolean;
  hasPassword: boolean;
  needsBootstrap?: boolean;
  authMethod: "oauth" | "bearer" | "password";
};

/** Current account: the OAuth login, a password-login session, or a bearer token. */
export async function fetchMe(): Promise<AccountInfo> {
  return (await getJson("/auth/me")) as AccountInfo;
}

/** 本地密码登录（方向一）：返回会话 token 与用户信息。 */
export async function loginLocal(input: {
  username: string;
  password: string;
}): Promise<{ token: string; user: AccountInfo }> {
  const response = await fetch("/auth/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await response.json().catch(() => ({}))) as {
    status?: string;
    reason?: string;
    token?: string;
    user?: AccountInfo;
  };
  if (!response.ok || !data.token) {
    const reason = data.reason === "invalid_credentials" ? "用户名或密码错误" : (data.reason ?? "登录失败");
    throw new Error(reason);
  }
  return { token: data.token, user: data.user };
}

/** 引导创建首个本地管理员（无本地 admin 时开放）。 */
export async function registerLocal(input: {
  username: string;
  password: string;
}): Promise<{ token: string; user: AccountInfo }> {
  const response = await fetch("/auth/register", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await response.json().catch(() => ({}))) as {
    status?: string;
    reason?: string;
    token?: string;
    user?: AccountInfo;
  };
  if (!response.ok || !data.token)
    throw new Error(data.reason ?? "创建管理员失败");
  return { token: data.token, user: data.user };
}

/** 登出：吊销当前会话。 */
export async function logoutLocal(): Promise<void> {
  await fetch("/auth/logout", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(),
  });
}

/** 改密：本地账号。返回是否成功（旧密错误时抛错）。 */
export async function changePassword(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  const response = await fetch("/auth/password", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as {
      reason?: string;
    };
    throw new Error(data.reason ?? "修改密码失败");
  }
}

/** Updates the display name of the OAuth user. */
export async function saveMe(displayName: string): Promise<AccountInfo> {
  const response = await fetch("/auth/me", {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ displayName }),
  });
  if (!response.ok) throw new Error(`save account ${response.status}`);
  return (await response.json()) as AccountInfo;
}

export type UserRow = {
  login: string;
  displayName: string;
  isAdmin: boolean;
  /** 只读操作员：可查看，禁止写操作。 */
  isReadOnly: boolean;
};

/** Lists known users (admin only). */
export async function fetchUsers(): Promise<UserRow[]> {
  const result = (await getJson("/users")) as { items: UserRow[] };
  return result.items;
}

/** 更新用户角色位（管理员 / 只读操作员）。 */
export async function setUserRoles(
  login: string,
  roles: { isAdmin?: boolean; isReadOnly?: boolean },
): Promise<UserRow> {
  const response = await fetch(`/users/${encodeURIComponent(login)}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(roles),
  });
  if (!response.ok) throw new Error(`set user roles ${response.status}`);
  return (await response.json()) as UserRow;
}

/* ---------- 方向七：仓库可见性授权 ---------- */

export type GrantAccess = "view" | "manage";

export type RepoGrant = {
  userLogin: string;
  repositoryId: string;
  access: GrantAccess;
};

export type RepoGrantList = { items: RepoGrant[] };

/** 列出仓库授权（admin）。支持按用户 / 仓库筛选。 */
export async function fetchGrants(opts?: {
  user?: string;
  repository?: string;
}): Promise<RepoGrant[]> {
  const params = new URLSearchParams();
  if (opts?.user) params.set("user", opts.user);
  if (opts?.repository) params.set("repository", opts.repository);
  const qs = params.toString();
  const result = (await getJson(`/grants${qs ? `?${qs}` : ""}`)) as RepoGrantList;
  return result.items;
}

/** 设置 / 更新某用户对某仓库的授权（admin）。 */
export async function setGrant(
  userLogin: string,
  repositoryId: string,
  access: GrantAccess,
): Promise<RepoGrant> {
  const response = await fetch(
    `/grants/${encodeURIComponent(userLogin)}/${encodeURIComponent(repositoryId)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ access }),
    },
  );
  if (!response.ok) throw new Error(`set grant ${response.status}`);
  return (await response.json()) as RepoGrant;
}

/** 移除某用户对某仓库的授权（admin）。 */
export async function deleteGrant(
  userLogin: string,
  repositoryId: string,
): Promise<void> {
  const response = await fetch(
    `/grants/${encodeURIComponent(userLogin)}/${encodeURIComponent(repositoryId)}`,
    { method: "DELETE", headers: { ...authHeaders() } },
  );
  if (!response.ok) throw new Error(`delete grant ${response.status}`);
}

export type AuditEntry = {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  detail: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
};
/** Lists the security audit trail, newest first (admin only). */
export async function fetchAuditLog(offset = 0, limit = 50): Promise<AuditEntry[]> {
  const result = (await getJson(`/audit?offset=${offset}&limit=${limit}`)) as {
    items: AuditEntry[];
  };
  return result.items;
}

export type MetricsDurationBucket = { count: number; totalMs: number };
export type MetricsSnapshot = {
  counters: Record<string, number>;
  durations: Record<string, MetricsDurationBucket>;
  gauges: Record<string, number>;
  since: string;
};

/** 管理员可见的运行时指标快照（进程计数 + 库内实时量规）。 */
export async function fetchMetrics(): Promise<MetricsSnapshot> {
  return (await getJson("/metrics")) as MetricsSnapshot;
}

export type AlertRecord = {
  id: string;
  severity: "info" | "warning" | "critical";
  message: string;
  status: "active" | "resolved";
  firstAt: string;
  lastAt: string;
  value: number;
};

/** 当前告警状态（active 在前）。 */
export async function fetchAlerts(): Promise<AlertRecord[]> {
  const result = (await getJson("/alerts")) as { items: AlertRecord[] };
  return result.items;
}

export type SetupStatus = {
  database: { ok: boolean; tablesReady: number; tablesTotal: number };
  provider: { count: number; providerKey: string; model: string };
  policies: { count: number; required: number };
  githubWebhookConfigured: boolean;
  githubAppConfigured: boolean;
  oauthConfigured: boolean;
  embeddingConfigured: boolean;
  initialized: boolean;
  /** WEBUI_API_TOKEN surfaced only while the system is uninitialized. */
  webuiToken?: string;
};

/** Install wizard diagnostics (public endpoint). */
export async function fetchSetupStatus(): Promise<SetupStatus> {
  const response = await fetch("/setup/status", {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`setup status ${response.status}`);
  return (await response.json()) as SetupStatus;
}

export type SetupInitResult = {
  status: string;
  created: number;
  roles?: string[];
  reason?: string;
  skipped?: string;
};

/** One-click init: seed default model policies when uninitialized. */
export async function setupInit(): Promise<SetupInitResult> {
  const response = await fetch("/setup/init", { method: "POST" });
  if (!response.ok) throw new Error(`setup init ${response.status}`);
  return (await response.json()) as SetupInitResult;
}

/** POST to a public setup config endpoint; surfaces a readable error. */
async function postSetup(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as {
    reason?: string;
    hint?: string;
    httpStatus?: number;
    endpoint?: string;
    detail?: string;
  };
  if (!response.ok) {
    if (!data.reason) throw new Error(`request failed with ${response.status}`);
    // 带上上游状态码、实际请求的端点与返回正文：这些才是用户判断
    // 「密钥无效 / 余额不足 / 地址不对」的依据，丢掉就只剩一个错误码。
    const parts = [data.reason];
    if (data.hint) parts.push(`— ${data.hint}`);
    const extras: string[] = [];
    if (data.httpStatus) extras.push(`上游状态 ${data.httpStatus}`);
    if (data.endpoint) extras.push(`请求 ${data.endpoint}`);
    if (data.detail) extras.push(`返回 ${data.detail}`);
    if (extras.length > 0) parts.push(`（${extras.join("；")}）`);
    throw new Error(parts.join(" "));
  }
  return data;
}

export type ProviderSaveResult = {
  status: string;
  provider: string;
  accountName: string;
  model: string;
  policiesUpdated: number;
};

/** Pulls an OpenAI-compatible model list for a base URL + API key. */
export async function fetchModels(
  baseUrl: string,
  apiKey: string,
): Promise<string[]> {
  const data = (await postSetup("/setup/models", { baseUrl, apiKey })) as {
    models?: string[];
  };
  return data.models ?? [];
}

/** Saves a model provider account and wires it into every role policy. */
export async function saveProvider(input: {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  accountName?: string;
}): Promise<ProviderSaveResult> {
  return (await postSetup("/setup/provider", input)) as ProviderSaveResult;
}

/** Deletes a provider account and prunes it from every role policy (issue #58). */
export async function deleteProvider(input: {
  provider: string;
  accountName: string;
}): Promise<{ status: string }> {
  const response = await fetch("/providers/delete", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(input),
  });
  const data = (await response.json().catch(() => ({}))) as {
    status?: string;
    reason?: string;
    hint?: string;
    httpStatus?: number;
    endpoint?: string;
    detail?: string;
  };
  if (!response.ok) {
    if (!data.reason) throw new Error(`request failed with ${response.status}`);
    const parts = [data.reason];
    if (data.hint) parts.push(`— ${data.hint}`);
    if (data.httpStatus) parts.push(`（上游状态 ${data.httpStatus}）`);
    throw new Error(parts.join(" "));
  }
  return data as { status: string };
}

/** Stores the embedding endpoint as a hot runtime setting. */
export async function saveEmbedding(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
}): Promise<{ status: string; baseUrl: string; model: string }> {
  return (await postSetup("/setup/embedding", input)) as {
    status: string;
    baseUrl: string;
    model: string;
  };
}

/** Generates and persists a GitHub webhook secret; returns it once. */
export async function genWebhookSecret(): Promise<string> {
  const data = (await postSetup("/setup/webhook-secret", {})) as {
    secret?: string;
  };
  if (!data.secret) throw new Error("no secret returned");
  return data.secret;
}

/** Generates a GitHub OAuth client secret (and stores client id if given). */
export async function saveOAuth(input: {
  clientId?: string;
}): Promise<{ clientId: string; clientSecret: string; callbackPath: string }> {
  return (await postSetup("/setup/oauth", input)) as {
    clientId: string;
    clientSecret: string;
    callbackPath: string;
  };
}

/**
 * 保存 GitHub App 凭据。私钥加密存储，后端会先签 JWT 调 GitHub 验证再落库，
 * 因此保存失败即说明凭据本身有问题。
 */
export async function saveGithubApp(input: {
  appId: string;
  privateKeyPem: string;
}): Promise<{ status: string; appId: string; appSlug: string }> {
  return (await postSetup("/setup/github-app", input)) as {
    status: string;
    appId: string;
    appSlug: string;
  };
}

/** Fetches both liveness and readiness; the UI shows a clear error on failure. */
export async function fetchHealth(): Promise<HealthResult> {
  const live = (await getJson("/health/live")) as { status?: string };
  if (live.status !== "ok") throw new Error("liveness check failed");
  const ready = (await getJson("/health/ready")) as ReadyHealth;
  return { kind: "ready", data: ready };
}

export type UpdateStatus = {
  current: { version: string; composeProject: string };
  latest: { tags: string[]; version: string | null; digest: string | null };
  updateAvailable: boolean;
  updateChannel: string;
  inProgress?: boolean;
};

export type UpdateHistoryEntry = {
  at: string;
  from: string;
  to: string;
  ok: boolean;
  reason?: string;
};

/** Online update: current vs latest version comparison (registry check). */
export async function fetchUpdateStatus(): Promise<UpdateStatus> {
  const response = await fetch("/update/status", {
    headers: { accept: "application/json", ...authHeaders() },
  });
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (!response.ok) {
    if (response.status === 503)
      throw new Error("暂时无法连接镜像仓库（registry_unreachable）");
    throw new Error(`update status ${response.status}`);
  }
  return (await response.json()) as UpdateStatus;
}

/** Online update: recent update history (admin). */
export async function fetchUpdateHistory(): Promise<UpdateHistoryEntry[]> {
  const result = (await getJson("/update/history")) as {
    items: UpdateHistoryEntry[];
  };
  return result.items;
}

/**
 * Online update: triggers an update, returning the SSE body stream of log
 * lines (`log` / `done` events). Admin only.
 */
export async function applyUpdate(
  target: string,
  backupBefore: boolean,
): Promise<ReadableStream<Uint8Array> | null> {
  const response = await fetch("/update/apply", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ target, backupBefore }),
  });
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (response.status === 403) throw new Error("需要管理员权限（403）");
  if (response.status === 409) throw new Error("已有更新任务在运行（409）");
  if (!response.ok) throw new Error(`update apply ${response.status}`);
  return response.body;
}

/** Lists tasks, newest first, offset-paginated by the previous response. */
export async function fetchTasks(options?: {
  limit?: number;
  offset?: number;
}): Promise<TaskList> {
  const params = new URLSearchParams();
  if (options?.limit) params.set("limit", String(options.limit));
  if (options?.offset !== undefined)
    params.set("offset", String(options.offset));
  const query = params.toString();
  return (await getJson(`/tasks${query ? `?${query}` : ""}`)) as TaskList;
}

/** Fetches a single task with its timeline and attempts. */
export async function fetchTaskDetail(id: string): Promise<TaskDetail> {
  return (await getJson(`/tasks/${encodeURIComponent(id)}`)) as TaskDetail;
}

export type RerunResult = {
  status: string;
  rerun: number;
  skipped: number;
};

export type CheckRunStatus = {
  id: number;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  title: string | null;
  htmlUrl: string | null;
};

export type TaskCheckRunResult = {
  status: string;
  present: boolean;
  degraded?: boolean;
  checkRun?: CheckRunStatus;
};

/** Live status of a task's published GitHub Check Run (polled by the WebUI). */
export async function fetchTaskCheckRun(
  taskId: string,
): Promise<TaskCheckRunResult> {
  return (await getJson(
    `/tasks/check-run?taskId=${encodeURIComponent(taskId)}`,
  )) as TaskCheckRunResult;
}

/** Re-queues finished tasks (failed / canceled) for another run (admin only). */
export async function rerunTasks(taskIds: string[]): Promise<RerunResult> {
  const response = await fetch("/tasks/rerun", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ taskIds }),
  });
  const text = await response.text();
  let parsed: { status?: string; reason?: string; rerun?: number; skipped?: number } = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // keep default
  }
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (response.status === 403) throw new Error("需要管理员权限（403）");
  if (!response.ok) {
    throw new Error(parsed.reason ?? `rerun tasks ${response.status}`);
  }
  return {
    status: parsed.status ?? "ok",
    rerun: parsed.rerun ?? 0,
    skipped: parsed.skipped ?? 0,
  };
}

export type CancelResult = {
  status: string;
  canceled: number;
  skipped: number;
};

export async function cancelTasks(taskIds: string[]): Promise<CancelResult> {
  const response = await fetch("/tasks/cancel", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ taskIds }),
  });
  const text = await response.text();
  let parsed: {
    status?: string;
    reason?: string;
    canceled?: number;
    skipped?: number;
  } = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // keep default
  }
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (response.status === 403) throw new Error("需要管理员权限（403）");
  if (!response.ok) {
    throw new Error(parsed.reason ?? `cancel tasks ${response.status}`);
  }
  return {
    status: parsed.status ?? "ok",
    canceled: parsed.canceled ?? 0,
    skipped: parsed.skipped ?? 0,
  };
}

export type ManualTriggerInput = {
  type: "issue" | "pr";
  repositoryFullName: string;
  subjectNumber: number;
};

export type ManualTriggerResult = {
  status: string;
  taskId: string;
  outcome: "created" | "duplicate";
};

/**
 * Manually enqueues an issue analysis or PR review task for an installed
 * repository. Returns the created task id (or reports a dedupe hit).
 */
export async function triggerManualTask(
  input: ManualTriggerInput,
): Promise<ManualTriggerResult> {
  const response = await fetch("/tasks/manual", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(input),
  });
  const text = await response.text();
  let parsed: { status?: string; reason?: string; taskId?: string; outcome?: "created" | "duplicate" } = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // keep default
  }
  if (!response.ok) {
    const reason = parsed.reason ?? `manual trigger ${response.status}`;
    throw new Error(reason);
  }
  return {
    status: parsed.status ?? "ok",
    taskId: parsed.taskId ?? "",
    outcome: parsed.outcome ?? "created",
  };
}

export type RevokeResult = {
  status: string;
  revoked: { comments: number; reviews: number; labels: number };
};

/**
 * One-click revoke of a published AI analysis / review: deletes issue
 * comments, dismisses PR reviews, and removes suggested labels (admin only).
 */
export async function revokeSubject(input: {
  repositoryFullName: string;
  number: number;
  type: "issue" | "pr";
}): Promise<RevokeResult> {
  const response = await fetch("/repos/revoke", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(input),
  });
  const text = await response.text();
  let parsed: { status?: string; reason?: string; revoked?: RevokeResult["revoked"] } = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // keep default
  }
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (response.status === 403) throw new Error("需要管理员权限（403）");
  if (!response.ok) {
    throw new Error(parsed.reason ?? `revoke subject ${response.status}`);
  }
  return {
    status: parsed.status ?? "ok",
    revoked: parsed.revoked ?? { comments: 0, reviews: 0, labels: 0 },
  };
}

/** Fetches model role policies + provider account names (no secrets). */
export async function fetchProviders(): Promise<ProviderOverview> {
  return (await getJson("/providers")) as ProviderOverview;
}

export type SubjectResult = {
  subjectType: "issue" | "pr";
  subjectNumber: number;
  repositoryFullName: string;
  revision: string;
  result: unknown;
  published: boolean;
  createdAt: string;
};

export type ResultList = {
  items: SubjectResult[];
  nextOffset?: number;
};

/** Lists persisted issue/PR results, newest first, offset-paginated. */
export async function fetchResults(
  type: "issue" | "pr",
  offset?: number,
): Promise<ResultList> {
  const params = new URLSearchParams({ type });
  if (offset !== undefined) params.set("offset", String(offset));
  return (await getJson(`/results?${params.toString()}`)) as ResultList;
}

export type ResultsDeleteResult = {
  status: string;
  deleted: number;
  notFound: number;
};

/** Batch-deletes persisted results (admin only). */
export async function deleteResults(
  items: { subjectType: "issue" | "pr"; subjectNumber: number; repositoryFullName: string; revision: string }[],
): Promise<ResultsDeleteResult> {
  const response = await fetch("/results/delete", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ items }),
  });
  const text = await response.text();
  let parsed: { status?: string; reason?: string; deleted?: number; notFound?: number } = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // keep default
  }
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (response.status === 403) throw new Error("需要管理员权限（403）");
  if (!response.ok) {
    throw new Error(parsed.reason ?? `delete results ${response.status}`);
  }
  return {
    status: parsed.status ?? "ok",
    deleted: parsed.deleted ?? 0,
    notFound: parsed.notFound ?? 0,
  };
}

/* ---------- repository scanning (scan-worker) ---------- */

export type ScanConfigItem = {
  repositoryId: string;
  owner: string;
  name: string;
  fullName: string;
  installed: boolean;
  enabled: boolean;
  intervalMinutes: number;
  maxIssues: number;
  maxPrs: number;
  autoAnalyzeIssues: boolean;
  autoAnalyzePrs: boolean;
  createTrackingIssues: boolean;
  updatedAt: string | null;
};

export type ScansConfig = {
  enabled: boolean;
  items: ScanConfigItem[];
};

export type ScanRun = {
  id: string;
  repositoryId: string | null;
  repositoryFullName: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "completed" | "failed";
  trigger: "scheduled" | "manual";
  scannedIssues: number;
  scannedPrs: number;
  createdIssueTasks: number;
  createdPrTasks: number;
  createdTrackingIssues: number;
  skipped: number;
  error: string | null;
};

export type ScanRunsResult = {
  items: ScanRun[];
  nextOffset?: number;
};

/** Global scan switch + per-repository effective scan configs. */
export async function fetchScansConfig(): Promise<ScansConfig> {
  return (await getJson("/scans/config")) as ScansConfig;
}

/** Updates the global scan switch, or one repository's scan config (admin). */
export async function saveScansConfig(
  input: Partial<ScanConfigItem> & { repositoryId?: string; enabled?: boolean },
): Promise<void> {
  const response = await fetch("/scans/config", {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (response.status === 403) throw new Error("需要管理员权限（403）");
  if (!response.ok) throw new Error(`save scan config ${response.status}`);
  bumpCache();
}

/** Requests an immediate scan pass (scan-worker picks it up on next loop). */
export async function triggerScan(): Promise<void> {
  const response = await fetch("/scans/run", {
    method: "POST",
    headers: { accept: "application/json", ...authHeaders() },
  });
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (response.status === 403) throw new Error("需要管理员权限（403）");
  if (!response.ok) throw new Error(`trigger scan ${response.status}`);
  bumpCache();
}

/** Scan run history, newest first, offset-paginated. */
export async function fetchScanRuns(
  offset?: number,
  limit = 50,
): Promise<ScanRunsResult> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (offset !== undefined) params.set("offset", String(offset));
  return (await getJson(`/scans/runs?${params.toString()}`)) as ScanRunsResult;
}

/* ---------- qq-bot lifecycle (container start/stop) ---------- */

export type BotStatus = {
  status: "running" | "exited" | "absent" | "unknown";
  ok: boolean;
};

export type BotActionResult = {
  status: string;
  detail?: string;
  code?: number | null;
};

/** GET /bot/status — qq-bot 容器运行状态（管理员）。 */
export async function fetchBotStatus(): Promise<BotStatus> {
  return (await getJson("/bot/status")) as BotStatus;
}

async function botAction(
  action: "start" | "stop",
): Promise<BotActionResult> {
  const response = await fetch(`/bot/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
  });
  const text = await response.text();
  let parsed: { status?: string; reason?: string; detail?: string; code?: number | null } = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // keep default
  }
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (response.status === 403) throw new Error("需要管理员权限（403）");
  if (!response.ok) {
    throw new Error(
      parsed.detail || parsed.reason || `bot ${action} ${response.status}`,
    );
  }
  return { status: parsed.status ?? "ok", detail: parsed.detail, code: parsed.code };
}

/** POST /bot/start — 启动 qq-bot 容器（管理员）。 */
export async function startBot(): Promise<BotActionResult> {
  return botAction("start");
}

/** POST /bot/stop — 停止 qq-bot 容器（管理员）。 */
export async function stopBot(): Promise<BotActionResult> {
  return botAction("stop");
}

/** Webhook 自检结果：GitHub 侧配置 + 最近投递统计 + 中文诊断。 */
export type WebhookSelfTestResult = {
  status: string;
  webhookUrl: string;
  urlLooksRight: boolean;
  contentType: string;
  recentDeliveries: {
    event: string;
    statusCode: number | null;
    deliveredAt: string;
  }[];
  diagnosis: string;
};

/**
 * POST /webhook-selftest — 触发 App webhook 测试投递并回查结果（管理员）。
 * 路径配错 / 签名不一致 / 入口不通三类故障在这里一次闭环。
 */
export async function runWebhookSelfTest(): Promise<WebhookSelfTestResult> {
  const response = await fetch("/webhook-selftest", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
  });
  const text = await response.text();
  let parsed: (Partial<WebhookSelfTestResult> & { reason?: string; detail?: string }) = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // keep default
  }
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (!response.ok) {
    throw new Error(parsed.detail || parsed.reason || `selftest ${response.status}`);
  }
  return parsed as WebhookSelfTestResult;
}
