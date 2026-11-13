import { z } from "zod";
import { duplicateJudgmentSchema } from "../../../packages/contracts/src/index.js";
import type {
  ModelCandidate,
  ModelProviderAdapter,
  ModelUsage,
} from "../../../packages/domain/src/index.js";
import {
  routeModelInvocation,
  type RetryPolicy,
} from "../../../packages/model-router/src/index.js";

/** Bump when the judgment prompt semantics change. */
export const DUPLICATE_JUDGMENT_PROMPT_VERSION = "v1" as const;
export const DUPLICATE_JUDGMENT_POLICY_VERSION =
  `duplicate-judgment-${DUPLICATE_JUDGMENT_PROMPT_VERSION}` as const;

export type CandidateBrief = {
  issueNumber: number;
  title: string;
  body: string;
};

export type JudgeDuplicatesOptions = {
  adapters: ReadonlyMap<string, ModelProviderAdapter>;
  candidates: readonly ModelCandidate[];
  deadlineMs: number;
  retryPolicy: RetryPolicy;
  signal?: AbortSignal;
};

export type JudgeDuplicatesOutcome =
  | {
      outcome: "valid";
      judgment: z.infer<typeof duplicateJudgmentSchema>;
      usage: ModelUsage;
    }
  | { outcome: "invalid"; usage: ModelUsage };

const systemPrompt = `你是一个严谨的 GitHub Issue 重复关系判断器。给你一条"主 Issue"和若干"候选 Issue"。请基于根因、触发条件、错误表现、影响模块、环境和复现步骤来判断主 Issue 与哪些候选是重复、相关或无关。

输出必须严格符合以下契约（JSON 对象，不要任何解释或 Markdown）：
{
  "contractVersion": "duplicate-judgment/v1",
  "decision": "duplicate | related | not_duplicate | insufficient_evidence",
  "relatedIssues": [候选 issue 编号，按相关度从高到低，最多 10 个],
  "sharedSignals": ["主 Issue 与相关候选共有的信号，例如相同错误码、堆栈、模块路径"],
  "differingSignals": ["两者不同的信号，例如不同版本、不同触发条件"],
  "confidence": 0-1
}

规则：
- confidence 代表你对该判断的把握。信息不足时用 insufficient_evidence。
- 只基于给出的内容判断，不要编造。relatedIssues 只能列候选清单里出现过的编号。
- 相同根因+相同触发条件=duplicate；部分关联=related；明显无关=not_duplicate。`;

export function buildDuplicateJudgmentRequest(input: {
  lead: CandidateBrief;
  candidates: readonly CandidateBrief[];
}) {
  const leadBlock = [
    `主 Issue #${input.lead.issueNumber}: ${input.lead.title}`,
    input.lead.body || "(无正文)",
  ].join("\n");
  const candidateBlocks = input.candidates
    .map((c) => `【候选 #${c.issueNumber}】${c.title}\n${c.body || "(无正文)"}`)
    .join("\n\n");
  const userContent = [leadBlock, "", "候选清单：", candidateBlocks].join("\n");

  return {
    messages: [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: userContent },
    ],
    responseFormat: "json" as const,
    maxOutputTokens: 1_500,
    temperature: 0.1,
  };
}

export function parseDuplicateJudgmentJson(text: string):
  | { outcome: "valid"; judgment: z.infer<typeof duplicateJudgmentSchema> }
  | {
      outcome: "invalid";
      issues: readonly string[];
    } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      outcome: "invalid",
      issues: ["root: response was not valid JSON"],
    };
  }
  const parsed = duplicateJudgmentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      outcome: "invalid",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "root"}: ${issue.message}`,
      ),
    };
  }
  return { outcome: "valid", judgment: parsed.data };
}

/**
 * Judges whether a lead issue is a duplicate of any recalled candidate using
 * the configured model role. Runs the main call, validates the contract, and
 * performs exactly one bounded repair on contract failure. Invalid output is
 * reported as such so the caller can fall back to human triage.
 */
export async function judgeDuplicates(
  options: JudgeDuplicatesOptions,
  input: { lead: CandidateBrief; candidates: readonly CandidateBrief[] },
): Promise<JudgeDuplicatesOutcome> {
  const main = await routeModelInvocation(options.adapters, {
    candidates: options.candidates,
    request: buildDuplicateJudgmentRequest(input),
    deadlineMs: options.deadlineMs,
    retryPolicy: options.retryPolicy,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const validation = parseDuplicateJudgmentJson(main.response.content);
  if (validation.outcome === "valid") {
    return {
      outcome: "valid",
      judgment: validation.judgment,
      usage: main.response.usage,
    };
  }

  // One bounded repair that restates the contract and the parse errors.
  const repair = await routeModelInvocation(options.adapters, {
    candidates: options.candidates,
    request: {
      ...buildDuplicateJudgmentRequest(input),
      messages: [
        ...buildDuplicateJudgmentRequest(input).messages,
        {
          role: "assistant",
          content: main.response.content,
        },
        {
          role: "user",
          content: [
            "你上一次的输出没有通过契约校验，错误如下：",
            ...validation.issues.map((issue) => `- ${issue}`),
            "请重新只输出符合契约的 JSON 对象。",
          ].join("\n"),
        },
      ],
    },
    deadlineMs: Math.max(0, options.deadlineMs),
    retryPolicy: options.retryPolicy,
    stickyCandidate: main.candidate,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const repaired = parseDuplicateJudgmentJson(repair.response.content);
  const usage: ModelUsage = {
    inputTokens:
      main.response.usage.inputTokens + repair.response.usage.inputTokens,
    outputTokens:
      main.response.usage.outputTokens + repair.response.usage.outputTokens,
  };
  if (repaired.outcome === "valid") {
    return { outcome: "valid", judgment: repaired.judgment, usage };
  }
  return { outcome: "invalid", usage };
}
