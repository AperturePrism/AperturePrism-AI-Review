/**
 * 审查自动化的公开契约：事件、可解释条件、持久运行与有界动作。
 * 调用：createAutomation(options).execute(actor, {action:'events.dispatch',input:{repository,event}})。
 */
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type ObjectValue = { [key: string]: Json };
export type AutomationActor = {
  userId: string;
  isAdmin: boolean;
  isReadOnly?: boolean;
  canAccessRepository: (
    repository: string,
    write: boolean,
  ) => boolean | Promise<boolean>;
};
export type ReviewEvent = {
  id: string;
  type: string;
  repository: string;
  occurredAt: string;
  subject?: { kind: "pr" | "issue"; number: number; labels?: string[] };
  gate?: "pass" | "warn" | "fail";
  risk?: "info" | "low" | "medium" | "high" | "critical";
  findings?: {
    total: number;
    new?: number;
    critical?: number;
    high?: number;
    medium?: number;
    low?: number;
    info?: number;
  };
  data?: ObjectValue;
  trace?: { depth: number; ruleIds: string[] };
};
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | {
      field: string;
      op:
        | "eq"
        | "neq"
        | "in"
        | "contains"
        | "gt"
        | "gte"
        | "lt"
        | "lte"
        | "exists"
        | "glob";
      value?: Json;
    };
export type ConditionExplanation = {
  passed: boolean;
  description: string;
  field?: string;
  actual?: Json;
  expected?: Json;
  children?: ConditionExplanation[];
};
export type ActiveWindow = {
  days: number[];
  start: string;
  end: string;
  utcOffsetMinutes: number;
};
export type ActionPlan = {
  kind: string;
  input: ObjectValue;
  costUnits: number;
  maxAttempts: number;
};
export type AutomationRule = {
  id: string;
  repository: string;
  name: string;
  description: string;
  enabled: boolean;
  version: number;
  condition: Condition;
  actions: ActionPlan[];
  window: ActiveWindow | null;
  rate: { limit: number; windowSeconds: number };
  budget: { maxActions: number; maxCostUnits: number; maxDurationMs: number };
  createdAt: string;
  updatedAt: string;
  createdBy: string;
};
export type StepState =
  "pending" | "running" | "waiting" | "completed" | "failed";
export type RunState =
  | "queued"
  | "running"
  | "waiting"
  | "retry_wait"
  | "completed"
  | "failed"
  | "canceled";
export type RunStep = {
  id: string;
  kind: string;
  input: ObjectValue;
  costUnits: number;
  maxAttempts: number;
  attempts: number;
  state: StepState;
  idempotencyKey: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  output: Json;
};
export type AutomationRun = {
  id: string;
  repository: string;
  ruleId: string;
  ruleVersion: number;
  ruleName: string;
  eventId: string;
  event: ReviewEvent;
  state: RunState;
  explanation: ConditionExplanation;
  steps: RunStep[];
  budget: AutomationRule["budget"];
  costUsed: number;
  durationMs: number;
  nextAttemptAt: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
};
export type Approval = {
  id: string;
  repository: string;
  runId: string;
  stepId: string;
  title: string;
  reason: string;
  state: "pending" | "approved" | "rejected";
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string;
  requireDifferentActor: boolean;
  createdAt: string;
};
export type AutomationArtifact = {
  id: string;
  repository: string;
  runId: string;
  stepId: string;
  format: string;
  content: string;
  mediaType: string;
  createdAt: string;
};
export type AutomationAudit = {
  id: string;
  repository: string;
  actor: string;
  action: string;
  target: string;
  detail: ObjectValue;
  at: string;
};
export type StoredEvent = {
  repository: string;
  id: string;
  hash: string;
  event: ReviewEvent;
  runIds: string[];
  skipped: {
    ruleId: string;
    reason: string;
    explanation: ConditionExplanation;
  }[];
  receivedAt: string;
};
export type AutomationSnapshot = {
  format: "apertureprism-review-automation";
  version: 1;
  revision: number;
  rules: AutomationRule[];
  events: StoredEvent[];
  runs: AutomationRun[];
  approvals: Approval[];
  artifacts: AutomationArtifact[];
  audit: AutomationAudit[];
};
export type ActionContext = {
  repository: string;
  actor: AutomationActor;
  event: ReviewEvent;
  runId: string;
  stepId: string;
  idempotencyKey: string;
  input: ObjectValue;
  signal: AbortSignal;
};
/** 自定义动作必须使用 idempotencyKey 去重；崩溃恢复会重新调用未确认的动作。 */
export type AutomationAction = (context: ActionContext) => Json | Promise<Json>;
export type WorkbenchPort = {
  execute: (
    actor: AutomationActor,
    command: { action: string; input: Record<string, unknown> },
  ) => Promise<unknown>;
};
export type AutomationOptions = {
  dataDirectory: string;
  workbench?: WorkbenchPort;
  actions?: Readonly<Record<string, AutomationAction>>;
  now?: () => Date;
  lockTimeoutMs?: number;
  maxBytes?: number;
};
export type AutomationCommand = { action: string; input: unknown };
export type Automation = {
  execute: (
    actor: AutomationActor,
    command: AutomationCommand,
  ) => Promise<unknown>;
};

/** UI 直接读取宿主判断后的能力，不根据按钮或角色名称猜测仓库写权限。 */
export type AutomationSummary = {
  rules: number;
  enabledRules: number;
  runs: number;
  byState: Record<string, number>;
  pendingApprovals: number;
  supportedActions: string[];
  viewer: { userId: string; isAdmin: boolean; canWrite: boolean };
};
