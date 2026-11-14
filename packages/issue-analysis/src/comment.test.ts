import { describe, expect, it } from "vitest";
import {
  applyGradingRules,
  type IssueAnalysisResult,
} from "../../../packages/contracts/src/index.js";
import {
  buildIssueAnalysisComment,
  buildPlaceholderComment,
} from "./comment.js";

const result: IssueAnalysisResult = {
  contractVersion: "issue-analysis/v1",
  category: "security",
  summary: "API tokens leak into the access log.",
  severity: "S1",
  priority: "P1",
  quality: "complete",
  evidence: [
    { kind: "logs", excerpt: "token=abc123 appears in the access log" },
  ],
  missingInformation: ["Deployment version"],
  suggestedLabels: ["security"],
  suggestedActions: ["Redact tokens before logging"],
  troubleshooting: [],
  proposedChanges: [],
  confidence: { severity: 0.9, rootCause: 0.8, suggestion: 0.7 },
};

describe("issue comment templates", () => {
  it("builds a neutral placeholder that is not a decision", () => {
    const placeholder = buildPlaceholderComment();
    expect(placeholder).toContain("AperturePrism");
    expect(placeholder).not.toContain("S0");
  });

  it("renders every part of the graded analysis", () => {
    const graded = applyGradingRules(result);
    const comment = buildIssueAnalysisComment(graded);

    expect(comment).toContain("security");
    expect(comment).toContain("S1");
    expect(comment).toContain("P1");
    expect(comment).toContain("API tokens leak into the access log.");
    expect(comment).toContain("token=abc123 appears in the access log");
    expect(comment).toContain("Deployment version");
    expect(comment).toContain("security");
    expect(comment).toContain("90%");
    expect(comment).toContain("由 AperturePrism 自动生成");
  });

  it("notes server-side rating adjustments when present", () => {
    const unsubstantiated = {
      ...result,
      severity: "S0",
      priority: "P0",
      evidence: [{ kind: "impact_scope", excerpt: "All users affected" }],
    } satisfies IssueAnalysisResult;
    const graded = applyGradingRules(unsubstantiated);
    const comment = buildIssueAnalysisComment(graded);

    expect(graded.adjustments.length).toBeGreaterThan(0);
    expect(comment).toContain("S0 → unknown");
    expect(comment).toContain("P0 → needs_triage");
    expect(comment).toContain("评级调整");
  });

  it("appends a related-issues section that only references, never auto-links", () => {
    const graded = applyGradingRules(result);
    const related = [
      {
        id: "d1",
        repositoryId: "r1",
        repositoryFullName: "owner/repo",
        issueNumber: 42,
        score: 12.5,
        reasons: ["text", "signal"] as const,
        title: "同仓库的历史 issue",
        body: "正文",
      },
    ];
    const comment = buildIssueAnalysisComment(graded, related);

    expect(comment).toContain("可能相关的历史 Issue");
    expect(comment).toContain("https://github.com/owner/repo/issues/42");
    expect(comment).toContain("仅供参考，不自动关联");
    expect(comment).not.toContain("close");
  });

  it("渲染原因与修复方案，而不只是索要信息", () => {
    // issue #6：用户反馈「跟没分析一样」，因为结论里只有缺失信息。
    const graded = applyGradingRules(
      {
        ...result,
        probableCause: "日志中间件在脱敏前写入了原始请求头",
        troubleshooting: ["确认 LOG_LEVEL 是否为 debug"],
        proposedChanges: [
          {
            path: "packages/observability/src/index.ts",
            locator: "sensitivePaths",
            change: "把 authorization 加入脱敏字段",
          },
        ],
      },
      { exploredCode: true },
    );
    const comment = buildIssueAnalysisComment(graded);

    expect(comment).toContain("可能原因");
    expect(comment).toContain("日志中间件在脱敏前写入了原始请求头");
    expect(comment).toContain("建议修改");
    expect(comment).toContain("packages/observability/src/index.ts");
    expect(comment).toContain("sensitivePaths");
    expect(comment).toContain("可以先试试");
  });

  it("没有方案字段时不渲染空标题", () => {
    const comment = buildIssueAnalysisComment(applyGradingRules(result));
    expect(comment).not.toContain("可能原因");
    expect(comment).not.toContain("建议修改");
    expect(comment).not.toContain("可以先试试");
  });

  it("未读取源码的占位路径不包代码框（避免被当成真实文件路径）", () => {
    const graded = applyGradingRules({
      ...result,
      proposedChanges: [
        {
          path: "（未读取源码，路径待确认）",
          change: "在合并转发渲染处移除子消息时间字段",
        },
      ],
    });
    const comment = buildIssueAnalysisComment(graded);
    expect(comment).toContain(
      "（未读取源码，路径待确认）：在合并转发渲染处移除子消息时间字段",
    );
    expect(comment).not.toContain("`（未读取源码，路径待确认）`");
  });

  it("建议标签逐个包行内代码（灰框），不平铺（issue #23）", () => {
    const graded = applyGradingRules({
      ...result,
      suggestedLabels: ["security", "review-bot", "context-awareness"],
    });
    const comment = buildIssueAnalysisComment(graded);

    expect(comment).toContain("### 建议标签");
    expect(comment).toContain("`security` `review-bot` `context-awareness`");
  });

  it("建议指派人逗号分隔多人时逐个 @（issue #53）", () => {
    const graded = applyGradingRules({
      ...result,
      suggestedAssignee: "bb0813, mjy1113451, alice",
    });
    const comment = buildIssueAnalysisComment(graded);

    expect(comment).toContain("### 建议指派人");
    expect(comment).toContain("@bb0813 @mjy1113451 @alice");
    expect(comment).not.toContain("@@");
  });

  it("建议指派人只含单用户名时仅 @ 一个", () => {
    const graded = applyGradingRules({
      ...result,
      suggestedAssignee: "bb0813",
    });
    const comment = buildIssueAnalysisComment(graded);

    expect(comment).toContain("### 建议指派人");
    expect(comment).toContain("@bb0813");
  });
});
