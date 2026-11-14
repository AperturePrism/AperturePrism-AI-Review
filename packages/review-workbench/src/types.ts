/**
 * 审查工作台的公开数据契约；HTTP、CLI、网页从同一处读取字段。
 * @example
 * import type { Finding, WorkbenchSummary } from '@apertureprism/review-workbench/types';
 */

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type FindingStatus =
  "open" | "acknowledged" | "fixed" | "false_positive" | "accepted_risk";
export type BatchStatus =
  "draft" | "queued" | "running" | "paused" | "completed" | "canceled";
export type BatchItemStatus =
  "pending" | "running" | "completed" | "failed" | "canceled";
export type FeedbackVerdict =
  "useful" | "false_positive" | "missed_issue" | "unclear";
export type GateDecision = "pass" | "warn" | "fail";
export type ReportFormat = "json" | "markdown" | "csv" | "sarif";

export interface Actor {
  userId: string;
  isAdmin: boolean;
  /** 接入宿主现有仓库授权；写操作必须单独检查写权限。 */
  canAccessRepository: (
    repository: string,
    write: boolean,
  ) => Promise<boolean> | boolean;
}

export interface RecordIdentity {
  id: string;
  repository: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  revision: number;
}

export interface PolicyRules {
  blockedSeverities: Severity[];
  maxNewFindings: number;
  minConfidence: number;
  requireBaseline: boolean;
  requireHumanApproval: boolean;
  includePaths: string[];
  excludePaths: string[];
  labels: string[];
}

export interface PolicyVersion {
  version: number;
  name: string;
  description: string;
  rules: PolicyRules;
  savedAt: string;
  savedBy: string;
  note: string;
}

export interface Policy extends RecordIdentity {
  name: string;
  description: string;
  enabled: boolean;
  activeVersion: number;
  versions: PolicyVersion[];
}

export interface BaselineFinding {
  fingerprint: string;
  ruleId: string;
  path: string;
  line: number;
  severity: Severity;
  title: string;
}

export interface Baseline extends RecordIdentity {
  name: string;
  reference: string;
  active: boolean;
  archived: boolean;
  findings: BaselineFinding[];
  note: string;
}

export interface FindingChange {
  at: string;
  actor: string;
  action: string;
  from: string;
  to: string;
  reason: string;
}

export interface Finding extends RecordIdentity {
  fingerprint: string;
  ruleId: string;
  title: string;
  description: string;
  path: string;
  line: number;
  endLine: number;
  severity: Severity;
  confidence: number;
  status: FindingStatus;
  assignee: string;
  source: string;
  reference: string;
  tags: string[];
  occurrences: number;
  lastSeenAt: string;
  history: FindingChange[];
}

export interface Suppression extends RecordIdentity {
  name: string;
  reason: string;
  enabled: boolean;
  fingerprint: string;
  ruleId: string;
  pathPattern: string;
  severities: Severity[];
  expiresAt: string | null;
}

export interface BatchItem {
  id: string;
  subject: string;
  reference: string;
  dependencies: string[];
  status: BatchItemStatus;
  attempts: number;
  /** 用户明确重试时增加；租约恢复沿用同一代，避免重复创建真实任务。 */
  generation?: number;
  maxAttempts: number;
  worker: string;
  leaseUntil: string | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string;
  result: Record<string, unknown> | null;
}

export interface Batch extends RecordIdentity {
  name: string;
  status: BatchStatus;
  concurrency: number;
  items: BatchItem[];
  note: string;
  /** 同一仓库内重复提交相同键时返回已有批次，避免网络重试重复建批次。 */
  idempotencyKey?: string;
}

export interface Feedback extends RecordIdentity {
  findingId: string;
  verdict: FeedbackVerdict;
  comment: string;
  resolved: boolean;
  resolution: string;
  resolvedBy: string;
  resolvedAt: string | null;
}

