/**
 * 仓库级归档、预览和恢复；备份中没有其它仓库的数据或运行凭据。
 * @example const archive = exportArchive(context); previewArchive(context,{archive});
 * restoreArchive(context,{archive,confirmChecksum:archive.checksum});
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { audit, type CommandContext } from "./audit.js";
import { validateBatchDependencies } from "./batch.js";
import type {
  ArchivePreview,
  WorkbenchArchive,
  WorkbenchArchiveData,
} from "./types.js";
import { WORKBENCH_DATA_COLLECTIONS } from "./types.js";
import { text, WorkbenchError } from "./utils/input.js";
import { canonicalJson } from "./utils/json.js";

const collections = WORKBENCH_DATA_COLLECTIONS;
type Collection = (typeof collections)[number];
const boundedText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !value.includes("\0"), "不能包含空字符");
const requiredText = (max: number) =>
  boundedText(max).refine((value) => value.trim().length > 0, "不能为空白");
const identifier = requiredText(100);
const integer = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER / 4);
const instant = z.string().datetime();
const severity = z.enum(["critical", "high", "medium", "low", "info"]);
const repository = z.string().regex(/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9_.-]+$/);
const identity = {
  id: identifier,
  repository,
  createdAt: instant,
  updatedAt: instant,
  createdBy: requiredText(200),
  revision: integer.min(1),
};
const usage = z
  .object({
    amountMicros: integer,
    inputTokens: integer,
    outputTokens: integer,
    requests: integer,
  })
  .strict();
const rules = z
  .object({
    blockedSeverities: z.array(severity).max(5),
    maxNewFindings: integer.max(100_000),
    minConfidence: z.number().min(0).max(1),
    requireBaseline: z.boolean(),
    requireHumanApproval: z.boolean(),
    includePaths: z.array(boundedText(500)).max(100),
    excludePaths: z.array(boundedText(500)).max(100),
    labels: z.array(boundedText(100)).max(50),
  })
  .strict();
const baselineFinding = z
  .object({
    fingerprint: requiredText(200),
    ruleId: requiredText(200),
    path: requiredText(1000),
    line: integer.min(1),
    severity,
    title: requiredText(500),
  })
  .strict();
const policy = z
  .object({
    ...identity,
    name: requiredText(200),
    description: boundedText(3000),
    enabled: z.boolean(),
    activeVersion: integer.min(1),
    versions: z
      .array(
        z
          .object({
            version: integer.min(1),
            name: requiredText(200),
            description: boundedText(3000),
            rules,
            savedAt: instant,
            savedBy: requiredText(200),
            note: boundedText(2000),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();
const baseline = z
  .object({
    ...identity,
    name: requiredText(200),
    reference: requiredText(500),
    active: z.boolean(),
    archived: z.boolean(),
    findings: z.array(baselineFinding).max(20_000),
    note: boundedText(3000),
  })
  .strict();
const finding = z
  .object({
    ...identity,
    fingerprint: requiredText(200),
    ruleId: requiredText(200),
    title: requiredText(500),
    description: boundedText(20_000),
    path: requiredText(1000),
    line: integer.min(1),
    endLine: integer.min(1),
    severity,
    confidence: z.number().min(0).max(1),
    status: z.enum([
      "open",
      "acknowledged",
      "fixed",
      "false_positive",
      "accepted_risk",
    ]),
    assignee: boundedText(200),
    source: boundedText(200),
    reference: boundedText(500),
    tags: z.array(boundedText(100)).max(50),
    occurrences: integer.min(1),
    lastSeenAt: instant,
    history: z
      .array(
        z
          .object({
            at: instant,
            actor: requiredText(200),
            action: requiredText(100),
            from: boundedText(500),
            to: boundedText(500),
            reason: boundedText(3000),
          })
          .strict(),
      )
      .min(1)
      .max(20_000),
  })
  .strict();
const suppression = z
  .object({
    ...identity,
    name: requiredText(200),
    reason: requiredText(3000),
    enabled: z.boolean(),
    fingerprint: boundedText(200),
    ruleId: boundedText(200),
    pathPattern: boundedText(500),
    severities: z.array(severity).max(5),
    expiresAt: instant.nullable(),
  })
  .strict();
const batch = z
  .object({
    ...identity,
    name: requiredText(200),
    status: z.enum([
      "draft",
      "queued",
      "running",
      "paused",
      "completed",
      "canceled",
    ]),
    concurrency: integer.min(1).max(100),
    note: boundedText(3000),
    items: z
      .array(
        z
          .object({
            id: identifier,
            subject: requiredText(200),
            reference: requiredText(500),
            dependencies: z.array(identifier).max(1000),
            status: z.enum([
              "pending",
              "running",
              "completed",
              "failed",
              "canceled",
            ]),
            attempts: integer.max(20),
            generation: integer.optional(),
            maxAttempts: integer.min(1).max(20),
            worker: boundedText(200),
            leaseUntil: instant.nullable(),
            startedAt: instant.nullable(),
            completedAt: instant.nullable(),
            error: boundedText(3000),
            result: z.record(z.string(), z.unknown()).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();
const feedback = z
  .object({
    ...identity,
    findingId: identifier,
    verdict: z.enum(["useful", "false_positive", "missed_issue", "unclear"]),
    comment: requiredText(5000),
    resolved: z.boolean(),
    resolution: boundedText(5000),
    resolvedBy: boundedText(200),
    resolvedAt: instant.nullable(),
  })
  .strict();
const budget = z
  .object({
    ...identity,
    name: requiredText(200),
    periodStart: instant,
    periodEnd: instant,
    currency: z.literal("USD"),
    enabled: z.boolean(),
    limits: usage,
    usage,
  })
  .strict();
const reservation = z
  .object({
    ...identity,
    budgetId: identifier,
    key: requiredText(300),
    status: z.enum(["reserved", "settled", "released"]),
    estimate: usage,
    actual: usage.nullable(),
    expiresAt: instant,
  })
  .strict();
const evaluation = z
  .object({
    ...identity,
    name: requiredText(200),
    model: requiredText(300),
    reference: boundedText(500),
    note: boundedText(3000),
    cases: z
      .array(
        z
          .object({
            id: identifier,
            name: requiredText(300),
            expected: z.array(boundedText(300)).max(1000),
            observed: z.array(boundedText(300)).max(1000),
            weight: z.number().positive().max(1000),
          })
          .strict(),
      )
      .min(1)
      .max(5000),
  })
  .strict();
const gate = z
  .object({
    repository,
    decision: z.enum(["pass", "warn", "fail"]),
    policyId: identifier.nullable(),
    policyVersion: integer.min(1).nullable(),
    baselineId: identifier.nullable(),
    evaluatedAt: instant,
    checks: z
      .array(
        z
          .object({
            name: requiredText(100),
            decision: z.enum(["pass", "warn", "fail"]),
            message: boundedText(3000),
            findingIds: z.array(identifier).max(20_000),
          })
          .strict(),
      )
      .max(100),
    counts: z
      .object({
        total: integer,
        new: integer,
        existing: integer,
        suppressed: integer,
        resolved: integer,
      })
      .strict(),
  })
  .strict();
const review = z
  .object({
    id: identifier,
    repository,
    key: requiredText(1000),
    source: requiredText(200),
    sourceSequence: z
      .string()
      .regex(/^[1-9]\d{0,49}$/)
      .optional(),
    reference: requiredText(500),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    receivedAt: instant,
    findingIds: z.array(identifier).max(20_000),
    imported: integer,
    resolved: integer,
    gate,
  })
  .strict();
const auditRecord = z
  .object({
    id: identifier,
    repository,
    actor: requiredText(200),
    action: requiredText(100),
    target: boundedText(1000),
    at: instant,
    details: z.record(z.string(), z.unknown()),
    previousHash: boundedText(64),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const archiveSchema = z
  .object({
    format: z.literal("apertureprism-workbench-archive"),
    version: z.literal(1),
    repository,
    createdAt: instant,
    sourceRevision: integer,
    data: z
      .object({
        policies: z.array(policy),
        baselines: z.array(baseline),
        findings: z.array(finding),
        suppressions: z.array(suppression),
        batches: z.array(batch),
        feedback: z.array(feedback),
        budgets: z.array(budget),
        reservations: z.array(reservation),
        evaluations: z.array(evaluation),
        reviews: z.array(review),
        audit: z.array(auditRecord),
      })
      .strict(),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

function checksum(value: Omit<WorkbenchArchive, "checksum">): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function counts(data: WorkbenchArchiveData): Record<Collection, number> {
  return Object.fromEntries(
    collections.map((name) => [name, data[name].length]),
  ) as Record<Collection, number>;
}

/** 导出只做读取；归档校验值表示内容完整性，不表示来源经过数字签名。 */
export function exportArchive(context: CommandContext): WorkbenchArchive {
  const data = Object.fromEntries(
    collections.map((name) => [
      name,
      context.data[name].filter(
        (item) => item.repository === context.repository,
      ),
    ]),
  ) as unknown as WorkbenchArchiveData;
  const content = {
    format: "apertureprism-workbench-archive" as const,
    version: 1 as const,
    repository: context.repository,
    createdAt: context.now,
    sourceRevision: context.data.revision,
    data,
  };
  return { ...content, checksum: checksum(content) };
}

