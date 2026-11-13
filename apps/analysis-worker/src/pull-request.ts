import { PrContextRevisionError } from "../../../packages/pr-review/src/context-build.js";
import {
  assessReviewWithChecks,
  assessedReview,
} from "../../../packages/pr-review/src/assessment.js";
/**
 * PR：构建上下文、调用审查、发布结果与保存审查历史。
 * 用法：createPullRequestWorkflow({github, adapters, expertTeamEnabled, expertReviewCandidates, reviewCandidates})(task, signal)。
 */

import { eq } from "drizzle-orm";
import {
  runExpertReview,
  selectSkills,
} from "../../../packages/agent-capabilities/src/index.js";
import {
  systemSettings,
  writeRepoMemory,
} from "../../../packages/database/src/index.js";
import {
  type ModelCandidate,
  type ModelMessage,
  type ModelProviderAdapter,
} from "../../../packages/domain/src/index.js";
import { type GitHubClient } from "../../../packages/github-adapter/src/index.js";
import {
  buildPrContext,
  publishAssessment,
  renderPrContextText,
  renderReviewBody,
  reviewPullRequest,
  type PrReviewContext,
} from "../../../packages/pr-review/src/index.js";
import { recordAttemptUsage } from "../../../packages/task-engine/src/index.js";
import { beginCheckRun } from "./check-run.js";
import { queueReviewedAutoMerge } from "./auto-merge.js";
import { assertGithub } from "./github.js";
import { type TaskHandler } from "./loop.js";
import { repoMemoryText, resolveRepositoryId } from "./memory.js";
import { createPrReviewHandler } from "./pr-review-handler.js";
import { prReviewConfig, resolveReviewBudget } from "./preferences.js";
import { persistSubjectResult, publicationStore } from "./publication.js";
import { withPrReviewRules } from "./review-rules.js";
import { loadRepoRules } from "./rules.js";
import {
  database,
  logger,
  reviewWorkbench,
  reviewAutomation,
  shutdown,
  workerId,
} from "./runtime.js";
import { prIdentity } from "./task.js";
import {
  queueReviewWorkbenchSync,
  reviewSourceSequence,
  replayReviewWorkbenchSync,
} from "./workbench.js";

// --- 增量审查续跑：按仓库+PR 持久化最近的审查对话，供下一次 push 续跑 ---
const REVIEW_HISTORY_PREFIX = "pr_review_history:";

async function loadReviewHistory(
  repoFullName: string,
  number: number,
  currentRevision: string,
): Promise<readonly ModelMessage[] | undefined> {
  try {
    const rows = await database.db
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(
        eq(
          systemSettings.key,
          `${REVIEW_HISTORY_PREFIX}${repoFullName}:${number}`,
        ),
      )
      .limit(1);
    const raw = rows[0]?.value;
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as {
      revision?: string;
      messages?: ModelMessage[];
    };
    // 已是同一 revision，无需续跑。
    if (parsed.revision === currentRevision) return undefined;
    if (!Array.isArray(parsed.messages) || parsed.messages.length === 0)
      return undefined;
    return parsed.messages;
  } catch {
    return undefined;
  }
}

async function persistReviewHistory(
  repoFullName: string,
  number: number,
  revision: string,
  messages: readonly ModelMessage[],
): Promise<void> {
  const capped = messages.slice(-40).map((m) => ({
    role: m.role,
    content:
      m.content.length > 4_000 ? `${m.content.slice(0, 4_000)}…` : m.content,
  }));
  const key = `${REVIEW_HISTORY_PREFIX}${repoFullName}:${number}`;
  const value = JSON.stringify({ revision, messages: capped });
  await database.db
    .insert(systemSettings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value, updatedAt: new Date() },
    });
}

export type PullRequestWorkflowInput = {
  github: GitHubClient | null;
  adapters: Map<string, ModelProviderAdapter>;
  expertTeamEnabled: boolean;
  expertReviewCandidates: ModelCandidate[];
  reviewCandidates: ModelCandidate[];
};

