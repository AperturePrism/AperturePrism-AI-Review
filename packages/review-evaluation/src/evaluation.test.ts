/** 离线实验台的业务/性质测试，不调用任何真实模型。 */
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  compareReviewEvaluations,
  datasetJsonl,
  evaluateReviewGate,
  evaluateReviewRun,
  inspectDatasetLeakage,
  lineRangeDistance,
  matchReviewFindings,
  parseDatasetJsonl,
  parsePredictionJsonl,
  parseReviewGatePolicy,
  predictionJsonl,
  renderReviewEvaluation,
  reviewMetrics,
  seededEvaluationRandom,
  workbenchEvaluationInput,
  type ExpectedFinding,
  type PredictedFinding,
} from "./index.js";

const label = (
  id = "e-1",
  line = 10,
  severity: ExpectedFinding["severity"] = "high",
): ExpectedFinding => ({
  id,
  ruleId: "auth",
  path: "src/api.ts",
  startLine: line,
  endLine: line,
  severity,
  label: "positive",
});
const prediction = (id = "p-1", line = 10): PredictedFinding => ({
  id,
  ruleId: "auth",
  path: "src/api.ts",
  startLine: line,
  endLine: line,
  severity: "high",
  confidence: 1,
  message: "sensitive code excerpt",
});
const row = (id = "case-1", expected: ExpectedFinding[] = [label()]) => ({
  version: 1,
  id,
  repository: "Example/Repo",
  revision: `revision-${id}`,
  split: "test",
  input: `context-${id}`,
  expected,
});
const jsonl = (rows: unknown[]) =>
  rows.map((item) => JSON.stringify(item)).join("\n") + "\n";
function fixture(
  findings: PredictedFinding[] = [prediction()],
  expected: ExpectedFinding[] = [label()],
) {
  const dataset = parseDatasetJsonl(jsonl([row("case-1", expected)]), {
    id: "test",
  });
  const run = parsePredictionJsonl(
    jsonl([
      {
        version: 1,
        caseId: "case-1",
        findings,
        durationMs: 12.5,
        inputTokens: 5,
        outputTokens: 2,
        costMicros: 3,
      },
    ]),
    {
      id: "run-a",
      model: "candidate",
      policyVersion: "v1",
      datasetHash: dataset.hash,
    },
  );
  return { dataset, run, result: evaluateReviewRun(dataset, run) };
}

