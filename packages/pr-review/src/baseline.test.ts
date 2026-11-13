/** 基线对照回归：指纹在行号与文案改变时稳定，重复证据按次数对照。 */
import { describe, expect, it } from "vitest";
import {
  compareReviewBaseline,
  createReviewBaseline,
  findingFingerprint,
  parseReviewBaseline,
  renameBaselineFiles,
  serializeReviewBaseline,
} from "./baseline.js";
import type { Finding, PrReviewContract } from "./types.js";

const finding: Finding = {
  rule: "unsafe-query",
  file: "src/query.ts",
  severity: "high",
  afterLine: 10,
  evidence: "database.query(input)",
  message: "不受约束的查询",
  impact: "查询范围可被控制",
  suggestion: "绑定查询参数",
  confidence: 0.9,
};
const review: PrReviewContract = {
  contractVersion: "pr-review/v1",
  summary: "审查结果",
  changedFileCount: 1,
  additions: 1,
  deletions: 0,
  overallTone: "comment",
  findings: [finding],
};
const now = new Date("2026-11-13T00:00:00Z");

describe("review baseline", () => {
  it("ignores presentation changes in a stable fingerprint", () => {
    expect(findingFingerprint(finding)).toBe(
      findingFingerprint({
        ...finding,
        afterLine: 900,
        message: "新的文案",
        severity: "medium",
      }),
    );
    expect(findingFingerprint(finding)).not.toBe(
      findingFingerprint({ ...finding, evidence: "database.safeQuery(input)" }),
    );
  });

  it("normalizes whitespace but preserves code case", () => {
    expect(findingFingerprint(finding)).toBe(
      findingFingerprint({
        ...finding,
        evidence: " database.query(input) \r\n",
      }),
    );
    expect(findingFingerprint(finding)).not.toBe(
      findingFingerprint({ ...finding, evidence: "DATABASE.query(input)" }),
    );
  });

  it("compares new, existing, changed and resolved independently", () => {
    const other = { ...finding, file: "src/old.ts" };
    const baseline = createReviewBaseline(
      { ...review, findings: [finding, other] },
      { revision: "before", now },
    );
    const current = [
      { ...finding, severity: "critical" as const },
      { ...finding, file: "src/new.ts" },
    ];
    const result = compareReviewBaseline(current, baseline);
    expect(result.counts).toEqual({
      new: 1,
      existing: 0,
      changed: 1,
      resolved: 1,
    });
    expect(result.resolved[0]?.finding.file).toBe("src/old.ts");
    expect(result.baselineRevision).toBe("before");
  });

  it("does not hide newly repeated evidence behind one old finding", () => {
    const baseline = createReviewBaseline(review, { revision: "before", now });
    const result = compareReviewBaseline(
      [finding, { ...finding, afterLine: 200 }],
      baseline,
    );
    expect(result.counts).toEqual({
      new: 1,
      existing: 1,
      changed: 0,
      resolved: 0,
    });
  });

  it("keeps earliest seen time while counting later observations", () => {
    const baseline = createReviewBaseline(review, { revision: "before", now });
    const later = new Date("2026-11-14T00:00:00Z");
    const next = createReviewBaseline(review, {
      revision: "after",
      now: later,
      previous: baseline,
    });
    expect(next.entries[0]).toMatchObject({
      firstSeenAt: now.toISOString(),
      lastSeenAt: later.toISOString(),
      occurrences: 2,
    });
  });

  it("round trips without losing audit timestamps", () => {
    const baseline = createReviewBaseline(review, { revision: "before", now });
    expect(
      parseReviewBaseline(JSON.parse(serializeReviewBaseline(baseline))),
    ).toEqual(baseline);
  });

  it("rejects a tampered fingerprint", () => {
    const baseline = createReviewBaseline(review, { revision: "before", now });
    baseline.entries[0]!.finding.evidence = "tampered";
    expect(() => parseReviewBaseline(baseline)).toThrow("指纹");
  });

  it("rejects inconsistent timestamps", () => {
    const baseline = createReviewBaseline(review, { revision: "before", now });
    baseline.entries[0]!.firstSeenAt = "2027-01-01T00:00:00Z";
    expect(() => parseReviewBaseline(baseline)).toThrow("首次发现");
  });

  it("migrates only explicitly renamed paths", () => {
    const baseline = createReviewBaseline(review, { revision: "before", now });
    const next = renameBaselineFiles(baseline, {
      "src/query.ts": "src/db/query.ts",
    });
    expect(next.entries[0]?.finding.file).toBe("src/db/query.ts");
    expect(next.entries[0]?.fingerprint).not.toBe(
      baseline.entries[0]?.fingerprint,
    );
    expect(baseline.entries[0]?.finding.file).toBe("src/query.ts");
    expect(parseReviewBaseline(next)).toEqual(next);
  });

  it.each(["../secret", "/etc/passwd", "C:\\secret", "foo\u0000bar"])(
    "rejects non-repository paths %s",
    (file) => {
      expect(() => findingFingerprint({ ...finding, file })).toThrow();
    },
  );
});
