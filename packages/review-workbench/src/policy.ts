/**
 * 审查策略：版本只追加，切换版本不会改写历史。
 * @example createPolicy(context, {name:'生产门禁', rules:{blockedSeverities:['high']}});
 */
import type { Policy, PolicyRules, PolicyVersion } from "./types.js";
import { audit, identity, touch, type CommandContext } from "./audit.js";
import {
  array,
  boolean,
  choice,
  confidence,
  findRecord,
  integer,
  object,
  optionalText,
  revision,
  severities,
  strings,
  text,
  WorkbenchError,
} from "./utils/input.js";

export const DEFAULT_POLICY_RULES: PolicyRules = {
  blockedSeverities: ["critical", "high"],
  maxNewFindings: 20,
  minConfidence: 0.7,
  requireBaseline: false,
  requireHumanApproval: false,
  includePaths: [],
  excludePaths: [],
  labels: [],
};

/** 模板是项目自带策略，不能带出任何用户的仓库数据。 */
export function policyTemplates(): {
  id: string;
  name: string;
  description: string;
  rules: PolicyRules;
}[] {
  return [
    {
      id: "balanced",
      name: "均衡审查",
      description: "阻止高风险发现，允许低风险建议逐步处理。",
      rules: structuredClone(DEFAULT_POLICY_RULES),
    },
    {
      id: "strict",
      name: "生产严格门禁",
      description: "新增中高风险发现阻止通过，并要求人工确认。",
      rules: {
        ...structuredClone(DEFAULT_POLICY_RULES),
        blockedSeverities: ["critical", "high", "medium"],
        maxNewFindings: 0,
        requireBaseline: true,
        requireHumanApproval: true,
      },
    },
    {
      id: "advisory",
      name: "观察模式",
      description: "先收集发现和反馈，不把建议当成发布阻断。",
      rules: {
        ...structuredClone(DEFAULT_POLICY_RULES),
        blockedSeverities: [],
        maxNewFindings: 100_000,
        minConfidence: 0,
      },
    },
    {
      id: "security",
      name: "安全优先",
      description: "排除文档和测试夹具，优先处理可执行代码里的安全问题。",
      rules: {
        ...structuredClone(DEFAULT_POLICY_RULES),
        minConfidence: 0.85,
        excludePaths: ["docs/**", "**/*.test.ts", "fixtures/**"],
        labels: ["security"],
      },
    },
  ];
}

/** 合并只发生在入口，保存后的每个版本都有完整规则。 */
export function parsePolicyRules(
  value: unknown,
  previous: PolicyRules = DEFAULT_POLICY_RULES,
): PolicyRules {
  const input = value === undefined ? {} : object(value, "rules");
  const paths = (field: "includePaths" | "excludePaths"): string[] => {
    if (input[field] === undefined) return [...previous[field]];
    const patterns = strings(input[field], field, 100, 500);
    if (
      patterns.some(
        (pattern) =>
          pattern.includes("..") ||
          pattern.startsWith("/") ||
          pattern.includes("\\"),
      )
    ) {
      throw new WorkbenchError("invalid_input", `${field} 只接受仓库相对 glob`);
    }
    return patterns;
  };
  return {
    blockedSeverities:
      input.blockedSeverities === undefined
        ? [...previous.blockedSeverities]
        : [
            ...new Set(
              array(input.blockedSeverities, "blockedSeverities", 5).map(
                (value) => choice(value, "severity", severities),
              ),
            ),
          ],
    maxNewFindings: integer(
      input.maxNewFindings,
      "maxNewFindings",
      0,
      100_000,
      previous.maxNewFindings,
    ),
    minConfidence: confidence(input.minConfidence, previous.minConfidence),
    requireBaseline: boolean(
      input.requireBaseline,
      "requireBaseline",
      previous.requireBaseline,
    ),
    requireHumanApproval: boolean(
      input.requireHumanApproval,
      "requireHumanApproval",
      previous.requireHumanApproval,
    ),
    includePaths: paths("includePaths"),
    excludePaths: paths("excludePaths"),
    labels:
      input.labels === undefined
        ? [...previous.labels]
        : strings(input.labels, "labels", 50, 100),
  };
}

