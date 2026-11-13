/**
 * 模型：读取角色候选并判断专家审查是否启用。
 * 调用示例：await loadCandidates("pr_review")。
 * 仅拆分内部实现；任务与数据契约保持兼容，依赖在下方显式列出。
 */
import { desc, eq } from "drizzle-orm";
import {
  BOOLEAN_DEFAULTS,
  parseBool,
} from "../../../packages/config/src/index.js";
import {
  loadSettings,
  modelRolePolicies,
  type DatabaseClient,
} from "../../../packages/database/src/index.js";
import {
  type ModelCandidate,
  type ModelRole,
} from "../../../packages/domain/src/index.js";
import { database, logger } from "./runtime.js";

/** A model role policy row; `expert_review` is an optional agent-team role. */
type PolicyRole =
  ModelRole | "expert_review" | "spam_detection" | "issue_analysis_vision";

export async function loadCandidates(
  role: PolicyRole,
): Promise<ModelCandidate[]> {
  const rows = await database.db
    .select({ candidates: modelRolePolicies.candidates })
    .from(modelRolePolicies)
    .where(eq(modelRolePolicies.role, role))
    .orderBy(desc(modelRolePolicies.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row || !Array.isArray(row.candidates)) return [];
  const candidates: ModelCandidate[] = [];
  for (const entry of row.candidates) {
    if (typeof entry !== "object" || entry === null) continue;
    const value = entry as Record<string, unknown>;
    if (
      typeof value.provider === "string" &&
      typeof value.model === "string" &&
      typeof value.accountName === "string"
    ) {
      candidates.push({
        provider: value.provider,
        model: value.model,
        accountName: value.accountName,
      });
    }
  }
  return candidates;
}

/**
 * Whether the Agent 专家团队 pipeline is active: the `agent_team_enabled`
 * runtime setting must be "true" AND an `expert_review` model role policy with
 * candidates must exist. A database failure degrades to "disabled" rather than
 * breaking the worker.
 */
export async function isExpertTeamEnabled(
  db: DatabaseClient,
): Promise<boolean> {
  try {
    const [flag, policy] = await Promise.all([
      loadSettings(db.db, ["agent_team_enabled"]),
      db.db
        .select({ candidates: modelRolePolicies.candidates })
        .from(modelRolePolicies)
        .where(eq(modelRolePolicies.role, "expert_review"))
        .orderBy(desc(modelRolePolicies.createdAt))
        .limit(1),
    ]);
    if (
      !parseBool(
        flag.get("agent_team_enabled"),
        BOOLEAN_DEFAULTS.agent_team_enabled ?? false,
      )
    )
      return false;
    const candidates = policy[0]?.candidates;
    return Array.isArray(candidates) && candidates.length > 0;
  } catch (error) {
    logger.warn({ err: error }, "expert team flag check failed; disabled");
    return false;
  }
}
