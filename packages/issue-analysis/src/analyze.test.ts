import { describe, expect, it } from "vitest";
import type {
  ModelCandidate,
  ModelProviderAdapter,
} from "../../../packages/domain/src/index.js";
import type { IssueContext } from "./context.js";
import type { IssueResultSection } from "./prompt.js";
import { analyzeIssue, type IssueAnalyzerOptions } from "./analyze.js";

const candidate: ModelCandidate = {
  provider: "provider-a",
  model: "model-a",
  accountName: "account-a",
};

const fallback: ModelCandidate = {
  provider: "provider-b",
  model: "model-b",
  accountName: "account-b",
};

const validIssueJson = JSON.stringify({
  contractVersion: "issue-analysis/v1",
  category: "bug",
  summary: "The app crashes on startup when the config file is missing.",
  severity: "S0",
  priority: "P0",
  quality: "complete",
  evidence: [
    {
      kind: "reproduction_steps",
      excerpt: "1. rm config. 2. start. 3. crash.",
    },
  ],
  missingInformation: [],
  suggestedLabels: ["bug"],
  suggestedActions: ["Reproduce on a clean checkout."],
  confidence: { severity: 0.9, rootCause: 0.8, suggestion: 0.7 },
});

const context: IssueContext = {
  repository: { owner: "o", name: "r" },
  installationId: "42",
  issue: {
    number: 7,
    title: "Crash",
    body: "Crash on startup.",
    state: "open",
    htmlUrl: "https://github.test/o/r/issues/7",
    author: "alice",
    createdAt: "2026-08-17T00:00:00Z",
    updatedAt: "2026-08-17T01:00:00Z",
    labels: [],
  },
  comments: [],
  degraded: [],
  estimatedTokens: 10,
  images: [],
};

