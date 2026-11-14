/**
 * Multi-expert review orchestration. Fans a rendered subject out to every
 * applicable expert (each produces its own JSON findings), then a lead model
 * merges the successful expert conclusions into the same strict PR review
 * contract used by `pr-review`, with one bounded repair when validation fails.
 * Pure logic is dependency-injected so it is fully testable without a network.
 */
import { z } from "zod";
import type {
  ModelAttemptOutcome,
  ModelCandidate,
  ModelInvocationRequest,
  ModelProviderAdapter,
  ModelUsage,
} from "../../../packages/domain/src/index.js";
import {
  ModelRoutingFailedError,
  routeModelInvocation,
  type RetryPolicy,
} from "../../../packages/model-router/src/index.js";
import type { PrReviewContract } from "../../../packages/pr-review/src/types.js";
import { parsePrReviewJson } from "../../../packages/pr-review/src/validate.js";
import { getExpertsFor, type Expert } from "./experts.js";
import {
  renderSkillPrompts,
  type Skill,
  type SkillAppliesTo,
} from "./skills.js";

/* ---------- expert output contract (intermediate, per-expert) ---------- */

export const expertFindingSchema = z
  .object({
    file: z.string().min(1).max(500).optional(),
    line: z.number().int().min(0).optional(),
    severity: z.enum(["error", "warning", "suggestion"]),
    message: z.string().min(1).max(2_000),
    why: z.string().min(1).max(2_000),
    evidence: z.string().min(1).max(2_000).optional(),
  })
  .strict();

export type ExpertFinding = z.infer<typeof expertFindingSchema>;

export const expertOutputSchema = z
  .object({
    summary: z.string().min(1).max(2_000),
    findings: z.array(expertFindingSchema).max(100).default([]),
  })
  .strict();

export type ExpertOutput = z.infer<typeof expertOutputSchema>;

export type ExpertJsonValidation =
  | { outcome: "valid"; output: ExpertOutput }
  | { outcome: "invalid"; issues: readonly string[] };

