import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const taskStatus = pgEnum("task_status", [
  "queued",
  "leased",
  "running",
  "publishing",
  "completed",
  "retry_wait",
  "failed",
  "canceled",
]);

/**
 * 向量列类型。维度必须与 `EMBEDDING_MODEL` 实际输出一致：
 * 当前用 cf-free.binbim.locker 的 text-embedding-3-small（BGE-M3，1024 维）。
 * 更换嵌入模型且维度变化时，需生成 Drizzle migration 清空向量与 content_hash
 * 并 ALTER 列类型，随后由 index-worker 全量重建索引。
 */
export const pgVector1024 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1024)";
  },
  toDriver(value) {
    return `[${value.join(",")}]`;
  },
  fromDriver(value) {
    if (Array.isArray(value)) return value;
    const str = String(value);
    return str.startsWith("[")
      ? JSON.parse(str)
      : JSON.parse(`[${str.slice(1, -1)}]`);
  },
});

export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    githubId: text("github_id").notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    installationId: text("installation_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("repositories_github_id_unique").on(table.githubId)],
);

export const githubInstallations = pgTable(
  "github_installations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    githubInstallationId: text("github_installation_id").notNull(),
    accountLogin: text("account_login").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("github_installations_external_id_unique").on(
      table.githubInstallationId,
    ),
  ],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deliveryId: text("delivery_id").notNull(),
    eventName: varchar("event_name", { length: 100 }).notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    processingStatus: varchar("processing_status", { length: 20 })
      .default("received")
      .notNull(),
    taskId: uuid("task_id"),
    outcomeReason: varchar("outcome_reason", { length: 100 }),
  },
  (table) => [
    uniqueIndex("webhook_deliveries_delivery_id_unique").on(table.deliveryId),
  ],
);

export const analysisTasks = pgTable(
  "analysis_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskType: varchar("task_type", { length: 50 }).notNull(),
    repositoryId: uuid("repository_id").references(() => repositories.id),
    subjectNumber: integer("subject_number"),
    subjectRevision: text("subject_revision").notNull(),
    policyVersion: text("policy_version").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    status: taskStatus("status").default("queued").notNull(),
    priority: integer("priority").default(0).notNull(),
    payload: jsonb("payload").notNull(),
    pendingPayload: jsonb("pending_payload"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(3).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastErrorCategory: varchar("last_error_category", { length: 100 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("analysis_tasks_dedupe_key_unique").on(table.dedupeKey),
    index("analysis_tasks_claim_idx").on(
      table.status,
      table.nextAttemptAt,
      table.priority,
    ),
    index("analysis_tasks_lease_expiry_idx").on(table.leaseExpiresAt),
  ],
);

export const taskAttempts = pgTable(
  "task_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => analysisTasks.id),
    attemptNumber: integer("attempt_number").notNull(),
    workerId: text("worker_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    errorCategory: varchar("error_category", { length: 100 }),
  },
  (table) => [
    uniqueIndex("task_attempts_task_number_unique").on(
      table.taskId,
      table.attemptNumber,
    ),
  ],
);

export const taskEvents = pgTable(
  "task_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => analysisTasks.id),
    eventType: varchar("event_type", { length: 100 }).notNull(),
    data: jsonb("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("task_events_task_created_idx").on(table.taskId, table.createdAt),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    topic: varchar("topic", { length: 100 }).notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    payload: jsonb("payload").notNull(),
    availableAt: timestamp("available_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("outbox_events_publish_idx").on(table.publishedAt, table.availableAt),
  ],
);

export const providerAccounts = pgTable(
  "provider_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: varchar("provider", { length: 100 }).notNull(),
    name: text("name").notNull(),
    encryptedCredential: text("encrypted_credential").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("provider_accounts_provider_name_unique").on(
      table.provider,
      table.name,
    ),
  ],
);

export const modelRolePolicies = pgTable(
  "model_role_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    role: varchar("role", { length: 100 }).notNull(),
    version: text("version").notNull(),
    candidates: jsonb("candidates").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("model_role_policies_role_version_unique").on(
      table.role,
      table.version,
    ),
  ],
);

export const externalPublications = pgTable(
  "external_publications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => analysisTasks.id),
    idempotencyKey: text("idempotency_key").notNull(),
    externalObjectId: text("external_object_id"),
    channel: varchar("channel", { length: 50 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("external_publications_idempotency_unique").on(
      table.idempotencyKey,
    ),
  ],
);

/**
 * Normalized issue documents for duplicate recall. `title`/`body` are the
 * canonical (template-cleaned) text used by the full-text search index; the
 * `*Signals` arrays are the structured error/version/module/language features
 * used by the signal-overlap recall. `embedding` holds the 4096-d vector
 * (nvidia/nv-embed-v1) for vector similarity recall.
 */
export const issueDocuments = pgTable(
  "issue_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    repositoryId: uuid("repository_id").references(() => repositories.id),
    issueNumber: integer("issue_number").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    versions: text("versions").array().notNull().default([]),
    errorCodes: text("error_codes").array().notNull().default([]),
    paths: text("paths").array().notNull().default([]),
    languages: text("languages").array().notNull().default([]),
    hasStackTrace: boolean("has_stack_trace").default(false).notNull(),
    hasReproduction: boolean("has_reproduction").default(false).notNull(),
    embedding: pgVector1024("embedding"),
    /** sha256 of normalized text+signals; unchanged docs skip re-embedding. */
    contentHash: text("content_hash"),
    indexedAt: timestamp("indexed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("issue_documents_repo_issue_unique").on(
      table.repositoryId,
      table.issueNumber,
    ),
  ],
);

/** Persisted structured result of an issue analysis or PR review run. */
export const subjectResults = pgTable(
  "subject_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subjectType: varchar("subject_type", { length: 20 }).notNull(),
    subjectNumber: integer("subject_number").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    revision: text("revision").notNull(),
    taskId: uuid("task_id").references(() => analysisTasks.id),
    result: jsonb("result").notNull(),
    published: boolean("published").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("subject_results_task_unique").on(table.taskId),
    index("subject_results_type_number_idx").on(
      table.subjectType,
      table.subjectNumber,
      table.createdAt,
    ),
  ],
);

