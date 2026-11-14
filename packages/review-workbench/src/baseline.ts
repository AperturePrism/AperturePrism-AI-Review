/**
 * 基线保存一次已知发现集合，后续审查只阻断新风险。
 * @example createBaseline(context, {name:'主分支', reference:'main', fromCurrentFindings:true});
 */
import type { Baseline, BaselineFinding } from "./types.js";
import { audit, identity, touch, type CommandContext } from "./audit.js";
import { findingFingerprint } from "./finding.js";
import {
  array,
  boolean,
  choice,
  findRecord,
  integer,
  object,
  optionalText,
  revision,
  severities,
  sourcePath,
  text,
  WorkbenchError,
} from "./utils/input.js";

/** 基线保存风险定位信息，不包含完整模型回复或源码。 */
export function parseBaselineFindings(value: unknown): BaselineFinding[] {
  const findings = array(value, "findings", 20_000).map((raw) => {
    const input = object(raw, "finding");
    const title = text(input.title, "title", 500);
    const ruleId = text(input.ruleId, "ruleId", 200);
    const path = sourcePath(input.path);
    return {
      fingerprint:
        input.fingerprint === undefined
          ? findingFingerprint(ruleId, path, title)
          : text(input.fingerprint, "fingerprint", 200),
      ruleId,
      path,
      title,
      line: integer(input.line, "line", 1, 100_000_000, 1),
      severity: choice(input.severity, "severity", severities, "medium"),
    };
  });
  const seen = new Set<string>();
  return findings.filter((finding) => {
    if (seen.has(finding.fingerprint)) return false;
    seen.add(finding.fingerprint);
    return true;
  });
}

export function createBaseline(
  context: CommandContext,
  input: Record<string, unknown>,
): Baseline {
  const fromCurrent = boolean(
    input.fromCurrentFindings,
    "fromCurrentFindings",
    false,
  );
  const findings = fromCurrent
    ? context.data.findings
        .filter(
          (item) =>
            item.repository === context.repository &&
            !["fixed", "false_positive"].includes(item.status),
        )
        .map(({ fingerprint, ruleId, path, title, line, severity }) => ({
          fingerprint,
          ruleId,
          path,
          title,
          line,
          severity,
        }))
    : parseBaselineFindings(input.findings ?? []);
  const baseline: Baseline = {
    ...identity(context),
    name: text(input.name, "name", 200),
    reference: text(input.reference, "reference", 500),
    active: boolean(input.active, "active", false),
    archived: false,
    findings,
    note: optionalText(input.note, "note", 3000),
  };
  if (baseline.active) {
    for (const previous of context.data.baselines) {
      if (previous.repository === context.repository && previous.active) {
        previous.active = false;
        touch(context, previous);
      }
    }
  }
  context.data.baselines.push(baseline);
  audit(context, "baseline.created", baseline.id, {
    findings: findings.length,
    reference: baseline.reference,
    active: baseline.active,
  });
  return baseline;
}

/** 一个仓库只有一个活动基线；激活操作与旧基线停用在同一事务。 */
export function activateBaseline(
  context: CommandContext,
  input: Record<string, unknown>,
): Baseline {
  const baseline = findRecord(
    context.data.baselines,
    context.repository,
    input.id,
  );
  revision(baseline, input.expectedRevision);
  if (baseline.archived)
    throw new WorkbenchError("baseline_archived", "归档基线不能激活", 409);
  for (const previous of context.data.baselines) {
    if (
      previous.repository === context.repository &&
      previous.active &&
      previous.id !== baseline.id
    ) {
      previous.active = false;
      touch(context, previous);
    }
  }
  baseline.active = true;
  touch(context, baseline);
  audit(context, "baseline.activated", baseline.id);
  return baseline;
}

/** 归档保留历史，避免旧报告中的基线引用失效。 */
export function archiveBaseline(
  context: CommandContext,
  input: Record<string, unknown>,
): Baseline {
  const baseline = findRecord(
    context.data.baselines,
    context.repository,
    input.id,
  );
  revision(baseline, input.expectedRevision);
  baseline.archived = true;
  baseline.active = false;
  touch(context, baseline);
  audit(context, "baseline.archived", baseline.id);
  return baseline;
}

export interface BaselineComparison {
  baselineId: string;
  added: BaselineFinding[];
  existing: BaselineFinding[];
  resolved: BaselineFinding[];
  severityChanges: { fingerprint: string; previous: string; current: string }[];
}

/** 同一问题升到更高严重度时单独标记，不能躲在“旧问题”里。 */
export function compareBaseline(
  context: CommandContext,
  input: Record<string, unknown>,
): BaselineComparison {
  const baseline = findRecord(
    context.data.baselines,
    context.repository,
    input.id,
  );
  const current =
    input.findings === undefined
      ? context.data.findings.filter(
          (item) =>
            item.repository === context.repository &&
            !["fixed", "false_positive"].includes(item.status),
        )
      : parseBaselineFindings(input.findings);
  const old = new Map(
    baseline.findings.map((finding) => [finding.fingerprint, finding]),
  );
  const present = new Set(current.map((finding) => finding.fingerprint));
  const result: BaselineComparison = {
    baselineId: baseline.id,
    added: [],
    existing: [],
    resolved: baseline.findings.filter(
      (finding) => !present.has(finding.fingerprint),
    ),
    severityChanges: [],
  };
  for (const finding of current) {
    const previous = old.get(finding.fingerprint);
    if (!previous) {
      result.added.push(finding);
      continue;
    }
    result.existing.push(finding);
    if (previous.severity !== finding.severity)
      result.severityChanges.push({
        fingerprint: finding.fingerprint,
        previous: previous.severity,
        current: finding.severity,
      });
  }
  return result;
}