describe("versioned dataset boundaries", () => {
  it("keeps the hash stable across line endings, object key order and case order", () => {
    const a = row("a");
    const b = row("b");
    const first = parseDatasetJsonl(jsonl([a, b]), { id: "first" });
    const second = parseDatasetJsonl(jsonl([b, a]).replace(/\n/g, "\r\n"), {
      id: "second",
    });
    expect(first.hash).toBe(second.hash);
    expect(
      parseDatasetJsonl(datasetJsonl(first), { id: "roundtrip" }).hash,
    ).toBe(first.hash);
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("changes the version when labels change while retaining the input fingerprint", () => {
    const a = parseDatasetJsonl(jsonl([row()]), { id: "test" });
    const b = parseDatasetJsonl(jsonl([row("case-1", [label("changed")])]), {
      id: "test",
    });
    expect(a.hash).not.toBe(b.hash);
    expect(a.cases[0]!.inputHash).toBe(b.cases[0]!.inputHash);
  });

  it("reports exact input lines without echoing the source context", () => {
    expect(() =>
      parseDatasetJsonl(jsonl([row()]) + "secret-invalid-json", { id: "test" }),
    ).toThrow("line 2");
    try {
      parseDatasetJsonl("secret-invalid-json", { id: "test" });
    } catch (error) {
      expect(String(error)).not.toContain("secret-invalid-json");
    }
    expect(() =>
      parseDatasetJsonl(jsonl([row(), row()]), { id: "test" }),
    ).toThrow("duplicate case");
  });

  it("rejects unsupported versions, unknown fields, unsafe paths and invalid ranges", () => {
    for (const invalid of [
      { ...row(), version: 2 },
      { ...row(), exepcted: [] },
      row("case-1", [{ ...label(), path: "../secret" }]),
      row("case-1", [{ ...label(), startLine: 0 }]),
      row("case-1", [{ ...label(), endLine: 1 }]),
      { ...row(), split: "production" },
    ])
      expect(() =>
        parseDatasetJsonl(jsonl([invalid]), { id: "test" }),
      ).toThrow();
  });

  it("bounds bytes, lines and finding counts", () => {
    expect(() =>
      parseDatasetJsonl(jsonl([row()]), { id: "test", maxBytes: 10 }),
    ).toThrow("byte limit");
    expect(() =>
      parseDatasetJsonl(jsonl([row()]), { id: "test", maxLineBytes: 10 }),
    ).toThrow("byte limit");
    expect(() =>
      parseDatasetJsonl(jsonl([row("a"), row("b")]), {
        id: "test",
        maxRecords: 1,
      }),
    ).toThrow("too many");
    expect(() =>
      parseDatasetJsonl(jsonl([row("case-1", [label("a"), label("b")])]), {
        id: "test",
        maxFindingsPerCase: 1,
      }),
    ).toThrow("finding limit");
  });

  it("finds cross-split duplicate inputs and revisions independently", () => {
    const a = row("a");
    const b = { ...row("b"), split: "train", input: a.input };
    const dataset = parseDatasetJsonl(jsonl([a, b]), { id: "test" });
    expect(inspectDatasetLeakage(dataset)).toMatchObject({
      clean: false,
      groups: [{ reason: "duplicate_input", crossesSplits: true }],
    });
    const sameRevision = parseDatasetJsonl(
      jsonl([a, { ...b, input: "different context", revision: a.revision }]),
      { id: "test" },
    );
    expect(
      inspectDatasetLeakage(sameRevision).groups.some(
        (group) => group.reason === "duplicate_revision",
      ),
    ).toBe(true);
  });
});

describe("prediction input boundaries", () => {
  it("roundtrips a validated run without changing its hash", () => {
    const { run } = fixture();
    expect(parsePredictionJsonl(predictionJsonl(run), run).hash).toBe(run.hash);
  });

  it("rejects fractional tokens, duplicate case records and error/partial combinations", () => {
    const { dataset } = fixture();
    const metadata = {
      id: "run",
      model: "m",
      policyVersion: "v1",
      datasetHash: dataset.hash,
    };
    const base = { version: 1, caseId: "case-1", findings: [] };
    expect(() =>
      parsePredictionJsonl(jsonl([{ ...base, inputTokens: 0.5 }]), metadata),
    ).toThrow("safe integer");
    expect(() => parsePredictionJsonl(jsonl([base, base]), metadata)).toThrow(
      "duplicate case",
    );
    expect(() =>
      parsePredictionJsonl(
        jsonl([
          { ...base, findings: [prediction()], errorCategory: "timeout" },
        ]),
        metadata,
      ),
    ).toThrow("partially");
    expect(() =>
      parsePredictionJsonl(
        jsonl([{ ...base, findings: [{ ...prediction(), confidence: 2 }] }]),
        metadata,
      ),
    ).toThrow("confidence");
  });
});

describe("one-to-one finding matching", () => {
  it("uses augmenting paths instead of losing a match to greedy assignment", () => {
    const matching = matchReviewFindings(
      [label("a", 10), label("b", 12)],
      [prediction("x", 11), prediction("y", 9)],
      { lineTolerance: 1 },
    );
    expect(matching.matched).toHaveLength(2);
    expect(matching.missed).toHaveLength(0);
    expect(matching.falsePositives).toHaveLength(0);
  });

  it("does not let duplicate predictions claim the same ground truth twice", () => {
    const matching = matchReviewFindings(
      [label()],
      [prediction("a"), prediction("b")],
    );
    expect(matching.matched).toHaveLength(1);
    expect(matching.falsePositives).toHaveLength(1);
  });

  it("requires compatible rules and paths while supporting explicit rule migration aliases", () => {
    const expected = { ...label(), ruleId: "old" };
    const predicted = { ...prediction(), ruleId: "new" };
    expect(matchReviewFindings([expected], [predicted]).matched).toHaveLength(
      0,
    );
    expect(
      matchReviewFindings([expected], [predicted], {
        ruleAliases: { old: "middle", middle: "new" },
      }).matched,
    ).toHaveLength(1);
    expect(() =>
      matchReviewFindings([expected], [predicted], {
        ruleAliases: { old: "new", new: "old" },
      }),
    ).toThrow("cycle");
    expect(
      matchReviewFindings([label()], [{ ...prediction(), path: "Src/api.ts" }])
        .matched,
    ).toHaveLength(0);
  });

  it("treats annotated negatives as false positives and low-confidence findings as ignored", () => {
    const matching = matchReviewFindings(
      [{ ...label(), label: "negative" }],
      [prediction("known"), { ...prediction("low"), confidence: 0.1 }],
      { minimumConfidence: 0.5 },
    );
    expect(matching.matched).toHaveLength(0);
    expect(matching.knownNegatives).toHaveLength(1);
    expect(matching.falsePositives).toHaveLength(1);
    expect(matching.ignoredLowConfidence).toHaveLength(1);
  });

  it("keeps distance symmetric and invariant when both ranges shift together", () => {
    for (let left = 1; left < 20; left += 1)
      for (let right = 1; right < 20; right += 1) {
        const a = { startLine: left, endLine: left + 2 };
        const b = { startLine: right, endLine: right + 1 };
        expect(lineRangeDistance(a, b)).toBe(lineRangeDistance(b, a));
        expect(
          lineRangeDistance(
            { startLine: a.startLine + 50, endLine: a.endLine + 50 },
            { startLine: b.startLine + 50, endLine: b.endLine + 50 },
          ),
        ).toBe(lineRangeDistance(a, b));
      }
  });

  it("does not change confusion counts when prediction order changes", () => {
    const expected = [label("a", 10), label("b", 20)];
    const predictions = [
      prediction("x", 10),
      prediction("y", 20),
      prediction("z", 40),
    ];
    const forward = matchReviewFindings(expected, predictions);
    const reverse = matchReviewFindings(
      [...expected].reverse(),
      [...predictions].reverse(),
    );
    expect(reverse).toEqual(forward);
  });
});

describe("scoring, statistics and release gates", () => {
  it("computes micro F1, weighted severity and severity confusion from matched labels", () => {
    const expected = [
      label("critical", 10, "critical"),
      label("high", 20, "high"),
    ];
    const { result } = fixture([prediction("p-high", 20)], expected);
    expect(result.metrics).toMatchObject({
      truePositive: 1,
      falseNegative: 1,
      recall: 0.5,
      f1: 2 / 3,
    });
    expect(result.weighted.recall).toBe(1 / 3);
    expect(result.bySeverity.critical.falseNegative).toBe(1);
    expect(result.performance).toMatchObject({
      inputTokens: 5,
      outputTokens: 2,
      costMicros: 3,
      p95Ms: 12.5,
    });
  });

  it("keeps undefined metrics null instead of claiming perfect empty evaluations", () => {
    const { result } = fixture([], []);
    expect(reviewMetrics(0, 0, 0).f1).toBeNull();
    expect(result.metrics.f1).toBeNull();
    expect(result.perfectCases).toBe(1);
  });

  it("counts missing predictions as missed positives and rejects stale datasets or unknown cases", () => {
    const { dataset, run } = fixture();
    const missing = parsePredictionJsonl("", run);
    expect(evaluateReviewRun(dataset, missing)).toMatchObject({
      missingCases: 1,
      metrics: { falseNegative: 1 },
    });
    expect(() =>
      evaluateReviewRun(dataset, { ...run, datasetHash: "0".repeat(64) }),
    ).toThrow("hash");
    expect(() =>
      evaluateReviewRun(dataset, {
        ...run,
        records: [{ ...run.records[0]!, caseId: "unknown" }],
      }),
    ).toThrow("unknown case");
  });

  it("uses integer pricing when prediction files do not include cost", () => {
    const { dataset, run } = fixture();
    const noCost = {
      ...run,
      records: run.records.map((item) => ({ ...item, costMicros: null })),
    };
    const priced = evaluateReviewRun(dataset, noCost, {
      price: {
        currency: "USD",
        inputMicrosPerMillion: 1_000_000,
        outputMicrosPerMillion: 2_000_000,
      },
    });
    expect(priced.performance).toMatchObject({
      costMicros: 9,
      currency: "USD",
    });
    expect(
      evaluateReviewRun(dataset, noCost).performance.costMicros,
    ).toBeNull();
  });

  it("generates deterministic paired bootstrap intervals and catches obvious regressions", () => {
    const { dataset, run, result } = fixture();
    const worseRun = {
      ...run,
      id: "worse",
      records: run.records.map((item) => ({ ...item, findings: [] })),
    };
    const worse = evaluateReviewRun(dataset, worseRun);
    const a = compareReviewEvaluations(result, worse, {
      samples: 100,
      seed: 42,
    });
    const b = compareReviewEvaluations(result, worse, {
      samples: 100,
      seed: 42,
    });
    expect(a).toEqual(b);
    expect(a.outcome).toBe("regression");
    expect(a.intervals.f1).toMatchObject({
      low: -1,
      high: -1,
      validSamples: 100,
    });
    expect(a.warnings).toContain("fewer_than_20_cases");
    const rngA = seededEvaluationRandom(10);
    const rngB = seededEvaluationRandom(10);
    expect(Array.from({ length: 10 }, rngA)).toEqual(
      Array.from({ length: 10 }, rngB),
    );
  });

  it("refuses apples-to-oranges comparisons and undefined confidence gates", () => {
    const { dataset, result } = fixture();
    expect(() =>
      compareReviewEvaluations(result, { ...result, datasetHash: "different" }),
    ).toThrow("dataset");
    expect(() =>
      compareReviewEvaluations(result, { ...result, split: "train" }),
    ).toThrow("split");
    expect(
      evaluateReviewGate(result, { maxConfidenceRegression: 0 }, { dataset })
        .blockers,
    ).toContain("confidence_regression");
  });

  it("fails configured unknown metrics, missing cases and split leakage", () => {
    const { dataset, result } = fixture([], []);
    expect(evaluateReviewGate(result, { minF1: 0.8 }, { dataset }).passed).toBe(
      false,
    );
    expect(evaluateReviewGate(result, {}, {}).blockers).toContain(
      "clean_splits",
    );
    expect(() => parseReviewGatePolicy({ minF1: 2 })).toThrow();
    expect(() => parseReviewGatePolicy({ minFOne: 1 })).toThrow(
      "unknown field",
    );
  });

  it("renders readable reports without source messages and escapes CSV formulas", () => {
    const { dataset, result } = fixture([prediction("extra", 100)]);
    const gate = evaluateReviewGate(result, {}, { dataset });
    const report = renderReviewEvaluation(result, { format: "json", gate });
    expect(report).not.toContain("sensitive code excerpt");
    expect(JSON.parse(report).evaluation.datasetHash).toBe(dataset.hash);
    expect(
      renderReviewEvaluation(result, { format: "markdown", gate }),
    ).toContain("严重度加权 F1");
    const malicious = {
      ...result,
      cases: result.cases.map((item) => ({ ...item, caseId: "=SUM(1,2)" })),
    };
    expect(renderReviewEvaluation(malicious, { format: "csv" })).toContain(
      "'=SUM(1,2)",
    );
  });

  it("exports a workbench import with explicit execution status and metric caveat", () => {
    const { result } = fixture();
    const exported = workbenchEvaluationInput(result);
    expect(exported.cases[0]!.expected).toEqual(exported.cases[0]!.observed);
    expect(exported.note).toContain("分数与发现指标不同");
    expect(exported.reference).toContain(result.datasetHash);
  });
});
