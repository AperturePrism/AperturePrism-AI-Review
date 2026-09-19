export type TaskStatus =
  | "queued"
  | "leased"
  | "running"
  | "publishing"
  | "completed"
  | "retry_wait"
  | "failed"
  | "canceled";

export type TaskType = "issue_analysis" | "pr_review" | "repository_index";

export type AnalysisTask = {
  id: string;
  taskType: TaskType;
  status: TaskStatus;
  dedupeKey: string;
};

export type CreateTaskInput = {
  taskType: TaskType;
  repositoryId?: string;
  subjectNumber?: number;
  subjectRevision: string;
  policyVersion: string;
  dedupeKey: string;
  priority?: number;
  payload: unknown;
  maxAttempts?: number;
};

export type TaskCreationResult = {
  outcome: "created" | "duplicate";
  task: AnalysisTask;
};

export const taskCreatedEventType = "task.created" as const;
export const taskLeasedEventType = "task.leased" as const;
export const taskHeartbeatEventType = "task.heartbeat" as const;
export const taskLeaseRecoveredEventType = "task.lease_recovered" as const;
export const taskStartedEventType = "task.started" as const;
export const taskCompletedEventType = "task.completed" as const;
export const taskRetryScheduledEventType = "task.retry_scheduled" as const;
export const taskRetryReadyEventType = "task.retry_ready" as const;
export const taskFailedEventType = "task.failed" as const;
export const taskPublishingEventType = "task.publishing" as const;
export const taskCanceledEventType = "task.canceled" as const;
export const taskAnalysisUsageEventType = "task.analysis_usage" as const;

export type ClaimTaskInput = {
  workerId: string;
  leaseDurationMs: number;
  now?: Date;
};

export type LeasedTask = AnalysisTask & {
  leaseOwner: string;
  leaseExpiresAt: Date;
  heartbeatAt: Date;
  attemptNumber: number;
  /** Raw task payload carried through the lease so workers know the subject. */
  payload: unknown;
};

export type HeartbeatTaskInput = {
  taskId: string;
  workerId: string;
  leaseDurationMs: number;
  now?: Date;
};

export type RecoverExpiredLeasesInput = {
  now?: Date;
};

export type OwnedTaskInput = {
  taskId: string;
  workerId: string;
  now?: Date;
};

export type FailTaskInput = OwnedTaskInput & {
  errorCategory: string;
  retryDelayMs: number;
  /**
   * 面向排查的错误摘要，会写入 task_events。调用方负责截断，且只能包含异常
   * 消息与类型，禁止携带 prompt、仓库源码或任何凭据。
   */
  errorMessage?: string;
};

export type FailureResult = {
  status: "retry_wait" | "failed";
  nextAttemptAt: Date | null;
};

export type CancelTaskInput = {
  taskId: string;
  reason: string;
  now?: Date;
};

export type ModelRole =
  | "issue_analysis"
  | "pr_review"
  | "duplicate_judgment"
  | "memory_consolidation";

export type ModelMessageRole = "system" | "user" | "assistant" | "tool";

/** OpenAI 风格的图片内容块（image_url，可传 http(s) 或 data URL）。 */
export type ModelImagePart = {
  type: "image_url";
  image_url: { url: string };
};

/** 工具参数 JSON Schema（简化子集：type + properties + required）。 */
export type ToolParameterSchema = {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
};

/** 暴露给模型的工具定义（OpenAI tools 语义）。 */
export type ModelToolSpec = {
  name: string;
  description: string;
  parameters?: ToolParameterSchema;
};

/** 模型发起的工具调用（assistant 消息携带）。 */
export type ModelToolCall = {
  id: string;
  name: string;
  /** 参数，JSON 字符串。 */
  arguments: string;
};

export type ModelMessage = {
  role: ModelMessageRole;
  content: string;
  /**
   * 可选：随该条消息一起发给模型的多模态图片块（OpenAI image_url 语义）。
   * 为保持既有按字符串消费 content 的调用方不受影响，图片放在独立字段，
   * 由适配器在序列化时与 content 拼成数组；content 本身仍是纯文本。
   */
  imageParts?: readonly ModelImagePart[];
  /** role === "tool" 时回填对应的工具调用 id。 */
  toolCallId?: string;
  /** role === "assistant" 时模型请求的工具调用列表。 */
  toolCalls?: readonly ModelToolCall[];
};

