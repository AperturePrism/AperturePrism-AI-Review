import { describe, expect, it } from "vitest";
import type { Finding, Suppression } from "./types.js";
import { globMatches } from "./utils/input.js";
import { makeHarness, sampleFinding } from "./test-fixture.js";

describe("忽略规则和期限", () => {
  it("空条件不能创建忽略整个仓库的规则", async () => {
    const { call } = await makeHarness();
    await expect(
      call("suppressions.create", { name: "过宽", reason: "先忽略" }),
    ).rejects.toMatchObject({ code: "empty_suppression" });
    await expect(
      call("suppressions.create", {
        name: "无理由",
        reason: " ",
        ruleId: "auth",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("匹配规则的全部条件都要满足，忽略不改变发现本身的状态", async () => {
    const { call } = await makeHarness();
    const finding = await call<Finding>("findings.create", sampleFinding);
    const suppression = await call<Suppression>("suppressions.create", {
      name: "精确忽略",
      reason: "兼容旧系统",
      ruleId: sampleFinding.ruleId,
      pathPattern: "src/**",
      severities: ["high"],
    });
    expect(
      await call("suppressions.preview", { id: suppression.id }),
    ).toMatchObject({ matched: 1 });
    expect(await call("gate.evaluate")).toMatchObject({
      decision: "pass",
      counts: { suppressed: 1, new: 0 },
    });
    expect(await call("findings.get", { id: finding.id })).toMatchObject({
      status: "open",
    });
    await call("findings.create", { ...sampleFinding, severity: "critical" });
    expect(await call("gate.evaluate")).toMatchObject({
      decision: "fail",
      counts: { suppressed: 0 },
    });
  });

  it("到期临界点即失效，续期需新理由并恢复匹配", async () => {
    const { call, setTime } = await makeHarness();
    await call("findings.create", sampleFinding);
    const suppression = await call<Suppression>("suppressions.create", {
      name: "临时",
      reason: "等待依赖修复",
      ruleId: sampleFinding.ruleId,
      expiresAt: "2026-11-14T00:00:00Z",
    });
    expect(await call("gate.evaluate")).toMatchObject({ decision: "pass" });
    setTime("2026-11-14T00:00:00Z");
    expect(
      await call("suppressions.preview", { id: suppression.id }),
    ).toMatchObject({ matched: 0, expired: true });
    expect(await call("gate.evaluate")).toMatchObject({ decision: "fail" });
    await call("suppressions.renew", {
      id: suppression.id,
      expiresAt: "2026-11-15T00:00:00Z",
      reason: "依赖发布推迟一天",
    });
    expect(await call("gate.evaluate")).toMatchObject({ decision: "pass" });
  });

  it("停用和过期不会把规则从历史中删除", async () => {
    const { call } = await makeHarness();
    await call("findings.create", sampleFinding);
    const suppression = await call<Suppression>("suppressions.create", {
      name: "规则",
      reason: "需要人工判断",
      fingerprint: "not-matched",
    });
    expect(
      await call("suppressions.preview", { id: suppression.id }),
    ).toMatchObject({ matched: 0 });
    await call("suppressions.toggle", { id: suppression.id, enabled: false });
    expect(await call("suppressions.list")).toMatchObject({
      total: 1,
      items: [{ enabled: false }],
    });
  });

  it("已过期时间和目录穿越条件不被接受", async () => {
    const { call } = await makeHarness();
    await expect(
      call("suppressions.create", {
        name: "过期",
        reason: "测试",
        ruleId: "auth",
        expiresAt: "2026-11-12T00:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "invalid_expiration" });
    await expect(
      call("suppressions.create", {
        name: "越界",
        reason: "测试",
        pathPattern: "../**",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("glob的单星不穿过目录，双星支持任意深度，正则字符按字面处理", () => {
    expect(globMatches("src/*.ts", "src/api.ts")).toBe(true);
    expect(globMatches("src/*.ts", "src/nested/api.ts")).toBe(false);
    expect(globMatches("src/**", "src/nested/api.ts")).toBe(true);
    expect(globMatches("src/a?.ts", "src/ab.ts")).toBe(true);
    expect(globMatches("src/a?.ts", "src/a/b.ts")).toBe(false);
    expect(globMatches("src/(a+).ts", "src/aaaa.ts")).toBe(false);
    expect(globMatches("src/(a+).ts", "src/(a+).ts")).toBe(true);
    expect(globMatches("**/*.test.ts", "api.test.ts")).toBe(true);
    expect(globMatches("**/*.test.ts", "src/api.test.ts")).toBe(true);
    expect(globMatches("src/**/api.ts", "src/api.ts")).toBe(true);
    expect(globMatches("src/**/api.ts", "src/deep/nested/api.ts")).toBe(true);
  });
});
