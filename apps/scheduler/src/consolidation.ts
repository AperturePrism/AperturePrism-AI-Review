import { and, desc, eq, isNotNull } from "drizzle-orm";
import {
  createCredentialCipher,
  loadConfig,
} from "../../../packages/config/src/index.js";
import {
  getRepoMemorySummary,
  listUnconsolidatedReflections,
  markReflectionsConsolidated,
  modelRolePolicies,
  providerAccounts,
  repoMemory,
  writeRepoMemory,
  type DatabaseClient,
} from "../../../packages/database/src/index.js";
import {
  ModelInvocationError,
  type ModelCandidate,
  type ModelProviderAdapter,
  type ModelRole,
} from "../../../packages/domain/src/index.js";
import { createLogger } from "../../../packages/observability/src/index.js";
import {
  createOpenAICompatibleAdapter,
  routeModelInvocation,
} from "../../../packages/model-router/src/index.js";

/**
 * Memory-consolidation agent: turns a repository's raw reflections (distilled
 * outcomes of completed issue analyses / PR reviews) into durable rules and
 * knowledge that are later fed back into analysis/review contexts. Shared by
 * the scheduler (periodic sweep) and the API (manual trigger).
 */

type Logger = ReturnType<typeof createLogger>;

const CONSOLIDATION_SYSTEM_PROMPT = `你是一个仓库经验沉淀助手。给定一个仓库的若干「未合并反思」（来自历史 Issue 分析与 PR 审查的结论片段）以及该仓库已有的「已沉淀规则/知识」，请提炼出 1-3 条可长期复用的规则或经验。

输出必须严格符合以下契约（JSON 数组，不要输出任何解释、Markdown 代码块或额外文字）：
[ { "title": "不超过 40 字的标题", "content": "简洁中文说明，不超过 500 字", "kind": "rule" | "knowledge" } ]

规则：
- kind=rule：明确的约束/规范（例如“新增异步逻辑必须显式处理错误，禁止静默吞掉”）。
- kind=knowledge：项目背景或常见模式（例如“该项目基于 XX 框架，XXX 模块负责 XXX”）。
- 只提炼有普遍价值、可复用到后续分析与审查的内容；过于具体的一次性结论不要收录。
- 若反思之间冲突，以事实依据更充分者为准。
- 若没有值得沉淀的内容，可返回空数组 []。`;

const consolidationRetryPolicy = {
  maxAttemptsPerCandidate: 1,
  baseDelayMs: 500,
  maxDelayMs: 5_000,
};

type ConsolidationEntry = {
  title: string;
  content: string;
  kind: "rule" | "knowledge";
};

/** Parses the model's JSON-array contract; malformed output yields []. */
export function parseConsolidationJson(text: string): ConsolidationEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: ConsolidationEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const value = item as Record<string, unknown>;
    const title = typeof value.title === "string" ? value.title.trim() : "";
    const content =
      typeof value.content === "string" ? value.content.trim() : "";
    const kind =
      value.kind === "rule" || value.kind === "knowledge" ? value.kind : null;
    if (title.length > 0 && content.length > 0 && kind) {
      entries.push({ title, content, kind });
      if (entries.length >= 3) break;
    }
  }
  return entries;
}

async function loadCandidates(
  client: DatabaseClient,
  role: ModelRole,
): Promise<ModelCandidate[]> {
  const rows = await client.db
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
 * Merges the unconsolidated reflections of every repository with pending
 * memory. Returns how many repositories were processed and how many durable
 * rules/knowledge entries were written. Failures are logged per repository;
 * the sweep never throws (so the scheduler loop and the API stay alive).
 */
export async function memoryConsolidationSweep(
  client: DatabaseClient,
  logger: Logger,
): Promise<{ repositories: number; rules: number }> {
  const config = loadConfig(process.env);
  const cipher = config.credentialMasterKey
    ? createCredentialCipher(config.credentialMasterKey)
    : null;
  const resolveApiKey = async (accountName: string): Promise<string> => {
    if (!cipher)
      throw new ModelInvocationError(
        "authentication_failed",
        "provider credentials are not configured",
      );
    const rows = await client.db
      .select({ encryptedCredential: providerAccounts.encryptedCredential })
      .from(providerAccounts)
      .where(eq(providerAccounts.name, accountName))
      .limit(1);
    const row = rows[0];
    if (!row)
      throw new ModelInvocationError(
        "authentication_failed",
        `no provider credential for account ${accountName}`,
      );
    return cipher.open(row.encryptedCredential);
  };
  const adapters = new Map<string, ModelProviderAdapter>();
  for (const [provider, baseUrl] of Object.entries(
    config.modelProviderBaseUrls,
  )) {
    adapters.set(
      provider,
      createOpenAICompatibleAdapter({ provider, baseUrl, resolveApiKey }),
    );
  }
  const candidates = await loadCandidates(client, "memory_consolidation");
  if (candidates.length === 0) {
    candidates.push(...(await loadCandidates(client, "issue_analysis")));
  }
  if (candidates.length === 0 || adapters.size === 0) {
    logger.warn(
      "memory consolidation skipped: no model candidates/adapters configured",
    );
    return { repositories: 0, rules: 0 };
  }

  const repoRows = await client.db
    .selectDistinct({ repositoryId: repoMemory.repositoryId })
    .from(repoMemory)
    .where(
      and(
        eq(repoMemory.kind, "reflection"),
        eq(repoMemory.consolidated, false),
        isNotNull(repoMemory.repositoryId),
      ),
    );

  let repositories = 0;
  let rules = 0;
  for (const row of repoRows) {
    const repositoryId = row.repositoryId;
    if (!repositoryId) continue;
    try {
      const reflections = await listUnconsolidatedReflections(client.db, {
        repositoryId,
        limit: 20,
      });
      if (reflections.length === 0) continue;
      const existing = await getRepoMemorySummary(client.db, repositoryId);
      const reflectionText = reflections
        .map(
          (entry) =>
            `- [${entry.sourceType ?? "unknown"}] ${entry.sourceRef ?? ""} ${entry.title}\n  ${entry.content}`,
        )
        .join("\n\n");
      const result = await routeModelInvocation(adapters, {
        candidates,
        request: {
          messages: [
            { role: "system", content: CONSOLIDATION_SYSTEM_PROMPT },
            {
              role: "user",
              content:
                `仓库已有规则/知识：\n${existing.length > 0 ? existing : "（无）"}\n\n` +
                `待合并反思：\n${reflectionText}\n\n请输出 JSON 数组。`,
            },
          ],
          responseFormat: "json",
          maxOutputTokens: 1_500,
          temperature: 0.1,
        },
        deadlineMs: 90_000,
        retryPolicy: consolidationRetryPolicy,
      });
      const entries = parseConsolidationJson(result.response.content);
      for (const entry of entries) {
        await writeRepoMemory(client.db, {
          repositoryId,
          kind: entry.kind,
          title: entry.title,
          content: entry.content,
          sourceType: "consolidation",
          consolidated: true,
        });
        rules += 1;
      }
      await markReflectionsConsolidated(
        client.db,
        reflections.map((entry) => entry.id),
      );
      repositories += 1;
      logger.info(
        {
          repositoryId,
          reflections: reflections.length,
          rules: entries.length,
        },
        "memory consolidation completed",
      );
    } catch (error) {
      logger.warn(
        { err: error, repositoryId },
        "memory consolidation for repository failed",
      );
    }
  }
  return { repositories, rules };
}