export function createPolicy(
  context: CommandContext,
  input: Record<string, unknown>,
): Policy {
  const name = text(input.name, "name", 200);
  const description = optionalText(input.description, "description", 3000);
  const templateId = optionalText(input.template, "template", 100);
  const template = templateId
    ? policyTemplates().find((item) => item.id === templateId)
    : undefined;
  if (templateId && !template)
    throw new WorkbenchError("invalid_template", "策略模板不存在");
  const rules = parsePolicyRules(input.rules, template?.rules);
  const version: PolicyVersion = {
    version: 1,
    name,
    description,
    rules,
    savedAt: context.now,
    savedBy: context.actor.userId,
    note: optionalText(input.note, "note", 2000),
  };
  const policy: Policy = {
    ...identity(context),
    name,
    description,
    enabled: boolean(input.enabled, "enabled", true),
    activeVersion: 1,
    versions: [version],
  };
  context.data.policies.push(policy);
  audit(context, "policy.created", policy.id, { name, version: 1 });
  return policy;
}

/** 修改策略生成一个新版本；旧审查可以继续定位当时的规则。 */
export function savePolicyVersion(
  context: CommandContext,
  input: Record<string, unknown>,
): Policy {
  const policy = findRecord(
    context.data.policies,
    context.repository,
    input.id,
  );
  revision(policy, input.expectedRevision);
  const current = activePolicyVersion(policy);
  const name =
    input.name === undefined ? current.name : text(input.name, "name", 200);
  const description =
    input.description === undefined
      ? current.description
      : optionalText(input.description, "description", 3000);
  const version: PolicyVersion = {
    version: policy.versions.length + 1,
    name,
    description,
    rules: parsePolicyRules(input.rules, current.rules),
    savedAt: context.now,
    savedBy: context.actor.userId,
    note: optionalText(input.note, "note", 2000),
  };
  policy.versions.push(version);
  policy.activeVersion = version.version;
  policy.name = name;
  policy.description = description;
  touch(context, policy);
  audit(context, "policy.version_saved", policy.id, {
    version: version.version,
  });
  return policy;
}

export function activatePolicyVersion(
  context: CommandContext,
  input: Record<string, unknown>,
): Policy {
  const policy = findRecord(
    context.data.policies,
    context.repository,
    input.id,
  );
  revision(policy, input.expectedRevision);
  const version = integer(input.version, "version", 1, policy.versions.length);
  const selected = policy.versions.find((item) => item.version === version)!;
  policy.activeVersion = version;
  policy.name = selected.name;
  policy.description = selected.description;
  touch(context, policy);
  audit(context, "policy.version_activated", policy.id, { version });
  return policy;
}

export function togglePolicy(
  context: CommandContext,
  input: Record<string, unknown>,
): Policy {
  const policy = findRecord(
    context.data.policies,
    context.repository,
    input.id,
  );
  revision(policy, input.expectedRevision);
  policy.enabled = boolean(input.enabled, "enabled");
  touch(context, policy);
  audit(context, "policy.toggled", policy.id, { enabled: policy.enabled });
  return policy;
}

export function activePolicyVersion(policy: Policy): PolicyVersion {
  return policy.versions.find(
    (version) => version.version === policy.activeVersion,
  )!;
}

/** 比较两个历史版本，让回滚前能看清具体影响。 */
export function comparePolicyVersions(
  context: CommandContext,
  input: Record<string, unknown>,
): {
  from: number;
  to: number;
  changes: { field: string; before: unknown; after: unknown }[];
} {
  const policy = findRecord(
    context.data.policies,
    context.repository,
    input.id,
  );
  const from = integer(input.from, "from", 1, policy.versions.length);
  const to = integer(input.to, "to", 1, policy.versions.length);
  const before = policy.versions.find((version) => version.version === from)!;
  const after = policy.versions.find((version) => version.version === to)!;
  const changes: { field: string; before: unknown; after: unknown }[] = [];
  for (const field of ["name", "description"] as const) {
    if (before[field] !== after[field])
      changes.push({ field, before: before[field], after: after[field] });
  }
  for (const field of Object.keys(before.rules) as (keyof PolicyRules)[]) {
    if (
      JSON.stringify(before.rules[field]) !== JSON.stringify(after.rules[field])
    ) {
      changes.push({
        field: `rules.${field}`,
        before: before.rules[field],
        after: after.rules[field],
      });
    }
  }
  return { from, to, changes };
}