export function parseExpertJson(text: string): ExpertJsonValidation {
  try {
    const parsed = expertOutputSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      return {
        outcome: "invalid",
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.join(".") || "root"}: ${issue.message}`,
        ),
      };
    }
    return { outcome: "valid", output: parsed.data };
  } catch {
    return {
      outcome: "invalid",
      issues: ["root: response was not valid JSON"],
    };
  }
}

/* ---------- prompts ---------- */

const MEANINGLESS_CHANGE_POLICY = `无价值修改识别（issue #105）：
- 只有 diff 及已提供上下文能证明修改缺少预期功能或可维护性价值时，才明确报告无价值修改；例如可证实误提交的调试输出、无用临时代码或冗余改动，不要求完全没有可观察行为变化。证据必须逐字摘自 diff，并说明判断依据及删除或恢复建议。
- 不要把正常重构、可读性或可维护性改进、安全修复、有明确用途的日志、遵循格式化规范的纯格式修改当成无价值修改；不熟悉代码、与功能无关或仅改变格式都不足以证明无价值，证据不足则不报。
- 确凿的无价值修改不受“只保留高价值意见”限制；低置信的风格意见仍然不发。最终 finding 的 rule 必须为 meaningless-change，severity 必须为 low 或 info；如实评估 confidence，置信度门槛仍由校验器执行，不得为通过发布门槛抬高严重度或置信度。`;

const EXPERT_CONTRACT = `输出必须严格符合以下契约（JSON 对象，不要输出任何解释、Markdown 代码块或额外文字）：
{
  "summary": "不超过 800 字符的专业视角总结",
  "findings": [{
    "file": "新文件路径（不确定时省略该字段）",
    "line": 新文件行号（1 起，不确定时省略该字段）,
    "severity": "error | warning | suggestion",
    "message": "不超过 500 字符的简洁说明",
    "why": "不超过 500 字符的判断依据",
    "evidence": "来自 diff 的原文摘录（不确定时省略该字段）"
  }]
}

规则：
- 只针对 diff 中真实出现的代码，严禁编造缺陷；证据必须逐字摘自 diff。
- findings 最多 100 条，只保留高价值、可行动的审查意见。
- 如果该专业视角没有发现问题，findings 可为空数组。
- 你只输出你的独立判断，不要替其他专家做决定。

${MEANINGLESS_CHANGE_POLICY}
- 专家中间契约保持不变：这类发现用 severity: suggestion，在 message 中标明 meaningless-change，why 说明缺少预期功能或维护价值的依据，evidence 提供逐字摘录；由主编映射为最终 low/info finding。`;

const LEAD_CONTRACT = `输出必须严格符合以下契约（JSON 对象，不要输出任何解释、Markdown 代码块或额外文字）：
{
  "contractVersion": "pr-review/v1",
  "summary": "不超过 3000 字符的整体审查总结",
  "changedFileCount": 整数（变更文件数量,含二进制）,
  "additions": 整数（新增行数）,
  "deletions": 整数（删除行数）,
  "overallTone": "approve | changes_requested | comment",
  "findings": [{
    "rule": "稳定的规则标识，如 missing-null-check、sql-injection、missing-error-handling",
    "severity": "critical | high | medium | low | info",
    "file": "新文件路径，必须与 diff 中的路径一致",
    "message": "不超过 2000 字符的简洁说明",
    "evidence": "来自 diff 的原文摘录，必须真实存在，严禁编造",
    "impact": "不超过 2000 字符的影响说明",
    "confidence": 0-1 之间的置信度,
    "suggestion": "不超过 2000 字符的修复建议",
    "afterLine": 该问题锚定的新文件行号（1 起），不确定时写 0
  }]
}

规则：
- 合并并去重各专家的结论，只保留高价值、可行动的审查意见。
- 严禁编造 diff 中不存在的缺陷；证据必须能追溯到专家提供的摘录或 diff。
- 上下文可能被降级（部分文件仅列名），此时要更谨慎，不要对未看到的代码下结论。
- findings 最多 50 条；如果整体没有问题，给出 approve，findings 可为空数组。
- overallTone 依据最严重的问题决定：approve | changes_requested | comment。

${MEANINGLESS_CHANGE_POLICY}
- 合并专家的 meaningless-change suggestion 时，按上述规则核实并保留为最终 low/info finding，不要当作普通风格意见丢弃；不要把所有 suggestion 都映射为 meaningless-change。`;

function buildExpertSystemPrompt(expert: Expert, skillsText: string): string {
  const lines: string[] = [expert.rolePrompt, ""];
  if (skillsText.length > 0) lines.push(skillsText, "");
  lines.push(
    "你是一个独立的代码审查专家。基于下面的变更上下文，从你的专业视角输出审查结论。",
    "",
    EXPERT_CONTRACT,
  );
  return lines.join("\n");
}

function buildExpertUserPrompt(
  rendered: string,
  repoMemory: string | undefined,
): string {
  const lines: string[] = ["以下是本次变更的上下文：", "", rendered];
  if (repoMemory && repoMemory.length > 0) {
    lines.push(
      "",
      "## 仓库记忆（过往审查经验）",
      repoMemory,
      "",
      "以上供参考：若与当前 diff 冲突，以 diff 为准。",
    );
  }
  lines.push("", "请从你的专业视角进行审查，输出符合契约的 JSON。");
  return lines.join("\n");
}

function buildExpertRequest(
  expert: Expert,
  skillsText: string,
  rendered: string,
  repoMemory: string | undefined,
): ModelInvocationRequest {
  return {
    messages: [
      { role: "system", content: buildExpertSystemPrompt(expert, skillsText) },
      {
        role: "user",
        content: buildExpertUserPrompt(rendered, repoMemory),
      },
    ],
    responseFormat: "json",
    maxOutputTokens: 1_200,
    temperature: 0.2,
  };
}

function buildExpertRepairRequest(
  expert: Expert,
  skillsText: string,
  rendered: string,
  repoMemory: string | undefined,
  invalidText: string,
  issues: readonly string[],
): ModelInvocationRequest {
  return {
    messages: [
      { role: "system", content: buildExpertSystemPrompt(expert, skillsText) },
      {
        role: "user",
        content: `${buildExpertUserPrompt(rendered, repoMemory)}

你上一次的输出没有通过契约校验，错误如下：
${issues.map((issue) => `- ${issue}`).join("\n")}

你上一次的输出：
${invalidText}

请根据错误列表修正，重新只输出一个符合契约的 JSON 对象。`,
      },
    ],
    responseFormat: "json",
    maxOutputTokens: 1_200,
    temperature: 0.1,
  };
}

function renderExpertConclusion(expert: Expert, output: ExpertOutput): string {
  const lines = output.findings.map((finding) => {
    const location = `${finding.file ?? ""}${finding.line ? `:${finding.line}` : ""}`;
    const parts: string[] = [
      `- [${finding.severity}]${location ? ` ${location}` : ""} ${finding.message}`,
    ];
    if (finding.why) parts.push(`  依据：${finding.why}`);
    if (finding.evidence) parts.push(`  证据：${finding.evidence}`);
    return parts.join("\n");
  });
  return `### 专家 ${expert.name}（${expert.id}）
总结：${output.summary}
${lines.length > 0 ? `发现：\n${lines.join("\n")}` : "（无发现）"}`;
}

function buildLeadRequest(
  experts: readonly { expert: Expert; output: ExpertOutput }[],
  rendered: string,
  repoMemory: string | undefined,
): ModelInvocationRequest {
  const lines: string[] = ["以下是本次变更的原始上下文：", "", rendered];
  if (repoMemory && repoMemory.length > 0) {
    lines.push("", "## 仓库记忆（过往审查经验）", repoMemory);
  }
  if (experts.length > 0) {
    lines.push("", "## 各专家独立审查结论");
    for (const { expert, output } of experts) {
      lines.push(renderExpertConclusion(expert, output));
    }
  }
  lines.push("", "请合并以上结论，输出符合契约的最终审查 JSON。");
  return {
    messages: [
      { role: "system", content: LEAD_SYSTEM_PROMPT },
      { role: "user", content: lines.join("\n") },
    ],
    responseFormat: "json",
    maxOutputTokens: 2_400,
    temperature: 0.1,
  };
}

const LEAD_SYSTEM_PROMPT = `你是一位资深的代码审查主编（lead reviewer）。你的职责是把多位专家的独立审查结论合并成一份最终、去重、一致的结构化 PR 审查报告。

${LEAD_CONTRACT}`;

function buildLeadRepairRequest(
  experts: readonly { expert: Expert; output: ExpertOutput }[],
  rendered: string,
  repoMemory: string | undefined,
  invalidText: string,
  issues: readonly string[],
): ModelInvocationRequest {
  return {
    messages: [
      { role: "system", content: LEAD_SYSTEM_PROMPT },
      {
        role: "user",
        content: `${
          buildLeadRequest(experts, rendered, repoMemory).messages[1]!.content
        }

你上一次的输出没有通过契约校验，错误如下：
${issues.map((issue) => `- ${issue}`).join("\n")}

你上一次的输出：
${invalidText}

请根据错误列表修正，重新只输出一个符合契约的 JSON 对象。`,
      },
    ],
    responseFormat: "json",
    maxOutputTokens: 2_400,
    temperature: 0.1,
  };
}

/* ---------- types & helpers ---------- */

export type ExpertReviewDeps = {
  adapters: ReadonlyMap<string, ModelProviderAdapter>;
  candidates: readonly ModelCandidate[];
  /** Shared logical deadline across every expert call and the lead merge. */
  deadlineMs: number;
  retryPolicy: RetryPolicy;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export type ExpertReviewInput = {
  appliesTo: SkillAppliesTo;
  /** Rendered subject text (diff context, issue text, etc.). */
  rendered: string;
  /** Pre-selected skills whose fragments are attached to each expert prompt. */
  skills: readonly Skill[];
  repoMemory?: string;
};

export type ExpertReviewOutcome =
  | {
      outcome: "valid";
      review: PrReviewContract;
      usage: ModelUsage;
      candidate: ModelCandidate;
      attempts: readonly ModelAttemptOutcome[];
      /** Number of expert conclusions merged into the final review. */
      experts: number;
      durationMs: number;
    }
  | {
      outcome: "invalid";
      usage: ModelUsage;
      attempts: readonly ModelAttemptOutcome[];
      experts: number;
      durationMs: number;
    };

type ExpertAttempt =
  | {
      ok: true;
      output: ExpertOutput;
      usage: ModelUsage;
      candidate: ModelCandidate;
      attempts: readonly ModelAttemptOutcome[];
    }
  | {
      ok: false;
      attempts: readonly ModelAttemptOutcome[];
    };

function totalUsage(...usage: readonly ModelUsage[]): ModelUsage {
  return usage.reduce(
    (total, entry) => ({
      inputTokens: total.inputTokens + entry.inputTokens,
      outputTokens: total.outputTokens + entry.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 },
  );
}

function remainingMs(
  deadlineMs: number,
  now: () => number,
  startedAt: number,
): number {
  return Math.max(0, deadlineMs - (now() - startedAt));
}

function attemptsOf(error: unknown): readonly ModelAttemptOutcome[] {
  return error instanceof ModelRoutingFailedError ? error.attempts : [];
}

/** Runs one expert's main call plus a single bounded repair. */
async function invokeExpert(
  deps: ExpertReviewDeps,
  expert: Expert,
  skillsText: string,
  input: ExpertReviewInput,
  now: () => number,
  startedAt: number,
): Promise<ExpertAttempt> {
  const route = (request: ModelInvocationRequest, sticky?: ModelCandidate) =>
    routeModelInvocation(deps.adapters, {
      candidates: deps.candidates,
      request,
      deadlineMs: remainingMs(deps.deadlineMs, now, startedAt),
      retryPolicy: deps.retryPolicy,
      ...(sticky === undefined ? {} : { stickyCandidate: sticky }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      now,
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    });

  const completedAttempts: ModelAttemptOutcome[] = [];
  try {
    const main = await route(
      buildExpertRequest(expert, skillsText, input.rendered, input.repoMemory),
    );
    completedAttempts.push(...main.attempts);
    const validation = parseExpertJson(main.response.content);
    if (validation.outcome === "valid") {
      return {
        ok: true,
        output: validation.output,
        usage: main.response.usage,
        candidate: main.candidate,
        attempts: main.attempts,
      };
    }

    const repair = await route(
      buildExpertRepairRequest(
        expert,
        skillsText,
        input.rendered,
        input.repoMemory,
        main.response.content,
        validation.issues,
      ),
      main.candidate,
    );
    completedAttempts.push(...repair.attempts);
    const repaired = parseExpertJson(repair.response.content);
    const attempts = completedAttempts;
    const usage = totalUsage(main.response.usage, repair.response.usage);
    if (repaired.outcome === "valid") {
      return {
        ok: true,
        output: repaired.output,
        usage,
        candidate: repair.candidate,
        attempts,
      };
    }
    return { ok: false, attempts };
  } catch (error) {
    // A single broken expert must not take down the whole review.
    return {
      ok: false,
      attempts: [...completedAttempts, ...attemptsOf(error)],
    };
  }
}

/** Runs the lead merge plus a single bounded repair. */
async function invokeLead(
  deps: ExpertReviewDeps,
  input: ExpertReviewInput,
  experts: readonly { expert: Expert; output: ExpertOutput }[],
  now: () => number,
  startedAt: number,
): Promise<
  | {
      valid: true;
      review: PrReviewContract;
      candidate: ModelCandidate;
      usage: ModelUsage;
      attempts: readonly ModelAttemptOutcome[];
    }
  | {
      valid: false;
      usage: ModelUsage;
      attempts: readonly ModelAttemptOutcome[];
    }
> {
  const route = (request: ModelInvocationRequest, sticky?: ModelCandidate) =>
    routeModelInvocation(deps.adapters, {
      candidates: deps.candidates,
      request,
      deadlineMs: remainingMs(deps.deadlineMs, now, startedAt),
      retryPolicy: deps.retryPolicy,
      ...(sticky === undefined ? {} : { stickyCandidate: sticky }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      now,
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    });

  const main = await route(
    buildLeadRequest(experts, input.rendered, input.repoMemory),
  );
  const validation = parsePrReviewJson(main.response.content);
  if (validation.outcome === "valid") {
    return {
      valid: true,
      review: validation.review,
      candidate: main.candidate,
      usage: main.response.usage,
      attempts: main.attempts,
    };
  }

  const repair = await route(
    buildLeadRepairRequest(
      experts,
      input.rendered,
      input.repoMemory,
      main.response.content,
      validation.issues,
    ),
    main.candidate,
  );
  const repaired = parsePrReviewJson(repair.response.content);
  const attempts = [...main.attempts, ...repair.attempts];
  const usage = totalUsage(main.response.usage, repair.response.usage);
  if (repaired.outcome === "valid") {
    return {
      valid: true,
      review: repaired.review,
      candidate: repair.candidate,
      usage,
      attempts,
    };
  }
  return { valid: false, usage, attempts };
}

/**
 * Runs the expert team: every applicable expert reviews in parallel, then the
 * lead merges the successful conclusions into the strict PR review contract.
 * A still-invalid lead is reported as `invalid` so the engine can retry the
 * task; nothing is ever published from an unvalidated response.
 */
export async function runExpertReview(
  deps: ExpertReviewDeps,
  input: ExpertReviewInput,
): Promise<ExpertReviewOutcome> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const skillsText = renderSkillPrompts(input.skills);
  const experts = getExpertsFor(input.appliesTo);

  const results = await Promise.all(
    experts.map(async (expert) => ({
      expert,
      ...(await invokeExpert(deps, expert, skillsText, input, now, startedAt)),
    })),
  );

  const successes = results.filter(
    (result): result is typeof result & { ok: true } => result.ok === true,
  );
  const allAttempts = results.flatMap((result) => result.attempts);

  const lead = await invokeLead(
    deps,
    input,
    successes.map(({ expert, output }) => ({ expert, output })),
    now,
    startedAt,
  );
  // Invalid expert JSON still consumes tokens. Count every completed routing
  // attempt, including experts whose repair failed, rather than only merges.
  const usage = totalUsage(
    lead.usage,
    ...allAttempts.flatMap((attempt) => (attempt.usage ? [attempt.usage] : [])),
  );
  const attempts = [...allAttempts, ...lead.attempts];
  const expertsMerged = successes.length;

  if (lead.valid) {
    return {
      outcome: "valid",
      review: lead.review,
      usage,
      candidate: lead.candidate,
      attempts,
      experts: expertsMerged,
      durationMs: now() - startedAt,
    };
  }
  return {
    outcome: "invalid",
    usage,
    attempts,
    experts: expertsMerged,
    durationMs: now() - startedAt,
  };
}
