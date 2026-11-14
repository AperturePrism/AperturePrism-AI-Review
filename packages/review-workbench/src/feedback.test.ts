import { describe, expect, it } from "vitest";
import type { Actor, Feedback, Finding } from "./types.js";
import { makeHarness, sampleFinding } from "./test-fixture.js";

describe("人工反馈", () => {
  it("同一人编辑一票，不会刷高某规则的统计权重", async () => {
    const { call } = await makeHarness();
    const finding = await call<Finding>("findings.create", sampleFinding);
    const first = await call<Feedback>("feedback.create", {
      findingId: finding.id,
      verdict: "useful",
      comment: "确认存在",
    });
    const changed = await call<Feedback>("feedback.create", {
      findingId: finding.id,
      verdict: "false_positive",
      comment: "后续查到入口已有校验",
    });
    expect(changed.id).toBe(first.id);
    expect(await call("feedback.summary")).toMatchObject({
      total: 1,
      verdicts: { useful: 0, false_positive: 1 },
    });
  });

  it("不同人的反馈保留独立票数并按规则聚合", async () => {
    const { call } = await makeHarness();
    const finding = await call<Finding>("findings.create", sampleFinding);
    await call("feedback.create", {
      findingId: finding.id,
      verdict: "useful",
      comment: "可利用",
    });
    const other: Actor = {
      userId: "second-reviewer",
      isAdmin: false,
      canAccessRepository: () => true,
    };
    await call(
      "feedback.create",
      {
        findingId: finding.id,
        verdict: "false_positive",
        comment: "需要查调用条件",
      },
      other,
    );
    expect(await call("feedback.summary")).toMatchObject({
      total: 2,
      rules: [
        {
          ruleId: sampleFinding.ruleId,
          useful: 1,
          falsePositive: 1,
          usefulRate: 0.5,
        },
      ],
    });
  });

  it("处理反馈不会自动关闭发现，提交者修改后重新等待处理", async () => {
    const { call } = await makeHarness();
    const finding = await call<Finding>("findings.create", sampleFinding);
    const feedback = await call<Feedback>("feedback.create", {
      findingId: finding.id,
      verdict: "false_positive",
      comment: "认为有上游校验",
    });
    const resolved = await call<Feedback>("feedback.resolve", {
      id: feedback.id,
      resolution: "已确认需要补校验",
    });
    expect(resolved).toMatchObject({ resolved: true, resolvedBy: "reviewer" });
    expect(await call("findings.get", { id: finding.id })).toMatchObject({
      status: "open",
    });
    expect(await call("feedback.summary")).toMatchObject({ unresolved: 0 });
    await call("feedback.create", {
      findingId: finding.id,
      verdict: "useful",
      comment: "补充调用路径后确认",
    });
    expect(await call("feedback.summary")).toMatchObject({ unresolved: 1 });
  });

  it("未知发现、无效结论和空白评论被拒绝", async () => {
    const { call } = await makeHarness();
    await expect(
      call("feedback.create", {
        findingId: "missing",
        verdict: "useful",
        comment: "test",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    const finding = await call<Finding>("findings.create", sampleFinding);
    await expect(
      call("feedback.create", {
        findingId: finding.id,
        verdict: "maybe",
        comment: "test",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      call("feedback.create", {
        findingId: finding.id,
        verdict: "useful",
        comment: " ",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
