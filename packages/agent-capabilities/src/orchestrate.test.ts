import { describe, expect, it } from "vitest";
import {
  ModelInvocationError,
  type ModelCandidate,
  type ModelInvocationRequest,
  type ModelProviderAdapter,
} from "../../../packages/domain/src/index.js";
import type {
  Finding,
  PrReviewContract,
} from "../../../packages/pr-review/src/types.js";
import { parsePrReviewJson } from "../../../packages/pr-review/src/validate.js";
import {
  runExpertReview,
  type ExpertReviewDeps,
  type ExpertReviewInput,
} from "./orchestrate.js";
import { selectSkills } from "./skills.js";

const candidate: ModelCandidate = {
  provider: "provider-a",
  model: "model-a",
  accountName: "account-a",
};

function expertJson(seed: string): string {
  return JSON.stringify({
    summary: `专家结论 ${seed}`,
    findings: [
      {
        file: "src/a.ts",
        line: 3,
        severity: "warning",
        message: `发现 ${seed}`,
        why: `原因 ${seed}`,
        evidence: "+ const x = user.name;",
      },
    ],
  });
}

const validPrReview: PrReviewContract = {
  contractVersion: "pr-review/v1",
  summary: "合并后的最终总结",
  changedFileCount: 1,
  additions: 10,
  deletions: 2,
  overallTone: "changes_requested",
  findings: [
    {
      rule: "missing-null-check",
      severity: "high",
      file: "src/a.ts",
      message: "缺少空值检查",
      evidence: "const x = user.name",
      impact: "可能引发空指针",
      confidence: 0.8,
      suggestion: "补充判空逻辑",
      afterLine: 3,
    },
  ],
};

const validPrJson = JSON.stringify(validPrReview);

const meaninglessChangeInput: ExpertReviewInput = {
  appliesTo: "pr",
  rendered: `变更文件数: 1
新增行: 1，删除行: 0
### src/a.ts
\`\`\`diff
@@ -1,3 +1,4 @@
 export function answer(): number {
+  const unusedAnswer = 42;
   return 42;
 }
\`\`\``,
  skills: [],
};

const meaninglessExpertJson = JSON.stringify({
  summary: "新增局部常量未被使用，也没有维护价值。",
  findings: [
    {
      file: "src/a.ts",
      line: 2,
      severity: "suggestion",
      message: "meaningless-change：新增未使用的局部常量，建议删除。",
      why: "完整函数显示该常量没有被读取，返回值不变，也没有可维护性收益。",
      evidence: "+  const unusedAnswer = 42;",
    },
  ],
});

function meaninglessChangeFinding(
  severity: "low" | "info",
  confidence = 0.5,
): Finding {
  return {
    rule: "meaningless-change",
    severity,
    file: "src/a.ts",
    message: "新增局部常量未被使用，不改变行为也没有维护价值。",
    evidence: "+  const unusedAnswer = 42;",
    impact: "引入无效代码，增加阅读和维护负担。",
    confidence,
    suggestion: "删除未使用的局部常量。",
    afterLine: 2,
  };
}

function meaninglessChangeReview(severity: "low" | "info"): PrReviewContract {
  return {
    ...validPrReview,
    summary: "仅发现一处有明确证据的无价值修改。",
    additions: 1,
    deletions: 0,
    overallTone: "comment",
    findings: [meaninglessChangeFinding(severity)],
  };
}

function expectMeaninglessChangePolicy(request: ModelInvocationRequest): void {
  const system = request.messages[0]?.content ?? "";
  expect(system).toContain("无价值修改识别（issue #105）");
  expect(system).toContain("只有 diff 及已提供上下文能证明");
  expect(system).toContain("缺少预期功能或可维护性价值");
  expect(system).toContain("误提交的调试输出");
  expect(system).toContain("有明确用途的日志");
  expect(system).toContain("证据必须逐字摘自 diff");
  expect(system).toContain("正常重构");
  expect(system).toContain("安全修复");
  expect(system).toContain("格式化规范");
  expect(system).toContain("低置信的风格意见仍然不发");
  expect(system).toContain("rule 必须为 meaningless-change");
  expect(system).toContain("severity 必须为 low 或 info");
  expect(system).toContain("置信度门槛仍由校验器执行");
}

/**
 * Content-aware fake adapter: picks the response based on which phase the
 * request belongs to (expert vs lead, main vs repair), so tests stay
 * deterministic even though the four experts run in parallel.
 */