function scriptedAdapter(provider: string, contents: readonly string[]) {
  let calls = 0;
  const adapter: ModelProviderAdapter = {
    provider,
    invoke: async () => {
      const content = contents[Math.min(calls, contents.length - 1)] ?? "";
      calls += 1;
      return { content, usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  return { adapter, calls: () => calls };
}

function options(
  adapters: ModelProviderAdapter[],
  candidates: readonly ModelCandidate[],
): IssueAnalyzerOptions {
  return {
    adapters: new Map(adapters.map((entry) => [entry.provider, entry])),
    candidates,
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

describe("issue analysis orchestration", () => {
  it("returns a graded analysis for valid model output", async () => {
    const { adapter } = scriptedAdapter("provider-a", [validIssueJson]);
    const outcome = await analyzeIssue(
      options([adapter], [candidate]),
      context,
    );

    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.analysis.result.category).toBe("bug");
    expect(outcome.analysis.result.severity).toBe("S0");
    expect(outcome.analysis.result.priority).toBe("P0");
    expect(outcome.analysis.adjustments).toEqual([]);
    expect(outcome.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(outcome.durationMs).toBe(0);
  });

  it("downgrades high grades without substantive evidence via the server rules", async () => {
    const unsubstantiated = JSON.stringify({
      contractVersion: "issue-analysis/v1",
      category: "bug",
      summary: "Something breaks.",
      severity: "S0",
      priority: "P0",
      quality: "complete",
      evidence: [{ kind: "impact_scope", excerpt: "All users are affected." }],
      missingInformation: [],
      suggestedLabels: [],
      suggestedActions: [],
      confidence: { severity: 0.9, rootCause: 0.8, suggestion: 0.7 },
    });
    const { adapter } = scriptedAdapter("provider-a", [unsubstantiated]);
    const outcome = await analyzeIssue(
      options([adapter], [candidate]),
      context,
    );

    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.analysis.result.severity).toBe("unknown");
    expect(outcome.analysis.result.priority).toBe("needs_triage");
    expect(outcome.analysis.adjustments.length).toBeGreaterThan(0);
  });

  it("performs one bounded repair and accepts the corrected output", async () => {
    const { adapter, calls } = scriptedAdapter("provider-a", [
      "not valid json",
      validIssueJson,
    ]);
    const outcome = await analyzeIssue(
      options([adapter], [candidate]),
      context,
    );

    expect(calls()).toBe(2);
    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.analysis.result.category).toBe("bug");
    expect(outcome.attempts).toHaveLength(2);
    // Both the failed main call and the successful repair consumed tokens.
    expect(outcome.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
  });

  it("reports invalid when the repair also fails, without publishing a decision", async () => {
    const { adapter, calls } = scriptedAdapter("provider-a", [
      "not valid json",
      JSON.stringify({ contractVersion: "wrong" }),
    ]);
    const outcome = await analyzeIssue(
      options([adapter], [candidate]),
      context,
    );

    expect(calls()).toBe(2);
    expect(outcome.outcome).toBe("invalid");
  });

  it("publishes the raw defect list for an external code-review request when schema repair keeps failing (#60)", async () => {
    // 外部仓库代码审查请求：正文指向别的仓库并请 bot 找 bug。
    const reviewContext: IssueContext = {
      ...context,
      issue: {
        ...context.issue,
        body:
          "https://github.com/other/plugin/issues/17\n让bot找代码中的bug时，未说出任何bug",
      },
    };
    // main 与 repair 都是自由格式缺陷清单，无法通过 JSON 契约。
    const rawList =
      "1. main.py 第 12 行：缺失 import re，调用 re.match 会抛 NameError。\n" +
      "2. 第 40 行：except 捕获范围过宽，吞掉了真实错误。";
    const { adapter, calls } = scriptedAdapter("provider-a", [
      "Not JSON at all",
      rawList,
    ]);
    const outcome = await analyzeIssue(
      options([adapter], [candidate]),
      reviewContext,
    );

    expect(calls()).toBe(2);
    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.analysis.result.summary).toBe(rawList);
    expect(outcome.analysis.result.category).toBe("bug");
    expect(outcome.analysis.result.severity).toBe("unknown");
    // 标注降级原因，供评论 / 结果页向用户说明这不是结构化分析。
    expect(
      outcome.analysis.adjustments.some((a) => a.field === "severity"),
    ).toBe(true);
  });

  it("still reports invalid for non-review issues when repair keeps failing (#60 regression)", async () => {
    // 普通缺陷报告：即使 repair 失败也不走宽松降级，保持 invalid。
    const { adapter, calls } = scriptedAdapter("provider-a", [
      "not valid json",
      JSON.stringify({ contractVersion: "wrong" }),
    ]);
    const outcome = await analyzeIssue(
      options([adapter], [candidate]),
      context,
    );

    expect(calls()).toBe(2);
    expect(outcome.outcome).toBe("invalid");
  });

  it("does not attempt lenient publish when repair output is empty (#60)", async () => {
    const reviewContext: IssueContext = {
      ...context,
      issue: {
        ...context.issue,
        body:
          "https://github.com/other/plugin/issues/3\n帮我检查 main.py 的 bug",
      },
    };
    const { adapter, calls } = scriptedAdapter("provider-a", [
      "Not JSON at all",
      "", // repair 返回空：没有可发布的内容。
    ]);
    const outcome = await analyzeIssue(
      options([adapter], [candidate]),
      reviewContext,
    );

    expect(calls()).toBe(2);
    expect(outcome.outcome).toBe("invalid");
  });

  it("falls over to another candidate when the primary provider is missing", async () => {
    const { adapter } = scriptedAdapter("provider-b", [validIssueJson]);
    const outcome = await analyzeIssue(
      options([adapter], [candidate, fallback]),
      context,
    );

    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.candidate).toEqual(fallback);
  });
});

describe("结果区块后置过滤", () => {
  const richIssueJson = JSON.stringify({
    contractVersion: "issue-analysis/v1",
    category: "bug",
    summary: "crash",
    severity: "S0",
    priority: "P0",
    quality: "complete",
    suggestedTitle: "Crash on startup",
    probableCause: "missing config",
    troubleshooting: ["create a default config file"],
    proposedChanges: [{ path: "src/main.ts", change: "add default config" }],
    evidence: [{ kind: "reproduction_steps", excerpt: "rm config; start" }],
    missingInformation: ["OS version", "runtime version"],
    suggestedLabels: ["bug"],
    suggestedActions: ["reproduce on a clean checkout"],
    confidence: { severity: 0.9, rootCause: 0.8, suggestion: 0.7 },
  });

  it("缺省不传 sections 时保留全部字段", async () => {
    const { adapter } = scriptedAdapter("provider-a", [richIssueJson]);
    const outcome = await analyzeIssue(
      options([adapter], [candidate]),
      context,
    );
    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.analysis.result.missingInformation).toEqual([
      "OS version",
      "runtime version",
    ]);
    expect(outcome.analysis.result.suggestedActions).toEqual([
      "reproduce on a clean checkout",
    ]);
  });

  it("关闭的区块在校验后被强制清空，其余区块保留", async () => {
    const { adapter } = scriptedAdapter("provider-a", [richIssueJson]);
    // 模拟默认设置：关闭 missing_information、suggested_actions 与 suggested_assignee。
    const sections = new Set<IssueResultSection>([
      "summary",
      "suggested_title",
      "probable_cause",
      "troubleshooting",
      "evidence",
      "suggested_labels",
      "proposed_changes",
    ]);
    const outcome = await analyzeIssue(
      { ...options([adapter], [candidate]), sections },
      context,
    );
    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.analysis.result.missingInformation).toEqual([]);
    expect(outcome.analysis.result.suggestedActions).toEqual([]);
    expect(outcome.analysis.result.suggestedAssignee).toBeUndefined();
    // 保留的区块不受影响。
    expect(outcome.analysis.result.probableCause).toBe("missing config");
    expect(outcome.analysis.result.proposedChanges).toEqual([
      { path: "src/main.ts", change: "add default config" },
    ]);
    expect(outcome.analysis.result.evidence).toHaveLength(1);
    expect(outcome.analysis.result.summary).toBe("crash");
  });

  it("关闭建议标题 / 可能原因等可选字段时整个字段被移除", async () => {
    const { adapter } = scriptedAdapter("provider-a", [richIssueJson]);
    const sections = new Set<IssueResultSection>([
      "summary",
      "troubleshooting",
      "evidence",
      "missing_information",
      "suggested_labels",
      "proposed_changes",
      "suggested_actions",
    ]);
    const outcome = await analyzeIssue(
      { ...options([adapter], [candidate]), sections },
      context,
    );
    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.analysis.result.suggestedTitle).toBeUndefined();
    expect(outcome.analysis.result.probableCause).toBeUndefined();
  });

  it("开启 suggested_assignee 时保留值，关闭时强制移除字段", async () => {
    const richWithAssignee = JSON.stringify({
      contractVersion: "issue-analysis/v1",
      category: "bug",
      summary: "crash",
      severity: "S0",
      priority: "P0",
      quality: "complete",
      suggestedTitle: "Crash on startup",
      probableCause: "missing config",
      troubleshooting: ["create a default config file"],
      proposedChanges: [{ path: "src/main.ts", change: "add default config" }],
      evidence: [{ kind: "reproduction_steps", excerpt: "rm config; start" }],
      missingInformation: ["OS version"],
      suggestedLabels: ["bug"],
      suggestedActions: ["reproduce on a clean checkout"],
      suggestedAssignee: "bb0813",
      confidence: { severity: 0.9, rootCause: 0.8, suggestion: 0.7 },
    });

    // 开启 suggested_assignee 时保留值
    const { adapter: adapterOn } = scriptedAdapter("provider-a", [richWithAssignee]);
    const sectionsOn = new Set<IssueResultSection>([
      "summary",
      "suggested_assignee",
    ]);
    const outcomeOn = await analyzeIssue(
      { ...options([adapterOn], [candidate]), sections: sectionsOn },
      context,
    );
    expect(outcomeOn.outcome).toBe("valid");
    if (outcomeOn.outcome !== "valid") return;
    expect(outcomeOn.analysis.result.suggestedAssignee).toBe("bb0813");

    // 关闭 suggested_assignee 时整个字段被移除（undefined）
    const { adapter: adapterOff } = scriptedAdapter("provider-a", [richWithAssignee]);
    const sectionsOff = new Set<IssueResultSection>(["summary"]);
    const outcomeOff = await analyzeIssue(
      { ...options([adapterOff], [candidate]), sections: sectionsOff },
      context,
    );
    expect(outcomeOff.outcome).toBe("valid");
    if (outcomeOff.outcome !== "valid") return;
    expect(outcomeOff.analysis.result.suggestedAssignee).toBeUndefined();
  });
});