/**
 * Runtime-overridable settings that hot-apply without a process restart.
 * `value` is a plain string; an empty/absent row falls back to the env config
 * (WEBUI_API_TOKEN, GITHUB_WEBHOOK_SECRET, LOG_LEVEL). Updated via the API.
 */
export const systemSettings = pgTable(
  "system_settings",
  {
    key: text("key").primaryKey(),
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("system_settings_key_idx").on(table.key)],
);

/**
 * Label rules map an analysis field value (e.g. `severity:S1`) to a GitHub
 * label name that the worker applies to an issue after a completed analysis.
 */
export const labelRules = pgTable(
  "label_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("label_rules_key_unique").on(table.key)],
);

/**
 * Users recognized through GitHub OAuth login. Kept lightweight: a login plus
 * an optional display name for the personal settings page; multi-account role
 * management can build on this table later.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    login: text("login").notNull(),
    displayName: text("display_name").default("").notNull(),
    isAdmin: boolean("is_admin").default(false).notNull(),
    /** 只读操作员：可登录查看，禁止一切写操作（OAuth 用户）。 */
    isReadOnly: boolean("is_read_only").default(false).notNull(),
    /** 本地账号密码哈希（argon2id）；null = 非本地账号（纯 OAuth）。 */
    passwordHash: text("password_hash"),
    /** TOTP 密钥；方向三 2FA 启用后使用。 */
    totpSecret: text("totp_secret"),
    totpEnabled: boolean("totp_enabled").default(false).notNull(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("users_login_unique").on(table.login)],
);

/**
 * 统一会话表：本地密码登录与 GitHub OAuth 登录都落一条会话。token 本身以
 * sha256 hash 存储（不落明文），支持过期、吊销与并发查询。
 */
export const userSessions = pgTable(
  "user_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userLogin: text("user_login")
      .notNull()
      .references(() => users.login, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    /** 来源：'password' | 'github'。 */
    authMethod: text("auth_method").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    userAgent: text("user_agent"),
    ip: text("ip"),
  },
  (table) => [
    uniqueIndex("user_sessions_token_hash_unique").on(table.tokenHash),
    index("user_sessions_user_revoked_idx").on(
      table.userLogin,
      table.revokedAt,
    ),
  ],
);

/**
 * 仓库可见性授权（方向七）：用户 - 仓库 映射。access 为 'view'（只读可看）或
 * 'manage'（可管设置/触发分析）。删除用户/仓库时级联清理授权。
 */