function adaptiveAdapter(options: {
  provider?: string;
  expertMain?: (system: string) => string;
  expertRepair?: string;
  leadMain?: string;
  leadRepair?: string;
  failExpertIf?: (system: string) => boolean;
}): ModelProviderAdapter & {
  calls: () => number;
  requests: readonly ModelInvocationRequest[];
} {
  let count = 0;
  const requests: ModelInvocationRequest[] = [];
  const adapter: ModelProviderAdapter = {
    provider: options.provider ?? "provider-a",
    invoke: async (_candidate, request) => {
      requests.push(request);
      const system = request.messages[0]?.content ?? "";
      const user = request.messages.at(-1)?.content ?? "";
      const isLead = system.includes("主编（lead reviewer）");
      const isRepair = user.includes("修正");
      if (!isLead && options.failExpertIf?.(system)) {
        throw new ModelInvocationError("server_error", "expert adapter failed");
      }
      let content: string;
      if (isLead) {
        content = isRepair
          ? (options.leadRepair ?? options.leadMain ?? "")
          : (options.leadMain ?? "");
      } else {
        content = isRepair
          ? (options.expertRepair ?? "")
          : (options.expertMain?.(system) ?? "");
      }
      count += 1;
      return { content, usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  return { ...adapter, calls: () => count, requests };
}

function deps(adapter: ModelProviderAdapter): ExpertReviewDeps {
  return {
    adapters: new Map([[adapter.provider, adapter]]),
    candidates: [candidate],
    deadlineMs: 10_000,
    retryPolicy: {
      maxAttemptsPerCandidate: 1,
      baseDelayMs: 10,
      maxDelayMs: 100,
    },
    now: () => 0,
    sleep: async () => undefined,
  };
}

const input: ExpertReviewInput = {
  appliesTo: "pr",
  rendered:
    "变更文件数: 1\n新增行: 10，删除行: 2\n### src/a.ts\n```\n+const x = user.name;\n+const sql = `SELECT * FROM users WHERE id=${id}`;\n```",
  skills: selectSkills("pr", "password sql readme token"),
};

describe("runExpertReview", () => {
  it("runs all experts and merges their conclusions into a valid review", async () => {
    const adapter = adaptiveAdapter({
      expertMain: () => expertJson("ok"),
      leadMain: validPrJson,
    });
    const outcome = await runExpertReview(deps(adapter), input);

    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.experts).toBe(4);
    expect(outcome.review.overallTone).toBe("changes_requested");
    expect(outcome.review.findings[0]?.rule).toBe("missing-null-check");
    expect(outcome.usage).toEqual({ inputTokens: 50, outputTokens: 25 });
    expect(outcome.attempts).toHaveLength(5);
    expect(adapter.calls()).toBe(5);
  });

  it("repairs an expert's invalid output before merging", async () => {
    const adapter = adaptiveAdapter({
      expertMain: () => "not valid json",
      expertRepair: expertJson("repaired"),
      leadMain: validPrJson,
    });
    const outcome = await runExpertReview(deps(adapter), input);

    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    // 4 experts x (main + repair) + 1 lead
    expect(outcome.experts).toBe(4);
    expect(outcome.usage).toEqual({ inputTokens: 90, outputTokens: 45 });
    expect(outcome.attempts).toHaveLength(9);
    expect(adapter.calls()).toBe(9);
  });

  it("degrades when one expert fails and only merges the successful ones", async () => {
    const adapter = adaptiveAdapter({
      expertMain: () => expertJson("ok"),
      failExpertIf: (system) => system.includes("文档与可读性专家"),
      leadMain: validPrJson,
    });
    const outcome = await runExpertReview(deps(adapter), input);

    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.experts).toBe(3);
    expect(outcome.usage).toEqual({ inputTokens: 40, outputTokens: 20 });
    expect(outcome.attempts).toHaveLength(5);
  });

  it("repairs an invalid lead output before accepting the review", async () => {
    const adapter = adaptiveAdapter({
      expertMain: () => expertJson("ok"),
      leadMain: "not valid json",
      leadRepair: validPrJson,
    });
    const outcome = await runExpertReview(deps(adapter), input);

    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.experts).toBe(4);
    expect(adapter.calls()).toBe(6);
  });

  it("reports invalid when the lead is still unparseable after repair", async () => {
    const adapter = adaptiveAdapter({
      expertMain: () => expertJson("ok"),
      leadMain: "not valid json",
      leadRepair: JSON.stringify({ contractVersion: "wrong" }),
    });
    const outcome = await runExpertReview(deps(adapter), input);

    expect(outcome.outcome).toBe("invalid");
  });

  it.each(["low", "info"] as const)(
    "preserves evidenced %s meaningless changes through expert prompts and the final parser",
    async (severity) => {
      const review = meaninglessChangeReview(severity);
      const leadJson = JSON.stringify(review);
      const adapter = adaptiveAdapter({
        expertMain: () => meaninglessExpertJson,
        leadMain: leadJson,
      });
      const outcome = await runExpertReview(
        deps(adapter),
        meaninglessChangeInput,
      );

      expect(outcome.outcome).toBe("valid");
      if (outcome.outcome !== "valid") return;
      expect(outcome.experts).toBe(4);
      expect(outcome.review).toEqual(review);
      expect(outcome.review.contractVersion).toBe("pr-review/v1");
      expect(parsePrReviewJson(leadJson)).toEqual({ outcome: "valid", review });
      expect(adapter.requests).toHaveLength(5);
      for (const request of adapter.requests) {
        expectMeaninglessChangePolicy(request);
        expect(request.messages.at(-1)?.content).toContain(
          meaninglessChangeInput.rendered,
        );
        expect(request.responseFormat).toBe("json");
      }
      const expertRequests = adapter.requests.filter(
        (request) =>
          !request.messages[0]?.content.includes("主编（lead reviewer）"),
      );
      expect(expertRequests).toHaveLength(4);
      for (const request of expertRequests) {
        expect(request.messages[0]?.content).toContain(
          "这类发现用 severity: suggestion",
        );
      }
      const leadRequest = adapter.requests.at(-1);
      expect(leadRequest?.messages[0]?.content).toContain(
        "不要把所有 suggestion 都映射为 meaningless-change",
      );
      expect(leadRequest?.messages.at(-1)?.content).toContain(
        "[suggestion] src/a.ts:2 meaningless-change",
      );
      expect(leadRequest?.messages.at(-1)?.content).toContain(
        "+  const unusedAnswer = 42;",
      );
    },
  );

  it.each(["low", "info"] as const)(
    "keeps %s meaningless-change policy in all specialist and lead repair prompts",
    async (severity) => {
      const review = meaninglessChangeReview(severity);
      const adapter = adaptiveAdapter({
        expertMain: () => "not valid json",
        expertRepair: meaninglessExpertJson,
        leadMain: "not valid json",
        leadRepair: JSON.stringify(review),
      });
      const outcome = await runExpertReview(
        deps(adapter),
        meaninglessChangeInput,
      );

      expect(outcome.outcome).toBe("valid");
      if (outcome.outcome !== "valid") return;
      expect(outcome.experts).toBe(4);
      expect(outcome.review).toEqual(review);
      expect(adapter.requests).toHaveLength(10);
      for (const request of adapter.requests) {
        expectMeaninglessChangePolicy(request);
      }
      const repairRequests = adapter.requests.filter((request) =>
        request.messages
          .at(-1)
          ?.content.includes("你上一次的输出没有通过契约校验"),
      );
      expect(repairRequests).toHaveLength(5);
      const leadRepair = adapter.requests.at(-1);
      expect(leadRepair?.messages.at(-1)?.content).toContain(
        "[suggestion] src/a.ts:2 meaningless-change",
      );
      expect(leadRepair?.messages.at(-1)?.content).toContain("not valid json");
    },
  );

  it("does not bypass confidence or ordinary low/info filtering in the expert path", async () => {
    const retained = meaninglessChangeFinding("info");
    const review: PrReviewContract = {
      ...meaninglessChangeReview("info"),
      findings: [
        retained,
        {
          ...meaninglessChangeFinding("low", 0.49),
          file: "src/uncertain-low.ts",
        },
        {
          ...meaninglessChangeFinding("info", 0.49),
          file: "src/uncertain-info.ts",
        },
        {
          ...retained,
          rule: "naming-style",
          severity: "low",
          confidence: 0.99,
        },
        { ...retained, rule: "comment-style", confidence: 0.99 },
        { ...retained, rule: "meaningless-change-style", confidence: 0.99 },
      ],
    };
    const leadJson = JSON.stringify(review);
    const adapter = adaptiveAdapter({
      expertMain: () => meaninglessExpertJson,
      leadMain: leadJson,
    });
    const outcome = await runExpertReview(
      deps(adapter),
      meaninglessChangeInput,
    );

    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.review).toEqual({ ...review, findings: [retained] });
    expect(parsePrReviewJson(leadJson)).toEqual({
      outcome: "valid",
      review: outcome.review,
    });
    expect(adapter.calls()).toBe(5);
  });
});

