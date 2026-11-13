/**
 * 候选审查结果：读取已有预测，校验用量与发现，不运行模型。
 * @example
 * parsePredictionJsonl(text, { id: "candidate-a", model: "a", policyVersion: "v2", datasetHash });
 */
import { compareEvaluationText } from "./dataset.js";

import {
  EvaluationInputError,
  evaluationHash,
  findingPath,
  inputCount,
  inputObject,
  inputSeverity,
  inputText,
  parseJsonl,
  rejectUnknownFields,
  type EvaluationSeverity,
  type JsonlLimits,
} from "./dataset.js";

export type PredictedFinding = {
  id: string;
  ruleId: string;
  path: string;
  startLine: number;
  endLine: number;
  severity: EvaluationSeverity;
  confidence: number;
  message: string;
};

export type PredictionRecord = {
  version: 1;
  caseId: string;
  findings: PredictedFinding[];
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number | null;
  errorCategory: string | null;
};

export type PredictionRun = {
  version: 1;
  id: string;
  model: string;
  policyVersion: string;
  datasetHash: string;
  hash: string;
  records: PredictionRecord[];
};

export type PredictionMetadata = {
  id: string;
  model: string;
  policyVersion: string;
  datasetHash: string;
};

function predictedFinding(value: unknown, line: number): PredictedFinding {
  const item = inputObject(value, line);
  rejectUnknownFields(
    item,
    [
      "id",
      "ruleId",
      "path",
      "startLine",
      "endLine",
      "severity",
      "confidence",
      "message",
    ],
    line,
  );
  const startLine = inputCount(item.startLine, "startLine", line);
  const endLine = inputCount(item.endLine ?? startLine, "endLine", line);
  if (startLine < 1 || endLine < startLine)
    throw new EvaluationInputError("invalid finding line range", { line });
  const confidence = item.confidence ?? 1;
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  )
    throw new EvaluationInputError("confidence must be between 0 and 1", {
      line,
    });
  if (
    item.message !== undefined &&
    (typeof item.message !== "string" || item.message.length > 20_000)
  )
    throw new EvaluationInputError(
      "message must be text within 20000 characters",
      { line },
    );
  return {
    id: inputText(item.id, "finding.id", 128, line),
    ruleId: inputText(item.ruleId, "ruleId", 200, line),
    path: findingPath(item.path, line),
    startLine,
    endLine,
    severity: inputSeverity(item.severity, line),
    confidence,
    message: typeof item.message === "string" ? item.message : "",
  };
}

/** 每个案例最多一条结果；重跑结果应放进另一个 run，而非覆盖无法追踪的旧行。 */
export function parsePredictionJsonl(
  text: string,
  metadata: PredictionMetadata,
  limits: JsonlLimits = {},
): PredictionRun {
  const normalized = {
    id: inputText(metadata.id, "run.id", 128),
    model: inputText(metadata.model, "run.model", 300),
    policyVersion: inputText(metadata.policyVersion, "policyVersion", 128),
    datasetHash: inputText(metadata.datasetHash, "datasetHash", 64),
  };
  if (!/^[a-f0-9]{64}$/.test(normalized.datasetHash))
    throw new EvaluationInputError("datasetHash must be a SHA-256 hex digest");
  const seen = new Set<string>();
  const records = parseJsonl(text, limits).map(
    ({ value, line }): PredictionRecord => {
      const item = inputObject(value, line);
      rejectUnknownFields(
        item,
        [
          "version",
          "caseId",
          "findings",
          "durationMs",
          "inputTokens",
          "outputTokens",
          "costMicros",
          "errorCategory",
        ],
        line,
      );
      if (item.version !== 1)
        throw new EvaluationInputError("unsupported prediction version", {
          line,
        });
      const caseId = inputText(item.caseId, "caseId", 128, line);
      if (seen.has(caseId))
        throw new EvaluationInputError("duplicate case prediction", { line });
      seen.add(caseId);
      if (
        !Array.isArray(item.findings) ||
        item.findings.length > (limits.maxFindingsPerCase ?? 500)
      )
        throw new EvaluationInputError(
          "findings must be an array within its limit",
          { line },
        );
      const findings = item.findings.map((finding: unknown) =>
        predictedFinding(finding, line),
      );
      if (
        new Set(findings.map((finding) => finding.id)).size !== findings.length
      )
        throw new EvaluationInputError("duplicate predicted finding id", {
          line,
        });
      const durationMs = item.durationMs ?? 0;
      if (
        typeof durationMs !== "number" ||
        !Number.isFinite(durationMs) ||
        durationMs < 0
      )
        throw new EvaluationInputError(
          "durationMs must be finite and non-negative",
          { line },
        );
      const errorCategory =
        item.errorCategory === undefined || item.errorCategory === null
          ? null
          : inputText(item.errorCategory, "errorCategory", 100, line);
      if (errorCategory !== null && findings.length)
        throw new EvaluationInputError(
          "failed predictions must not contain partially publishable findings",
          { line },
        );
      return {
        version: 1,
        caseId,
        findings,
        durationMs,
        inputTokens: inputCount(item.inputTokens ?? 0, "inputTokens", line),
        outputTokens: inputCount(item.outputTokens ?? 0, "outputTokens", line),
        costMicros:
          item.costMicros === undefined || item.costMicros === null
            ? null
            : inputCount(item.costMicros, "costMicros", line),
        errorCategory,
      };
    },
  );
  const hash = evaluationHash({
    ...normalized,
    records: [...records].sort((left, right) =>
      compareEvaluationText(left.caseId, right.caseId),
    ),
  });
  return { version: 1, ...normalized, hash, records };
}

export function predictionJsonl(run: PredictionRun): string {
  return (
    run.records.map((record) => JSON.stringify(record)).join("\n") +
    (run.records.length ? "\n" : "")
  );
}