/** 为当前已刷新凭据的任务创建工作流，调用过程不会保留旧GitHub客户端。 */
export function createPullRequestWorkflow(
  input: PullRequestWorkflowInput,
): TaskHandler {
  const {
    github,
    adapters,
    expertTeamEnabled,
    expertReviewCandidates,
    reviewCandidates,
  } = input;

  const prReviewHandler = createPrReviewHandler({
    buildContext: async (task, signal) => {
      if (!github) throw new Error("GitHub App is not configured");
      const { payload, identity } = prIdentity(task);
      const [context, repoMemory, repoRules] = await Promise.all([
        buildPrContext(
          github,
          {
            installationId: payload.installationId,
            owner: identity.owner,
            name: identity.name,
            pullNumber: payload.subjectNumber,
            expectedRevision: payload.subjectRevision,
          },
          undefined,
          signal,
        ),
        repoMemoryText(payload.repositoryFullName),
        loadRepoRules(
          github,
          payload.repositoryFullName,
          {
            installationId: payload.installationId,
            owner: identity.owner,
            name: identity.name,
          },
          signal,
        ),
      ]);
      const history = await loadReviewHistory(
        payload.repositoryFullName,
        payload.subjectNumber,
        payload.subjectRevision ?? "HEAD",
      );
      const contextWithRules = withPrReviewRules(context, repoRules);
      return {
        ...contextWithRules,
        ...(repoMemory
          ? {
              repoMemory,
              rendered: {
                ...contextWithRules.rendered,
                repoMemory,
              },
            }
          : {}),
        ...(history ? { reviewHistory: history } : {}),
        toolsContext: {
          client: github,
          installationId: payload.installationId,
          owner: identity.owner,
          name: identity.name,
          ref: payload.subjectRevision ?? "HEAD",
        },
      };
    },

    review: async (context: PrReviewContext, signal) => {
      const renderedText = renderPrContextText(context.rendered);
      // issue #102：审查时间预算可用 pr_review_deadline_seconds 在线调整。
      const budget = await resolveReviewBudget();
      if (expertTeamEnabled) {
        const expertOutcome = await runExpertReview(
          {
            adapters,
            // Prefer expert_review candidates; fall back to pr_review's.
            candidates:
              expertReviewCandidates.length > 0
                ? expertReviewCandidates
                : reviewCandidates,
            deadlineMs: budget.deadlineMs,
            retryPolicy: budget.retryPolicy,
            signal,
          },
          {
            appliesTo: "pr",
            rendered: renderedText,
            skills: selectSkills("pr", renderedText),
          },
        );
        if (expertOutcome.outcome !== "valid") return expertOutcome;
        return {
          ...expertOutcome,
          assessment: await assessReviewWithChecks(
            expertOutcome.review,
            context.rendered,
          ),
        };
      }
      const outcome = await reviewPullRequest(
        {
          adapters,
          candidates: reviewCandidates,
          deadlineMs: budget.deadlineMs,
          retryPolicy: budget.retryPolicy,
          signal,
          ...(context.toolsContext
            ? { tools: { context: context.toolsContext } }
            : {}),
          ...(context.reviewHistory ? { history: context.reviewHistory } : {}),
        },
        context.rendered,
      );
      // 持久化本次审查对话，供下一次 push 增量续跑。
      if (outcome.messages && context.toolsContext) {
        const { owner, name } = context.toolsContext;
        const revision = context.toolsContext.ref;
        void persistReviewHistory(
          `${owner}/${name}`,
          context.pullRequest.number,
          revision,
          outcome.messages,
        ).catch((error: unknown) =>
          logger.warn({ err: error }, "persist review history failed"),
        );
      }
      return outcome;
    },

    publishFinal: async (task, review, signal, assessment) => {
      signal.throwIfAborted();
      const { payload, identity } = prIdentity(task);
      const githubClient = assertGithub(github);
      const cfg = await prReviewConfig();
      const current = await githubClient.getPullRequest(
        {
          installationId: payload.installationId,
          owner: identity.owner,
          name: identity.name,
          number: payload.subjectNumber,
        },
        signal,
      );
      if (current.headSha !== payload.subjectRevision)
        throw new PrContextRevisionError(
          payload.subjectRevision,
          current.headSha,
        );
      const sourceSequence = await reviewSourceSequence(database.sql, task);
      signal.throwIfAborted();
      if (cfg.autoReview) {
        // 正式 review（含行内 comments），幂等；行内锚点失败自动降级。
        await publishAssessment({
          store: publicationStore,
          github: {
            publishReview: ({
              installationId,
              owner,
              name,
              pullNumber,
              revision,
              body,
              event,
              comments,
            }) =>
              githubClient.createPullRequestReview(
                {
                  installationId,
                  owner,
                  name,
                  pullNumber,
                  commitId: revision,
                  body,
                  event,
                  ...(comments && comments.length > 0 ? { comments } : {}),
                },
                signal,
              ),
          },
          signal,
          taskId: task.id,
          installationId: payload.installationId,
          owner: identity.owner,
          name: identity.name,
          pullNumber: payload.subjectNumber,
          revision: payload.subjectRevision,
          review,
          ...(assessment ? { assessment } : {}),
        });
      } else {
        // 自动审查关闭：不提交正式 review，只发一条摘要评论（幂等）。
        const key = `pr-comment:${identity.owner}/${identity.name}#${payload.subjectNumber}:${payload.subjectRevision}`;
        const existing = await publicationStore.findExternalObjectId(key);
        if (existing === null) {
          const comment = await githubClient.createIssueComment(
            {
              installationId: payload.installationId,
              owner: identity.owner,
              name: identity.name,
              number: payload.subjectNumber,
              body: renderReviewBody(review, assessment),
            },
            signal,
          );
          await publicationStore.insert({
            taskId: task.id,
            idempotencyKey: key,
            externalObjectId: String(comment.id),
            channel: "github_issue_comment",
          });
        } else {
          await publicationStore.touch(key);
        }
      }
      signal.throwIfAborted();
      await persistSubjectResult({
        taskId: task.id,
        subjectType: "pr",
        subjectNumber: payload.subjectNumber,
        repositoryFullName: payload.repositoryFullName,
        revision: payload.subjectRevision,
        result: { ...review, ...(assessment ? { assessment } : {}) },
        execution: task,
      });
      // 先写持久 outbox，再异步交付；工作台暂时不可用不会丢掉同步任务。
      await queueReviewWorkbenchSync(database.sql, task.id, {
        repository: payload.repositoryFullName,
        reference: payload.subjectRevision,
        sourceSequence,
        pullNumber: payload.subjectNumber,
        review: assessment ? assessedReview(assessment) : review,
        workerId,
        deliveryKey: `${task.id}:${task.attemptId ?? `${task.leaseOwner}:${task.heartbeatAt.toISOString()}`}`,
        resolveMissing:
          assessment !== undefined &&
          assessment.coverage.changedLineRatio === 1 &&
          assessment.coverage.completeFiles ===
            assessment.coverage.totalFiles &&
          assessment.excluded.length === 0 &&
          assessment.suppressions.suppressed.length === 0,
      });
      await replayReviewWorkbenchSync(database.sql, reviewWorkbench, {
        automation: reviewAutomation,
        signal: shutdown.signal,
        onError: (error) =>
          logger.warn(
            { err: error, taskId: task.id },
            "review workbench sync deferred",
          ),
      });
      const repositoryId = await resolveRepositoryId(
        payload.repositoryFullName,
      );
      if (repositoryId)
        await queueReviewedAutoMerge(
          database.db,
          {
            taskId: task.id,
            repositoryId,
            installationId: payload.installationId,
            repositoryFullName: payload.repositoryFullName,
            pullNumber: payload.subjectNumber,
            headSha: payload.subjectRevision,
            result: { ...review, ...(assessment ? { assessment } : {}) },
          },
          signal,
        );
    },

    beginCheckRun: async (task) => {
      const cfg = await prReviewConfig();
      if (!cfg.checkRun) return;
      const { payload, identity } = prIdentity(task);
      await beginCheckRun({
        db: database.db,
        github: assertGithub(github),
        taskId: task.id,
        installationId: payload.installationId,
        owner: identity.owner,
        name: identity.name,
        pullNumber: payload.subjectNumber,
        revision: payload.subjectRevision,
      });
    },

    // The scheduler finalizes persisted Check Runs only after the task reaches
    // a committed terminal state. Do not close one here before completion: a
    // late worker finish can otherwise overwrite cancellation or be lost on a
    // transient GitHub failure with no durable retry.

    recordUsage: async (task, outcome) => {
      const lastAttempt = outcome.attempts.at(-1);
      const recorded = await recordAttemptUsage(database.db, {
        taskId: task.id,
        workerId,
        attemptNumber: task.attemptNumber,
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        durationMs: outcome.durationMs,
        provider: lastAttempt?.candidate.provider ?? "",
        model: lastAttempt?.candidate.model ?? "",
      });
      if (!recorded)
        throw new DOMException(
          "Task attempt no longer owns its lease",
          "AbortError",
        );
    },

    recordMemory: async (task, review) => {
      try {
        const { payload } = prIdentity(task);
        const repositoryId = await resolveRepositoryId(
          payload.repositoryFullName,
        );
        const findings = review.findings
          .slice(0, 3)
          .map(
            (finding) =>
              `- [${finding.severity}] ${finding.file}: ${finding.message.slice(0, 120)}`,
          )
          .join("\n");
        const content = [
          `总结：${review.summary.slice(0, 200)}`,
          `总体结论：${review.overallTone}；变更 ${review.changedFileCount} 文件（+${review.additions}/-${review.deletions}）`,
          ...(findings.length > 0 ? [`主要发现：\n${findings}`] : []),
        ].join("\n");
        await writeRepoMemory(database.db, {
          repositoryId: repositoryId ?? undefined,
          kind: "reflection",
          title: `PR #${payload.subjectNumber} · ${review.overallTone}`,
          content,
          sourceType: "pr_review",
          sourceRef: `#${payload.subjectNumber}`,
        });
      } catch (error) {
        logger.warn(
          { err: error, taskId: task.id },
          "pr memory reflection skipped",
        );
      }
    },
  });
  return prReviewHandler;
}