/** 导入先验结构、仓库归属、唯一键和外键，再允许业务状态替换。 */
function parseArchive(
  context: CommandContext,
  value: unknown,
): WorkbenchArchive {
  const content = canonicalJson(value);
  if (Buffer.byteLength(content) > 32 * 1024 * 1024)
    throw new WorkbenchError("archive_too_large", "归档超过 32 MiB");
  const parsed = archiveSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new WorkbenchError(
      "invalid_archive",
      `归档字段 ${issue.path.join(".")} 无效：${issue.message}`,
    );
  }
  const archive = parsed.data as WorkbenchArchive;
  if (archive.repository !== context.repository)
    throw new WorkbenchError("archive_repository", "归档仓库与当前仓库不一致");
  const { checksum: supplied, ...body } = archive;
  if (checksum(body) !== supplied)
    throw new WorkbenchError(
      "archive_checksum",
      "归档内容校验失败，文件可能被修改",
    );
  for (const name of collections) {
    const ids = new Set<string>();
    for (const record of archive.data[name]) {
      if (record.repository !== context.repository)
        throw new WorkbenchError("archive_repository", "归档混入其它仓库记录");
      if (ids.has(record.id))
        throw new WorkbenchError("archive_duplicate", `${name} 中存在重复 id`);
      ids.add(record.id);
    }
  }
  const unique = (keys: string[], label: string): void => {
    if (new Set(keys).size !== keys.length)
      throw new WorkbenchError("archive_duplicate", `归档 ${label} 不唯一`);
  };
  unique(
    archive.data.findings.map((item) => item.fingerprint),
    "发现指纹",
  );
  unique(
    archive.data.reviews.map((item) => item.key),
    "审查交付键",
  );
  unique(
    archive.data.reservations.map((item) =>
      JSON.stringify([item.budgetId, item.key]),
    ),
    "预算预留键",
  );
  const findingIds = new Set(archive.data.findings.map((item) => item.id));
  const budgetIds = new Set(archive.data.budgets.map((item) => item.id));
  for (const item of archive.data.feedback) {
    if (!findingIds.has(item.findingId))
      throw new WorkbenchError("archive_reference", "反馈引用了不存在的发现");
  }
  for (const item of archive.data.reservations) {
    if (!budgetIds.has(item.budgetId))
      throw new WorkbenchError("archive_reference", "预留引用了不存在的预算");
    if (item.status === "settled" && item.actual === null)
      throw new WorkbenchError("archive_reference", "已结算预留缺少实际用量");
  }
  for (const item of archive.data.reviews) {
    if (
      item.findingIds.some((id) => !findingIds.has(id)) ||
      item.gate.repository !== context.repository
    )
      throw new WorkbenchError("archive_reference", "审查交付引用不完整");
  }
  for (const item of archive.data.policies) {
    if (
      !item.versions.some(
        (version) => version.version === item.activeVersion,
      ) ||
      item.versions.some((version, index) => version.version !== index + 1)
    )
      throw new WorkbenchError("archive_policy", "策略版本序列不完整");
  }
  if (
    archive.data.baselines.filter((item) => item.active).length > 1 ||
    archive.data.baselines.some((item) => item.active && item.archived)
  )
    throw new WorkbenchError("archive_baseline", "活动基线状态冲突");
  for (const item of archive.data.findings) {
    if (
      item.endLine < item.line ||
      item.path.startsWith("/") ||
      item.path.split("/").includes("..")
    )
      throw new WorkbenchError("archive_finding", "发现源码位置无效");
  }
  for (const item of archive.data.suppressions) {
    if (!item.fingerprint && !item.ruleId && !item.pathPattern)
      throw new WorkbenchError("archive_suppression", "归档含有无条件忽略规则");
  }
  for (const item of archive.data.batches)
    validateBatchDependencies(item.items);
  for (const item of archive.data.budgets) {
    if (item.periodStart >= item.periodEnd)
      throw new WorkbenchError("archive_budget", "预算周期无效");
    if (
      Object.keys(item.limits).some(
        (dimension) =>
          item.usage[dimension as keyof typeof item.usage] >
          item.limits[dimension as keyof typeof item.limits],
      )
    )
      throw new WorkbenchError("archive_budget", "预算已用量超过额度");
  }
  return archive;
}