export interface BudgetLimits {
  /** 使用整数微美元，避免浮点累加导致超额。 */
  amountMicros: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

export type BudgetUsage = BudgetLimits;

export interface Budget extends RecordIdentity {
  name: string;
  periodStart: string;
  periodEnd: string;
  currency: "USD";
  enabled: boolean;
  limits: BudgetLimits;
  usage: BudgetUsage;
}

export interface Reservation extends RecordIdentity {
  budgetId: string;
  key: string;
  status: "reserved" | "settled" | "released";
  estimate: BudgetUsage;
  actual: BudgetUsage | null;
  expiresAt: string;
}

export interface AuditRecord {
  id: string;
  repository: string;
  actor: string;
  action: string;
  target: string;
  at: string;
  details: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

export interface GateCheck {
  name: string;
  decision: GateDecision;
  message: string;
  findingIds: string[];
}

export interface GateResult {
  repository: string;
  decision: GateDecision;
  policyId: string | null;
  policyVersion: number | null;
  baselineId: string | null;
  checks: GateCheck[];
  counts: {
    total: number;
    new: number;
    existing: number;
    suppressed: number;
    resolved: number;
  };
  evaluatedAt: string;
}

export interface EvaluationCase {
  id: string;
  name: string;
  expected: string[];
  observed: string[];
  weight: number;
}

export interface Evaluation extends RecordIdentity {
  name: string;
  model: string;
  reference: string;
  cases: EvaluationCase[];
  note: string;
}

export interface EvaluationResult {
  evaluationId: string;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  precision: number;
  recall: number;
  f1: number;
  passedCases: number;
  totalCases: number;
  weightedScore: number;
  cases: {
    id: string;
    matched: string[];
    extra: string[];
    missed: string[];
    passed: boolean;
  }[];
}

export interface WorkbenchSummary {
  repository: string;
  policies: number;
  activePolicies: number;
  baselines: number;
  findings: number;
  openFindings: number;
  suppressedFindings: number;
  batches: number;
  runningBatches: number;
  pendingFeedback: number;
  budgetAmountMicros: number;
  spentAmountMicros: number;
  severity: Record<Severity, number>;
  gate: GateResult;
}

/** 公开集合名称的唯一来源，路由、分页和调用类型都从这里提取。 */
export const WORKBENCH_COLLECTIONS = [
  "policies",
  "baselines",
  "findings",
  "suppressions",
  "batches",
  "feedback",
  "budgets",
  "evaluations",
  "audit",
] as const;
export type WorkbenchCollection = (typeof WORKBENCH_COLLECTIONS)[number];

/** 交付账本和预留记录不提供直接HTTP任意编辑。 */
export const WORKBENCH_DATA_COLLECTIONS = [
  ...WORKBENCH_COLLECTIONS,
  "reservations",
  "reviews",
] as const;
export interface WorkbenchCommand {
  action: string;
  input: Record<string, unknown>;
}

export interface WorkbenchOptions {
  dataDirectory: string;
  now?: () => Date;
  lockTimeoutMs?: number;
  /** 限制整个快照大小，防止导入占满磁盘。默认 32 MiB。 */
  maxBytes?: number;
}

export interface Workbench {
  execute: (actor: Actor, command: WorkbenchCommand) => Promise<unknown>;
}

export interface WorkbenchSnapshot {
  format: "apertureprism-workbench";
  version: 1;
  revision: number;
  policies: Policy[];
  baselines: Baseline[];
  findings: Finding[];
  suppressions: Suppression[];
  batches: Batch[];
  feedback: Feedback[];
  budgets: Budget[];
  reservations: Reservation[];
  evaluations: Evaluation[];
  audit: AuditRecord[];
  reviews: ReviewDelivery[];
}

export interface ReviewDelivery {
  id: string;
  repository: string;
  key: string;
  source: string;
  /** 正整数字符串，不经过浮点数；用于拒绝旧任务晚到覆盖较新审查。 */
  sourceSequence?: string;
  reference: string;
  payloadHash: string;
  receivedAt: string;
  findingIds: string[];
  imported: number;
  resolved: number;
  gate: GateResult;
}

export interface ReportData {
  repository: string;
  generatedAt: string;
  summary: WorkbenchSummary;
  findings: Finding[];
  baselines: Baseline[];
  policies: Policy[];
  suppressions: Suppression[];
  feedback: Feedback[];
  budgets: Budget[];
  evaluations: (Evaluation & { result: EvaluationResult })[];
}

export interface ReportArtifact {
  format: string;
  mimeType: string;
  filename: string;
  content: string;
}

export interface ReportWriter {
  mimeType: string;
  extension: string;
  render: (data: ReportData) => string;
}

export interface WorkbenchArchiveData {
  policies: Policy[];
  baselines: Baseline[];
  findings: Finding[];
  suppressions: Suppression[];
  batches: Batch[];
  feedback: Feedback[];
  budgets: Budget[];
  reservations: Reservation[];
  evaluations: Evaluation[];
  reviews: ReviewDelivery[];
  /** 原始审计是备份证据；恢复时不会伪装成新实例里真实发生的操作。 */
  audit: AuditRecord[];
}

export interface WorkbenchArchive {
  format: "apertureprism-workbench-archive";
  version: 1;
  repository: string;
  createdAt: string;
  sourceRevision: number;
  data: WorkbenchArchiveData;
  checksum: string;
}

export interface ArchivePreview {
  repository: string;
  createdAt: string;
  checksum: string;
  counts: Record<keyof WorkbenchArchiveData, number>;
  currentCounts: Record<keyof WorkbenchArchiveData, number>;
  warnings: string[];
  canRestore: boolean;
}

export interface WorkbenchTrends {
  repository: string;
  since: string;
  until: string;
  daily: {
    date: string;
    reviews: number;
    imported: number;
    resolved: number;
    gatePass: number;
    gateWarn: number;
    gateFail: number;
  }[];
  rules: {
    ruleId: string;
    open: number;
    fixed: number;
    falsePositive: number;
    acceptedRisk: number;
    feedback: number;
    usefulFeedback: number;
    medianFixHours: number | null;
  }[];
  owners: {
    assignee: string;
    open: number;
    critical: number;
    high: number;
    oldestDays: number;
  }[];
  aging: {
    under7Days: number;
    days7To30: number;
    days30To90: number;
    over90Days: number;
  };
  totals: {
    reviews: number;
    imported: number;
    resolved: number;
    failRate: number;
    fixedFindings: number;
    reopenedFindings: number;
  };
}