describe("expert usage accounting on degraded reviews", () => {
  it("counts paid responses even when every expert repair remains invalid", async () => {
    const adapter = adaptiveAdapter({
      expertMain: () => "invalid",
      expertRepair: "still invalid",
      leadMain: validPrJson,
    });
    const outcome = await runExpertReview(deps(adapter), input);
    expect(outcome.outcome).toBe("valid");
    expect(outcome.experts).toBe(0);
    expect(outcome.usage).toEqual({ inputTokens: 90, outputTokens: 45 });
    expect(outcome.attempts).toHaveLength(9);
  });

  it("keeps the paid main response and attempt when an expert repair fails", async () => {
    const base = adaptiveAdapter({
      expertMain: () => "invalid",
      leadMain: validPrJson,
    });
    const adapter: ModelProviderAdapter = {
      provider: base.provider,
      invoke: async (candidate, request, signal) => {
        if (
          !request.messages[0]?.content.includes("主编（lead reviewer）") &&
          request.messages.at(-1)?.content.includes("修正")
        ) {
          throw new ModelInvocationError(
            "server_error",
            "repair transport failed",
          );
        }
        return base.invoke(candidate, request, signal);
      },
    };
    const outcome = await runExpertReview(deps(adapter), input);
    expect(outcome.outcome).toBe("valid");
    expect(outcome.experts).toBe(0);
    expect(outcome.usage).toEqual({ inputTokens: 50, outputTokens: 25 });
    expect(outcome.attempts).toHaveLength(9);
    expect(
      outcome.attempts.filter(
        (attempt) => attempt.errorCategory === "server_error",
      ),
    ).toHaveLength(4);
  });
});