export const repositoryGrants = pgTable(
  "repository_grants",
  {
    userLogin: text("user_login")
      .notNull()
      .references(() => users.login, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    /** 'view' | 'manage'。 */
    access: text("access").default("view").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userLogin, table.repositoryId] }),
    index("repository_grants_repo_idx").on(table.repositoryId),
  ],
);

/**
 * Security audit log: one row per sensitive admin/operator action (role
 * changes, backup import, setup init, settings update, index operations).
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actor: text("actor").default("").notNull(),
    action: text("action").notNull(),
    target: text("target"),
    detail: jsonb("detail").default({}).notNull(),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("audit_logs_created_idx").on(table.createdAt)],
);

/**
 * Repository memory. `kind` is one of `reflection` | `rule` | `knowledge`:
 * reflections are raw distilled outcomes from completed issue analyses / PR
 * reviews, later merged (consolidated=true) by the memory-consolidation agent
 * into durable `rule`/`knowledge` rows that are fed back into later contexts.
 */
export const repoMemory = pgTable(
  "repo_memory",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    repositoryId: uuid("repository_id").references(() => repositories.id),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    sourceType: text("source_type"),
    sourceRef: text("source_ref"),
    consolidated: boolean("consolidated").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("repo_memory_repo_kind_idx").on(table.repositoryId, table.kind),
    index("repo_memory_consolidated_idx").on(table.consolidated),
  ],
);

/**
 * Per-repository scan configuration. Rows are created on demand (defaults)
 * when a repository is scanned; the WebUI scan page edits these values.
 */
export const scanConfigs = pgTable(
  "scan_configs",
  {
    repositoryId: uuid("repository_id")
      .primaryKey()
      .references(() => repositories.id),
    enabled: boolean("enabled").default(true).notNull(),
    intervalMinutes: integer("interval_minutes").default(1440).notNull(),
    maxIssues: integer("max_issues").default(50).notNull(),
    maxPrs: integer("max_prs").default(20).notNull(),
    autoAnalyzeIssues: boolean("auto_analyze_issues").default(true).notNull(),
    autoAnalyzePrs: boolean("auto_analyze_prs").default(true).notNull(),
    createTrackingIssues: boolean("create_tracking_issues")
      .default(false)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
);

/**
 * One scan execution per repository: what was seen and what was enqueued.
 * Drives the WebUI scan history list and the per-repo interval gating.
 */
export const scanRuns = pgTable(
  "scan_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    repositoryId: uuid("repository_id").references(() => repositories.id),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: varchar("status", { length: 20 }).default("running").notNull(),
    trigger: varchar("trigger", { length: 20 }).default("scheduled").notNull(),
    scannedIssues: integer("scanned_issues").default(0).notNull(),
    scannedPrs: integer("scanned_prs").default(0).notNull(),
    createdIssueTasks: integer("created_issue_tasks").default(0).notNull(),
    createdPrTasks: integer("created_pr_tasks").default(0).notNull(),
    createdTrackingIssues: integer("created_tracking_issues")
      .default(0)
      .notNull(),
    skipped: integer("skipped").default(0).notNull(),
    error: text("error"),
  },
  (table) => [
    index("scan_runs_repo_started_idx").on(table.repositoryId, table.startedAt),
  ],
);

/**
 * Records GitHub issues auto-created as tracking reports for scanned subjects
 * (e.g. a new open PR), so a subject is reported only once.
 */
export const scanTracking = pgTable(
  "scan_tracking",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    repositoryId: uuid("repository_id").references(() => repositories.id),
    subjectType: varchar("subject_type", { length: 10 }).notNull(),
    subjectNumber: integer("subject_number").notNull(),
    trackingIssueNumber: integer("tracking_issue_number").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("scan_tracking_repo_subject_unique").on(
      table.repositoryId,
      table.subjectType,
      table.subjectNumber,
    ),
  ],
);

/**
 * 仓库级设置覆盖。语义与 `system_settings` 一致：这里有行就覆盖全局值，没有行
 * 就回落到全局设置（再回落到应用默认）。所以不为任何仓库预填记录 —— 没动过的
 * 仓库自动跟随全局。
 *
 * 只接受「与单个仓库相关」的键（由 API 白名单约束）：标题改写、自动指派、深度
 * 分析、重新分析阈值。日志级别、访问令牌、OAuth 这类全局项不得按仓库覆盖。
 */
export const repositorySettings = pgTable(
  "repository_settings",
  {
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.repositoryId, table.key] }),
    index("repository_settings_repo_idx").on(table.repositoryId),
  ],
);
