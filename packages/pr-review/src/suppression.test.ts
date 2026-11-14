/** 抑制回归：有效范围、到期边界、精确规则优先和审计记录。 */
import { describe, expect, it } from "vitest";
import {
  expiringSuppressions,
  matchesSuppression,
  parseSuppressions,
  suppressFindings,
  suppressionCounts,
} from "./suppression.js";
import { findingFingerprint } from "./baseline.js";
import type { Finding } from "./types.js";

const finding: Finding = {
  rule: "unsafe-query",
  file: "src/db/query.ts",
  severity: "high",
  afterLine: 10,
  evidence: "database.query(input)",
  message: "不受约束的查询",
  impact: "查询范围可被控制",
  suggestion: "绑定查询参数",
  confidence: 0.9,
};
const config = {
  id: "accepted-1",
  rule: finding.rule,
  path: "src/db/**",
  reason: "仅在内部隔离的开发环境使用",
  owner: "@db",
  expiresAt: "2026-11-20T00:00:00Z",
};
const now = new Date("2026-11-13T00:00:00Z");

describe("finding suppressions", () => {
  it("requires an accountable, bounded suppression", () => {
    expect(() =>
      parseSuppressions([
        { id: "bad", reason: "short", owner: "", expiresAt: config.expiresAt },
      ]),
    ).toThrow();
    expect(() => parseSuppressions([{ ...config, rule: undefined }])).toThrow(
      "规则和路径",
    );
    expect(() =>
      parseSuppressions([{ ...config, expiresAt: "never" }]),
    ).toThrow();
  });

  it("rejects duplicate identifiers", () => {
    expect(() => parseSuppressions([config, config])).toThrow("ID 重复");
  });

  it("limits rule suppression to the declared path and severity", () => {
    const rules = parseSuppressions([{ ...config, severities: ["high"] }]);
    expect(matchesSuppression(finding, rules[0]!)).toBe(true);
    expect(
      matchesSuppression({ ...finding, severity: "critical" }, rules[0]!),
    ).toBe(false);
    expect(
      matchesSuppression({ ...finding, file: "src/web/query.ts" }, rules[0]!),
    ).toBe(false);
    expect(
      matchesSuppression({ ...finding, rule: "other-rule" }, rules[0]!),
    ).toBe(false);
  });

  it("treats expiry at the current instant as expired", () => {
    const rules = parseSuppressions([
      { ...config, expiresAt: now.toISOString() },
    ]);
    const result = suppressFindings([finding], rules, now);
    expect(result.active).toEqual([finding]);
    expect(result.expired).toHaveLength(1);
    expect(result.suppressed).toEqual([]);
  });

  it("prefers an exact fingerprint suppression over a broad path", () => {
    const rules = parseSuppressions([
      config,
      { ...config, id: "exact", fingerprint: findingFingerprint(finding) },
    ]);
    const result = suppressFindings([finding], rules, now);
    expect(result.suppressed[0]?.suppression.id).toBe("exact");
    expect(result.unused[0]?.id).toBe(config.id);
    expect(suppressionCounts(result).high).toBe(1);
  });

  it("shows soon-to-expire items in time order", () => {
    const rules = parseSuppressions([
      config,
      { ...config, id: "earlier", expiresAt: "2026-11-14T00:00:00Z" },
      { ...config, id: "later", expiresAt: "2027-11-14T00:00:00Z" },
    ]);
    expect(expiringSuppressions(rules, now, 7).map((rule) => rule.id)).toEqual([
      "earlier",
      config.id,
    ]);
  });

  it("rejects reverse creation and expiration times", () => {
    expect(() =>
      parseSuppressions([{ ...config, createdAt: "2027-01-01T00:00:00Z" }]),
    ).toThrow("到期时间");
  });

  it("leaves callers' finding arrays unchanged", () => {
    const findings = [finding];
    suppressFindings(findings, parseSuppressions([config]), now);
    expect(findings).toEqual([finding]);
  });
});