export type ModelInvocationRequest = {
  messages: readonly ModelMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  responseFormat?: "text" | "json";
  /** 可选：为模型暴露可调用的工具。 */
  tools?: readonly ModelToolSpec[];
  /**
   * 工具选择策略。缺省时若带 tools 则发送 `tool_choice: "auto"`：
   * 部分网关（如 MiniMax 渠道）对带有 tools 却缺失 tool_choice 的请求
   * 返回 `invalid tool type (2013)` 400（issue #71/#73）。
   */
  toolChoice?: "auto" | "none" | "required";
};

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type ModelInvocationResponse = {
  content: string;
  usage: ModelUsage;
  /** 模型请求调用工具（content 可能为空字符串）。 */
  toolCalls?: readonly ModelToolCall[];
};

export const modelErrorCategories = [
  "connection_failed",
  "rate_limited",
  "server_error",
  "timeout",
  "authentication_failed",
  "model_not_found",
  "context_overflow",
  "invalid_output",
  "canceled",
  "unknown",
] as const;

export type ModelErrorCategory = (typeof modelErrorCategories)[number];

/**
 * Categories that indicate the candidate itself is unusable, so retrying the
 * same candidate cannot succeed. The router must move to the next candidate.
 */
export const nonRetryableModelErrorCategories: readonly ModelErrorCategory[] = [
  "authentication_failed",
  "model_not_found",
  "context_overflow",
  "canceled",
];

export class ModelInvocationError extends Error {
  readonly category: ModelErrorCategory;
  readonly retryAfterMs: number | undefined;

  constructor(
    category: ModelErrorCategory,
    message: string,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ModelInvocationError";
    this.category = category;
    this.retryAfterMs = retryAfterMs;
  }
}

export type ModelCandidate = {
  provider: string;
  model: string;
  accountName: string;
};

export type ModelRolePolicy = {
  role: ModelRole;
  version: string;
  candidates: readonly ModelCandidate[];
};

/**
 * Provider adapters only translate requests, responses, and errors. They never
 * decide whether to retry or switch candidates.
 */
export type ModelProviderAdapter = {
  provider: string;
  invoke: (
    candidate: ModelCandidate,
    request: ModelInvocationRequest,
    signal: AbortSignal,
  ) => Promise<ModelInvocationResponse>;
};

export type ModelAttemptOutcome = {
  candidate: ModelCandidate;
  startedAt: Date;
  finishedAt: Date;
  usage: ModelUsage | null;
  errorCategory: ModelErrorCategory | null;
};

export type ModelRoutingResult = {
  response: ModelInvocationResponse;
  candidate: ModelCandidate;
  attempts: readonly ModelAttemptOutcome[];
};

/* ---------- 提示词注入防护：不可信输入定界 ---------- */

/** 不可信输入的定界符。Issue/PR 正文、评论、diff、仓库记忆都来自外部。 */
export const UNTRUSTED_OPEN = "<<<UNTRUSTED_INPUT";
export const UNTRUSTED_CLOSE = "UNTRUSTED_INPUT>>>";

/**
 * 把不可信文本包进定界块（提示词注入防护）。任何人可以在正文里写「忽略以上
 * 指令」之类的内容试图操纵模型，因此必须与系统指令明确隔离；文本内伪造的
 * 定界符要被中和，防止提前闭合逃逸让后续内容看起来像系统指令。
 */
export function fenceUntrusted(text: string): string {
  const neutralized = text
    .split(UNTRUSTED_CLOSE)
    .join("UNTRUSTED_INPUT>·>>")
    .split(UNTRUSTED_OPEN)
    .join("<<·<UNTRUSTED_INPUT");
  return `${UNTRUSTED_OPEN}\n${neutralized}\n${UNTRUSTED_CLOSE}`;
}