describe("按类别分组的 Issue 结果区块 (#28)", () => {
  const featureIssueJson = JSON.stringify({
    contractVersion: "issue-analysis/v1",
    category: "feature",
    summary: "Add a dark mode toggle.",
    severity: "unknown",
    priority: "P2",
    quality: "actionable",
    proposedChanges: [{ path: "src/theme.ts", change: "add toggle" }],
    suggestedLabels: ["feature"],
    suggestedActions: ["implement toggle"],
    evidence: [],
    missingInformation: [],
    suggestedAssignee: "bb0813",
    confidence: { severity: 0.9, rootCause: 0.8, suggestion: 0.7 },
  });

  const bugIssueJson = JSON.stringify({
    contractVersion: "issue-analysis/v1",
    category: "bug",
    summary: "Crash on startup.",
    severity: "S0",
    priority: "P0",
    quality: "complete",
    evidence: [{ kind: "reproduction_steps", excerpt: "rm config; start" }],
    missingInformation: ["OS version"],
    suggestedLabels: ["bug"],
    suggestedActions: ["reproduce on a clean checkout"],
    confidence: { severity: 0.9, rootCause: 0.8, suggestion: 0.7 },
  });

  const featureContext: IssueContext = {
    ...context,
    issue: { ...context.issue, title: "建议新增功能", labels: [] },
  };

  it("bug 组：该类别 Issue 用 bug 组开关过滤结果", async () => {
    const { adapter } = scriptedAdapter("provider-a", [bugIssueJson]);
    const outcome = await analyzeIssue(
      {
        ...options([adapter], [candidate]),
        sectionsByCategory: {
          bug: new Set<IssueResultSection>(["summary", "evidence"]),
          feature: new Set<IssueResultSection>(["summary", "proposed_changes"]),
        },
      },
      context,
    );
    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    // bug 组只开 summary + evidence：其余字段应被清空/移除。
    expect(outcome.analysis.result.missingInformation).toEqual([]);
    expect(outcome.analysis.result.suggestedActions).toEqual([]);
    expect(outcome.analysis.result.evidence).toHaveLength(1);
    expect(outcome.analysis.result.summary).toBe("Crash on startup.");
  });

  it("feature 组：feature 类 Issue 用 feature 组开关过滤结果，并保留建议指派人", async () => {
    const { adapter } = scriptedAdapter("provider-a", [featureIssueJson]);
    const outcome = await analyzeIssue(
      {
        ...options([adapter], [candidate]),
        sectionsByCategory: {
          bug: new Set<IssueResultSection>(["summary", "evidence"]),
          feature: new Set<IssueResultSection>([
            "summary",
            "proposed_changes",
            "suggested_assignee",
          ]),
        },
      },
      featureContext,
    );
    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.analysis.result.proposedChanges).toHaveLength(1);
    expect(outcome.analysis.result.suggestedAssignee).toBe("bb0813");
    expect(outcome.analysis.result.suggestedActions).toEqual([]);
  });

  it("未配置分类组时回落到通用 sections", async () => {
    const { adapter } = scriptedAdapter("provider-a", [bugIssueJson]);
    const outcome = await analyzeIssue(
      {
        ...options([adapter], [candidate]),
        sections: new Set<IssueResultSection>(["summary", "missing_information"]),
        sectionsByCategory: { feature: new Set(["summary"]) },
      },
      context,
    );
    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    // bug 组未配置 → 回落通用组：只保留 summary + missing_information，其余清空。
    expect(outcome.analysis.result.missingInformation).toEqual(["OS version"]);
    expect(outcome.analysis.result.evidence).toEqual([]);
  });
});