export function previewArchive(
  context: CommandContext,
  input: Record<string, unknown>,
): ArchivePreview {
  const archive = parseArchive(context, input.archive);
  const current = Object.fromEntries(
    collections.map((name) => [
      name,
      context.data[name].filter(
        (item) => item.repository === context.repository,
      ),
    ]),
  ) as unknown as WorkbenchArchiveData;
  const running = archive.data.batches
    .flatMap((batch) => batch.items)
    .filter((item) => item.status === "running").length;
  const reservations = archive.data.reservations.filter(
    (item) => item.status === "reserved",
  ).length;
  const warnings = [
    "恢复会替换当前仓库的业务记录，请先导出当前状态。",
    "备份的审计仅作为原始证据保留，不会冒充本实例里新发生的操作。",
  ];
  if (running)
    warnings.push(`${running} 个运行项将回到等待状态，执行租约会被清空。`);
  if (reservations)
    warnings.push(
      `${reservations} 个未结算预算预留会释放，已结算费用保持原样。`,
    );
  return {
    repository: context.repository,
    createdAt: archive.createdAt,
    checksum: archive.checksum,
    counts: counts(archive.data),
    currentCounts: counts(current),
    warnings,
    canRestore: context.actor.isAdmin,
  };
}

/** 仅管理员可执行，且必须回传预览校验值，避免把“预览”误当“恢复”。 */
export function restoreArchive(
  context: CommandContext,
  input: Record<string, unknown>,
): {
  repository: string;
  restoredAt: string;
  checksum: string;
  counts: Record<Collection, number>;
} {
  if (!context.actor.isAdmin)
    throw new WorkbenchError("admin_required", "恢复归档需要管理员权限", 403);
  const archive = parseArchive(context, input.archive);
  if (text(input.confirmChecksum, "confirmChecksum", 64) !== archive.checksum)
    throw new WorkbenchError(
      "archive_confirmation",
      "确认校验值与预览归档不一致",
      409,
    );
  for (const name of collections) {
    const otherIds = new Set(
      context.data[name]
        .filter((item) => item.repository !== context.repository)
        .map((item) => item.id),
    );
    if (archive.data[name].some((item) => otherIds.has(item.id)))
      throw new WorkbenchError(
        "archive_collision",
        "归档 id 与其它仓库发生冲突",
        409,
      );
  }
  for (const item of archive.data.batches) {
    for (const job of item.items) {
      if (job.status !== "running") continue;
      job.status = "pending";
      job.attempts = Math.max(0, job.attempts - 1);
      job.worker = "";
      job.leaseUntil = null;
      job.error = "从归档恢复，等待工作进程回接";
    }
    if (item.status === "running") item.status = "queued";
  }
  for (const item of archive.data.reservations)
    if (item.status === "reserved") item.status = "released";
  // 审计不替换，其它集合按仓库替换，且对已存在主体提高版本以使旧表单失效。
  for (const name of collections) {
    if (name === "audit") continue;
    const oldRevisions = new Map(
      context.data[name].map((record) => [
        record.id,
        "revision" in record ? record.revision : 0,
      ]),
    );
    for (const record of archive.data[name]) {
      if ("revision" in record) {
        record.revision =
          Math.max(oldRevisions.get(record.id) ?? 0, record.revision) + 1;
        record.updatedAt = context.now;
      }
    }
    // 各集合已用各自的 schema 校验，动态位置只负责把它放回相同集合。
    (context.data[name] as unknown[]) = [
      ...context.data[name].filter(
        (item) => item.repository !== context.repository,
      ),
      ...archive.data[name],
    ];
  }
  audit(context, "archive.restored", archive.checksum, {
    sourceRevision: archive.sourceRevision,
    counts: counts(archive.data),
    originalAuditRecords: archive.data.audit.length,
  });
  return {
    repository: context.repository,
    restoredAt: context.now,
    checksum: archive.checksum,
    counts: counts(archive.data),
  };
}
