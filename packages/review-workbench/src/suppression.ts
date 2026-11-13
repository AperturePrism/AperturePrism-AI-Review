/**
 * 有期限的忽略规则。必须写明原因和至少一个匹配条件，不能误建全库忽略。
 * @example createSuppression(context, {name:'已接受兼容风险', reason:'旧客户端下线后移除', ruleId:'legacy-auth', expiresAt:'2027-01-01T00:00:00Z'});
 */
import type { Finding, Suppression } from "./types.js";
import { audit, identity, touch, type CommandContext } from "./audit.js";
import {
  array,
  boolean,
  choice,
  findRecord,
  globMatches,
  optionalText,
  revision,
  severities,
  text,
  timestamp,
  WorkbenchError,
} from "./utils/input.js";

export function createSuppression(
  context: CommandContext,
  input: Record<string, unknown>,
): Suppression {
  const fingerprint = optionalText(input.fingerprint, "fingerprint", 200);
  const ruleId = optionalText(input.ruleId, "ruleId", 200);
  const pathPattern = optionalText(input.pathPattern, "pathPattern", 500);
  if (!fingerprint && !ruleId && !pathPattern) {
    throw new WorkbenchError(
      "empty_suppression",
      "忽略规则至少需要指纹、规则名称或路径条件之一",
    );
  }
  if (
    pathPattern.startsWith("/") ||
    pathPattern.includes("..") ||
    pathPattern.includes("\\")
  ) {
    throw new WorkbenchError(
      "invalid_input",
      "pathPattern 必须为仓库相对 glob",
    );
  }
  const expiresAt =
    input.expiresAt === undefined ||
    input.expiresAt === null ||
    input.expiresAt === ""
      ? null
      : timestamp(input.expiresAt, "expiresAt");
  if (expiresAt !== null && expiresAt <= context.now)
    throw new WorkbenchError(
      "invalid_expiration",
      "忽略规则的到期时间必须在未来",
    );
  const suppression: Suppression = {
    ...identity(context),
    name: text(input.name, "name", 200),
    reason: text(input.reason, "reason", 3000),
    enabled: boolean(input.enabled, "enabled", true),
    fingerprint,
    ruleId,
    pathPattern,
    severities:
      input.severities === undefined
        ? []
        : [
            ...new Set(
              array(input.severities, "severities", 5).map((item) =>
                choice(item, "severity", severities),
              ),
            ),
          ],
    expiresAt,
  };
  context.data.suppressions.push(suppression);
  audit(context, "suppression.created", suppression.id, {
    expiresAt,
    ruleId,
    pathPattern,
  });
  return suppression;
}

export function toggleSuppression(
  context: CommandContext,
  input: Record<string, unknown>,
): Suppression {
  const suppression = findRecord(
    context.data.suppressions,
    context.repository,
    input.id,
  );
  revision(suppression, input.expectedRevision);
  suppression.enabled = boolean(input.enabled, "enabled");
  touch(context, suppression);
  audit(context, "suppression.toggled", suppression.id, {
    enabled: suppression.enabled,
  });
  return suppression;
}

/** 续期需要新的理由，并记录到审计；不会悄悄延长已接受的风险。 */
export function renewSuppression(
  context: CommandContext,
  input: Record<string, unknown>,
): Suppression {
  const suppression = findRecord(
    context.data.suppressions,
    context.repository,
    input.id,
  );
  revision(suppression, input.expectedRevision);
  const expiresAt = timestamp(input.expiresAt, "expiresAt");
  if (expiresAt <= context.now)
    throw new WorkbenchError("invalid_expiration", "到期时间必须在未来");
  suppression.reason = text(input.reason, "reason", 3000);
  suppression.expiresAt = expiresAt;
  suppression.enabled = true;
  touch(context, suppression);
  audit(context, "suppression.renewed", suppression.id, { expiresAt });
  return suppression;
}

/** 所有已填条件都必须满足；不同条件之间不是“或”。 */
export function matchingSuppression(
  finding: Finding,
  suppressions: readonly Suppression[],
  now: string,
): Suppression | null {
  for (const suppression of suppressions) {
    if (suppression.repository !== finding.repository || !suppression.enabled)
      continue;
    if (suppression.expiresAt !== null && suppression.expiresAt <= now)
      continue;
    if (
      suppression.fingerprint &&
      suppression.fingerprint !== finding.fingerprint
    )
      continue;
    if (suppression.ruleId && suppression.ruleId !== finding.ruleId) continue;
    if (
      suppression.pathPattern &&
      !globMatches(suppression.pathPattern, finding.path)
    )
      continue;
    if (
      suppression.severities.length &&
      !suppression.severities.includes(finding.severity)
    )
      continue;
    return suppression;
  }
  return null;
}

/** 创建前预览影响；不会把预览结果写入任何发现。 */
export function previewSuppression(
  context: CommandContext,
  input: Record<string, unknown>,
): { matched: number; findingIds: string[]; expired: boolean } {
  const suppression = findRecord(
    context.data.suppressions,
    context.repository,
    input.id,
  );
  const matches = context.data.findings.filter((finding) =>
    matchingSuppression(finding, [suppression], context.now),
  );
  return {
    matched: matches.length,
    findingIds: matches.map((finding) => finding.id),
    expired:
      suppression.expiresAt !== null && suppression.expiresAt <= context.now,
  };
}
