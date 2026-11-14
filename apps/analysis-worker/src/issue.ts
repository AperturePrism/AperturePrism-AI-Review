/**
 * Issue：类别识别、重分析判断、标签、指派与标题。
 * 调用示例：createIssueWorkflow({ github, adapters, issueCandidates, issueVisionCandidates, spamCandidates })(task, signal)。
 * 仅拆分内部实现；任务与数据契约保持兼容，依赖在下方显式列出。
 */
import {
  BOOLEAN_DEFAULTS,
  parseBool,
} from "../../../packages/config/src/index.js";
import {
  type IssueAnalysisResult,
  formatSuggestedTitle,
} from "../../../packages/contracts/src/index.js";
import {
  labelsForAnalysis,
  listLabelRules,
  syncAppliedLabels,
} from "../../../packages/database/src/index.js";
import {
  type SqlTag,
  getIndexedIssueText,
  normalizedIndexText,
} from "../../../packages/duplicate-detection/src/index.js";
import { createGitHubClient } from "../../../packages/github-adapter/src/index.js";
import {
  type IssueContext,
  decideReanalysis,
  isIssueEditEvent,
} from "../../../packages/issue-analysis/src/index.js";
import { resolveRepositoryId } from "./memory.js";
import { issueMinChangeRatio, resolveIssueSettings } from "./preferences.js";
import { database, logger } from "./runtime.js";
import { issueIdentity } from "./task.js";

/** Applies configured label rules to an analyzed issue (idempotent). */
export async function applyConfiguredLabels(input: {
  github: ReturnType<typeof createGitHubClient>;
  installationId: string;
  owner: string;
  name: string;
  issueNumber: number;
  analysis: IssueAnalysisResult;
}): Promise<void> {
  const rules = await listLabelRules(database.db);
  // 标签来源 = 规则引擎匹配（category/severity/priority/quality）∪ 模型建议。
  // 此前模型在评论里输出的「建议标签」从不落到 GitHub（issue #23 用户误解的根源）：
  // 评论说了建议标签、Issue 上却没有。合并后言行一致；GitHub 会对不存在的
  // 标签自动创建。
  const ruleLabels = labelsForAnalysis(
    {
      category: input.analysis.category,
      severity: input.analysis.severity,
      priority: input.analysis.priority,
      quality: input.analysis.quality,
    },
    rules,
  );
  const labels = [
    ...new Set(
      [...ruleLabels, ...input.analysis.suggestedLabels].map((label) =>
        label.trim(),
      ),
    ),
  ].filter((label) => label.length > 0);
  // 契约上限：规则映射 + 模型建议各 ≤10；再兜底一层防爆量。
  const capped = labels.slice(0, 15);
  if (capped.length === 0) return;
  logger.info(
    {
      owner: input.owner,
      name: input.name,
      issueNumber: input.issueNumber,
      labels: capped,
    },
    "applying configured labels",
  );
  await input.github.addIssueLabels({
    installationId: input.installationId,
    owner: input.owner,
    name: input.name,
    number: input.issueNumber,
    labels: capped,
  });
  // issue #31：把实际打上的标签同步进本地标签配置，WebUI「标签配置」页可见。
  // best-effort：失败只告警，不影响打标与分析任务。
  await syncAppliedLabels(database.db, capped).catch((error: unknown) =>
    logger.warn({ err: error }, "applied label sync failed"),
  );
}

/**
 * 判定 Issue 是否属「缺陷类」（bug / security / performance）或「代码审查请求」，
 * 决定是否读仓定位。命中以下任一条即读仓：
 * 1. 缺陷类语义：报错、失败、异常、崩溃、无法、安全、性能等；
 * 2. 代码审查请求：检查/审查/看看某文件或代码的 bug / 错误 / 哪里有问题（即便
 *    未明说 bug，用户点名要挑错也应读仓）。feature 等纯需求描述不误判。
 */
const DEFECT_HINT =
  /bug|fix|fault|defect|error|fail|crash|exception|stack|报错|错误|失败|异常|崩溃|无法|不能|卡死|闪退|坏了|安全|漏洞|泄漏|泄露|性能|慢|卡|风险|review|check|inspect|检查|审查|审阅|看看|哪里错|哪里不对|哪里有问题|哪写错|有问题|帮我看|找.*bug|挑错/i;

const DEFECT_LABEL_HINT = /\b(bug|fault|defect|fix|security|vulnerability)\b/i;

/**
 * 代码引用兜底（#70）：deep 已开启时，标题/正文若引用具体源码文件或扩展名，
 * 说明用户期望结合代码分析，即使类型前缀/标签未命中也读仓。
 */
export const CODE_REFERENCE_HINT =
  /\b[\w./-]+\.(py|js|ts|tsx|jsx|go|rs|java|c|cpp|h|hpp|sh|json|yaml|yml|toml|sql|md)\b|(源码|代码|实现逻辑|在哪(里|儿)|哪一行|报错位置|如何实现|怎么实现)/i;

export function isDefectIssue(context: IssueContext): boolean {
  const issue = context.issue;
  const labels = issue.labels ?? [];
  if (labelsMatchHint(labels, DEFECT_LABEL_HINT)) return true;
  const hay = `${issue.title ?? ""}\n${issue.body ?? ""}`;
  return DEFECT_HINT.test(hay);
}

/**
 * 判定 Issue 是否属「功能请求类」（feature / enhancement），决定是否读仓定位
 * 并给出具体改动位置（issue #56）。标签含 feature/enhancement，或标题/正文
 * 含较强的功能请求语义（新增、支持某能力、希望加…）即命中；与 isDefectIssue
 * 相互独立，任一命中都会触发读仓。
 *
 * 关键词补充（现场反馈）：标题仅写「改进」「功能增加」等常见中文词的 issue
 * 此前全部落空（旧词表只有「新增/优化/增强」），导致 feature=false → 不注入
 * 读源码工具 → 输出通篇「未读取源码，路径待确认」。补 改进/改善/提升/增加/期望。
 */
const FEATURE_HINT =
  /feature|feat|enhancement|enhance|improvement|feature-request|新功能|新需求|功能请求|特性|新增|改进|改善|提升|增强|优化|增加|期望|能否.*(支持|加|添加)|能不能.*(支持|加|添加)|希望.*(支持|加|添加|增加|做|实现|改进|改善|增强)|建议.*(支持|加|添加|增加|做|实现|增强|改进|改善)|加一个|加个|添加.*(功能|支持)|支持.*功能|想要.*(功能|支持)|需求|提议/i;

/** 标题/正文常见类型前缀（GitHub 模板风格），大小写不敏感、可带 severity。 */
const TYPE_PREFIX_HINT =
  /^\[[^\]]*(bug|fix|fault|defect|enhancement|enhance|feature|feat|新功能|优化|需求|问题)[^\]]*\]/i;

/** 标签词边界匹配：兼容 feature-request / Feature Request 等变体（精确 includes 会漏）。 */
function labelsMatchHint(labels: readonly string[], hint: RegExp): boolean {
  return labels.some((label) => hint.test(label));
}

const FEATURE_LABEL_HINT =
  /\b(feature|feat|enhancement|enhance|feature-request)\b/i;

export function isFeatureRequest(context: IssueContext): boolean {
  const issue = context.issue;
  const labels = issue.labels ?? [];
  if (labelsMatchHint(labels, FEATURE_LABEL_HINT)) return true;
  const hay = `${issue.title ?? ""}\n${issue.body ?? ""}`;
  if (TYPE_PREFIX_HINT.test(hay)) return true;
  return FEATURE_HINT.test(hay);
}

/**
 * 编辑 Issue 后是否重新分析。只有 webhook 的 `issues.edited` 受限制：改一个
 * 错别字就重跑完整分析，既花掉一次模型调用，又会用新结论覆盖既有评论。
 *
 * 比较对象是索引任务写进 `issue_documents` 的归一化正文，所以当前正文必须用
 * 同一套 `normalizedIndexText` 归一化 —— 只改图片或链接不会被算成改动。
 *
 * 任何一步失败都按「分析」处理：宁可多花一次调用，也不要静默吞掉真实修改。
 */
export async function shouldReanalyzeIssue(
  task: { payload: unknown },
  context: IssueContext,
): Promise<boolean> {
  if (!isIssueEditEvent(task.payload)) return true;
  try {
    const { payload } = issueIdentity(task);
    const repositoryId = await resolveRepositoryId(payload.repositoryFullName);
    const snapshot = await getIndexedIssueText(
      database.sql as unknown as SqlTag,
      { repositoryId, issueNumber: payload.subjectNumber },
    );
    const revisionAt = new Date(payload.subjectRevision);
    const decision = decideReanalysis({
      gated: true,
      snapshot,
      revisionAt: Number.isNaN(revisionAt.getTime()) ? null : revisionAt,
      currentText: normalizedIndexText({
        title: context.issue.title,
        body: context.issue.body,
      }),
      minChangeRatio: await issueMinChangeRatio(payload.repositoryFullName),
    });
    logger.info(
      {
        repo: payload.repositoryFullName,
        issueNumber: payload.subjectNumber,
        reanalyze: decision.reanalyze,
        reason: decision.reason,
        changeRatio: decision.changeRatio,
      },
      decision.reanalyze
        ? "issue edit will be reanalyzed"
        : "issue edit skipped as a minor change",
    );
    return decision.reanalyze;
  } catch (error) {
    logger.warn(
      { err: error },
      "reanalysis gate failed; analyzing the edit anyway",
    );
    return true;
  }
}

async function issueEnhancementConfig(
  repositoryFullName: string | null,
): Promise<{
  autoAssign: boolean;
  assignee: string;
  rewriteTitle: boolean;
}> {
  try {
    const map = await resolveIssueSettings(repositoryFullName, [
      "issue_auto_assign",
      "issue_assignee",
      "issue_rewrite_title",
    ]);
    return {
      autoAssign: parseBool(
        map.get("issue_auto_assign"),
        BOOLEAN_DEFAULTS.issue_auto_assign ?? false,
      ),
      assignee: (map.get("issue_assignee") ?? "").trim(),
      // 默认开启：含糊的标题（如只写「bug」）让维护者在列表页无法判断内容，
      // 改写成 [标签][重要度]清晰标题 才是用户期望的默认行为。显式设为
      // "false" 可关闭（全局或按仓库）。
      rewriteTitle: parseBool(
        map.get("issue_rewrite_title"),
        BOOLEAN_DEFAULTS.issue_rewrite_title ?? true,
      ),
    };
  } catch {
    // 读取设置失败时不改写标题：宁可不动，也不要基于未知配置改写用户的 Issue。
    return { autoAssign: false, assignee: "", rewriteTitle: false };
  }
}

/** GitHub 单个 Issue 最多接受 10 个 assignee，超出会整请求失败。 */
const maxIssueAssignees = 10;

/**
 * 解析指派名单：配置了 issue_assignee 就只用它；留空时默认「仓库所有者 +
 * 协作者」（issue #7）。始终排除 Issue 作者——把问题派回给报告者没有意义。
 * 拉取协作者需要额外权限，失败时降级为仅所有者，不让指派整体失效。
 */
async function resolveIssueAssignees(input: {
  github: ReturnType<typeof createGitHubClient>;
  installationId: string;
  owner: string;
  name: string;
  configured: string;
  author: string | null;
}): Promise<string[]> {
  if (input.configured) {
    return input.configured === input.author ? [] : [input.configured];
  }

  let collaborators: string[] = [];
  try {
    collaborators = await input.github.listCollaborators({
      installationId: input.installationId,
      owner: input.owner,
      name: input.name,
    });
  } catch (error) {
    logger.warn(
      { err: error, repo: `${input.owner}/${input.name}` },
      "collaborator lookup failed; assigning the owner only",
    );
  }

  const seen = new Set<string>();
  const assignees: string[] = [];
  for (const login of [input.owner, ...collaborators]) {
    if (login === input.author || seen.has(login)) continue;
    seen.add(login);
    assignees.push(login);
    if (assignees.length === maxIssueAssignees) break;
  }
  return assignees;
}

/**
 * Issue 增强：自动指派（issue_assignee 留空时默认仓库所有者与协作者，跳过
 * 作者本人）与标题改写（issue_rewrite_title 开启时应用 suggestedTitle）。
 * 全部 best-effort：失败只告警，不影响分析任务状态。
 */
export async function applyIssueEnhancements(input: {
  github: ReturnType<typeof createGitHubClient>;
  installationId: string;
  owner: string;
  name: string;
  issueNumber: number;
  analysis: Pick<
    IssueAnalysisResult,
    "severity" | "priority" | "suggestedLabels" | "suggestedTitle"
  >;
}): Promise<string[]> {
  const cfg = await issueEnhancementConfig(`${input.owner}/${input.name}`);
  // 标题按 [标签][重要度]标题 格式拼装（issue #5），前缀由服务端生成。
  const suggested = formatSuggestedTitle(input.analysis) ?? "";
  if (!cfg.autoAssign && !(cfg.rewriteTitle && suggested)) return [];

  // 需要作者（跳过自己）与当前标题（避免无效改写）时再拉取一次 Issue。
  const issue = await input.github.getIssue({
    installationId: input.installationId,
    owner: input.owner,
    name: input.name,
    number: input.issueNumber,
  });

  const patches: { title?: string; assignees?: string[] } = {};
  if (cfg.autoAssign) {
    const assignees = await resolveIssueAssignees({
      github: input.github,
      installationId: input.installationId,
      owner: input.owner,
      name: input.name,
      configured: cfg.assignee,
      author: issue.author,
    });
    if (assignees.length > 0) patches.assignees = assignees;
  }
  if (cfg.rewriteTitle && suggested && suggested !== issue.title) {
    patches.title = suggested;
  }
  if (Object.keys(patches).length === 0) return [];

  await input.github.updateIssue({
    installationId: input.installationId,
    owner: input.owner,
    name: input.name,
    number: input.issueNumber,
    ...patches,
  });
  logger.info(
    {
      repo: `${input.owner}/${input.name}`,
      issueNumber: input.issueNumber,
      patches,
    },
    "issue enhancement applied",
  );
  // 返回实际指派人（评论用于对齐「建议指派人」与真实指派，避免不一致）。
  return patches.assignees ?? [];
}

import {
  writeAuditLog,
  writeRepoMemory,
} from "../../../packages/database/src/index.js";
import {
  type ModelCandidate,
  type ModelProviderAdapter,
} from "../../../packages/domain/src/index.js";
import {
  type RelatedIssueRow,
  extractIssueSignals,
  judgeDuplicates,
  recallCandidatesWithRepos,
} from "../../../packages/duplicate-detection/src/index.js";
import {
  GitHubApiError,
  type GitHubClient,
} from "../../../packages/github-adapter/src/index.js";
import {
  analyzeIssue,
  buildFailureComment,
  buildIssueAnalysisComment,
  buildIssueContext,
  buildPlaceholderComment,
  collectIssueImages,
  detectSpamIssue,
  issueCommentIdempotencyKey,
  publishIssueComment,
} from "../../../packages/issue-analysis/src/index.js";
import { routeModelInvocation } from "../../../packages/model-router/src/index.js";
import { recordAttemptUsage } from "../../../packages/task-engine/src/index.js";
import {
  buildFilePickRequest,
  parseFilePicks,
  preloadTargetFiles,
  verifyProposedChangePaths,
} from "./files.js";
import { assertGithub } from "./github.js";
import { createIssueAnalysisHandler } from "./handler.js";
import { type TaskHandler } from "./loop.js";
import { repoMemoryText } from "./memory.js";
import {
  issueDeepAnalysisEnabled,
  issueVisionEnabled,
  resolveAnalysisBudgets,
  resolveIssuePromptMode,
  resolveIssuePromptVersion,
  resolveIssueSections,
} from "./preferences.js";
import { persistSubjectResult, publicationStore } from "./publication.js";
import { withIssueReviewRules } from "./review-rules.js";
import { loadRepoRules } from "./rules.js";
import {
  analysisDeadlineMs,
  analysisRetryPolicy,
  workerId,
} from "./runtime.js";
import { closeSpamIssue, spamHandlingMode } from "./spam.js";
export type IssueWorkflowInput = {
  github: GitHubClient | null;
  adapters: Map<string, ModelProviderAdapter>;
  issueCandidates: ModelCandidate[];
  issueVisionCandidates: ModelCandidate[];
  spamCandidates: ModelCandidate[];
};

/** 为当前已刷新凭据的任务创建工作流，调用过程不会保留旧GitHub客户端。 */
export function createIssueWorkflow(input: IssueWorkflowInput): TaskHandler {
  const {
    github,
    adapters,
    issueCandidates,
    issueVisionCandidates,
    spamCandidates,
  } = input;

  const issueHandler = createIssueAnalysisHandler({
    buildContext: async (task, signal) => {
      if (!github) throw new Error("GitHub App is not configured");
      const { payload, identity } = issueIdentity(task);
      const [context, repoMemory, repoRules] = await Promise.all([
        buildIssueContext(
          github,
          {
            installationId: payload.installationId,
            owner: identity.owner,
            name: identity.name,
            number: payload.subjectNumber,
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
      return withIssueReviewRules(
        { ...context, ...(repoMemory ? { repoMemory } : {}) },
        repoRules,
      );
    },

    shouldReanalyze: (task, context) => shouldReanalyzeIssue(task, context),

    publishPlaceholder: async (task, signal) => {
      signal.throwIfAborted();
      const { payload, identity } = issueIdentity(task);
      await publishIssueComment({
        signal,
        store: publicationStore,
        github: assertGithub(github),
        taskId: task.id,
        installationId: payload.installationId,
        owner: identity.owner,
        name: identity.name,
        issueNumber: payload.subjectNumber,
        idempotencyKey: issueCommentIdempotencyKey(
          payload.repositoryFullName,
          payload.subjectNumber,
        ),
        body: buildPlaceholderComment(),
      });
    },

    // 用同一幂等键原位改写占位评论，不新增评论。
    publishFailure: async (task, errorCategory, signal) => {
      signal.throwIfAborted();
      const { payload, identity } = issueIdentity(task);
      await publishIssueComment({
        signal,
        store: publicationStore,
        github: assertGithub(github),
        taskId: task.id,
        installationId: payload.installationId,
        owner: identity.owner,
        name: identity.name,
        issueNumber: payload.subjectNumber,
        idempotencyKey: issueCommentIdempotencyKey(
          payload.repositoryFullName,
          payload.subjectNumber,
        ),
        body: buildFailureComment(errorCategory),
      });
    },

    analyze: async (context: IssueContext, signal) => {
      const repositoryFullName = `${context.repository.owner}/${context.repository.name}`;
      // issue #102：时间预算与重试次数按设置解析（WebUI 可在线调整）。
      const budgets = await resolveAnalysisBudgets(repositoryFullName);
      // 深度分析（读取仓库源码）默认关闭：会显著增加 token 消耗与耗时。
      const deep = await issueDeepAnalysisEnabled(repositoryFullName);
      // 决策留痕：tools 是否注入取决于 deep && (defect|feature|codeRef)，任一不成立
      // 都会导致模型读不到仓库（无 read_file/list_directory），深读挑错静默失效。
      // codeRef：deep 已开启且内容引用具体源码文件/扩展名时兜底读仓（#70），
      // 不依赖标题类型前缀或标签时序。
      const defect = isDefectIssue(context);
      const feature = isFeatureRequest(context);
      const codeRef = CODE_REFERENCE_HINT.test(
        `${context.issue.title ?? ""}\n${context.issue.body ?? ""}`,
      );
      const shouldReadRepo = defect || feature || (deep && codeRef);
      logger.info(
        {
          repo: repositoryFullName,
          subject: context.issue.number,
          deep,
          defect,
          feature,
          codeRef,
          toolsInjected: deep && shouldReadRepo,
        },
        "issue deep decision: tools injection",
      );
      // 方案B：审查/缺陷类及功能请求类主动预读被点名目标文件并注入上下文，保证模型无论是否
      // 调用工具都能看到源码（deepseek 的 function-calling 不稳定）。tools 仍保留。
      if (deep && shouldReadRepo) {
        try {
          const preload = await preloadTargetFiles(
            assertGithub(github),
            context,
            // 内容级检索：#62 方案2。仅当路径打分未命中（中文语义）时，由模型从
            // 仓库候选清单挑最相关源码，覆盖纯中文 enhancement 场景。
            async (candidatePaths, ctx) => {
              logger.info(
                {
                  repo: repositoryFullName,
                  subject: ctx.issue.number,
                  candidatePaths: candidatePaths.length,
                },
                "content retrieval: model file picker start",
              );
              const res = await routeModelInvocation(adapters, {
                candidates: issueCandidates,
                request: buildFilePickRequest(ctx, candidatePaths),
                deadlineMs: Math.min(budgets.analysisDeadlineMs, 30_000),
                retryPolicy: budgets.retryPolicy,
                ...(signal === undefined ? {} : { signal }),
              });
              const picked = parseFilePicks(
                res.response.content,
                candidatePaths,
              );
              logger.info(
                {
                  repo: repositoryFullName,
                  subject: ctx.issue.number,
                  response: res.response.content.slice(0, 300),
                  picked,
                },
                "content retrieval: model picked files",
              );
              return picked;
            },
          );
          if (preload.length > 0) {
            context = { ...context, preloadedFiles: preload };
            logger.info(
              {
                repo: repositoryFullName,
                subject: context.issue.number,
                files: preload.map((f) => f.path),
              },
              "issue preload: target files injected",
            );
          }
        } catch (error) {
          logger.warn(
            { err: error, repo: repositoryFullName },
            "issue target file preload failed",
          );
        }
      }
      const promptVersion = await resolveIssuePromptVersion();
      const promptMode = await resolveIssuePromptMode();
      const issueSections = await resolveIssueSections(repositoryFullName);
      // 图片多模态：开启时下载 Issue 正文/评论里的图片并入上下文；任何图片失败
      // 都降级（记入 degraded）而非失败，文本分析总能继续（#545 Phase 1）。
      let ctx = context;
      if (await issueVisionEnabled(repositoryFullName)) {
        const collected = await collectIssueImages(context);
        logger.info(
          {
            repo: repositoryFullName,
            subject: context.issue.number,
            imagesCollected: collected.images.length,
            imagesDegraded: collected.degraded.length,
          },
          "issue vision: collected images attached to analysis request",
        );
        ctx = {
          ...context,
          images: collected.images,
          degraded: [...context.degraded, ...collected.degraded],
        };
      }
      // 文本 / 图片(多模态) 模型分流：携带图片时用 issue_analysis_vision 角色
      // （视觉模型），否则用 issue_analysis（快模型）。视觉角色未配置时回退到
      // issue_analysis，避免带图的文本分析也能跑。
      const useVisionModel =
        ctx.images.length > 0 && issueVisionCandidates.length > 0;
      if (useVisionModel)
        logger.info(
          { repo: repositoryFullName, subject: context.issue.number },
          "issue vision: routing to vision model candidates",
        );
      // 分析选项按候选模型参数化：视觉失败时复用同一套配置，仅换文本模型候选。
      // capDeadlineMs 允许分阶段限制时间——视觉阶段给短 budget，失败后把剩余时间留给文本。
      const buildAnalysisOptions = (
        candidates: ModelCandidate[],
        capDeadlineMs: number,
      ) => ({
        adapters,
        candidates,
        deadlineMs: capDeadlineMs,
        retryPolicy: budgets.retryPolicy,
        signal,
        // exactOptionalPropertyTypes：undefined 不能显式赋给可选属性，条件展开。
        ...(promptVersion === undefined ? {} : { promptVersion }),
        ...(promptMode === undefined ? {} : { promptMode }),
        ...(issueSections.sections === undefined
          ? {}
          : { sections: issueSections.sections }),
        ...(issueSections.sectionsByCategory.bug === undefined &&
        issueSections.sectionsByCategory.feature === undefined
          ? {}
          : {
              sectionsByCategory: {
                ...(issueSections.sectionsByCategory.bug === undefined
                  ? {}
                  : { bug: issueSections.sectionsByCategory.bug }),
                ...(issueSections.sectionsByCategory.feature === undefined
                  ? {}
                  : { feature: issueSections.sectionsByCategory.feature }),
              },
            }),
        // 缺陷类与功能请求类开启读仓定位（deep 由 issue_deep_analysis 开关控制）；
        // 开启后额外注入强制读仓，防止模型跳过工具直接以"无代码访问能力"逃避。
        ...(deep && shouldReadRepo
          ? {
              tools: {
                context: {
                  client: assertGithub(github),
                  installationId: context.installationId,
                  owner: context.repository.owner,
                  name: context.repository.name,
                  // 默认分支：Issue 不像 PR 那样绑定某个 commit。
                  ref: "HEAD",
                },
                maxRounds: 3,
                forceToolUse: true,
              },
            }
          : {}),
      });
      // 视觉模型优先；若视觉模型服务不可用导致分析失败，回退到文本模型重跑一次
      // （丢弃图片，保证带图 Issue 也能出分析，不因图片理解失败而整条失败）。
      if (useVisionModel) {
        // 视觉阶段用较短 budget：视觉模型不可用时快速失败，把剩余时间留给文本兜底。
        try {
          return await analyzeIssue(
            buildAnalysisOptions(
              issueVisionCandidates,
              Math.min(budgets.analysisDeadlineMs, 60_000),
            ),
            ctx,
          );
        } catch (error) {
          logger.warn(
            {
              err: error,
              repo: repositoryFullName,
              subject: context.issue.number,
            },
            "issue vision: vision model failed, falling back to text analysis",
          );
          const fallback = await analyzeIssue(
            buildAnalysisOptions(issueCandidates, budgets.analysisDeadlineMs),
            { ...ctx, images: [] },
          );
          // 显示层标记：仅当文本分析产出有效结果时标注「视觉未参与」。
          if (fallback.outcome === "valid") {
            (
              fallback.analysis.result as IssueAnalysisResult & {
                _visionSkipped?: boolean;
              }
            )._visionSkipped = true;
          }
          return fallback;
        }
      }
      // 深读（读仓+工具循环）单独给更大 deadline，避免大上下文多轮推理超时。
      const deadlineMs =
        deep && shouldReadRepo
          ? budgets.deepAnalysisDeadlineMs
          : budgets.analysisDeadlineMs;
      return analyzeIssue(
        buildAnalysisOptions(issueCandidates, deadlineMs),
        ctx,
      );
    },

    recallRelated: async (context) => {
      let recalled: RelatedIssueRow[] = [];
      try {
        recalled = await recallCandidatesWithRepos(
          database.sql as unknown as SqlTag,
          {
            title: context.issue.title,
            body: context.issue.body,
            signals: extractIssueSignals({
              title: context.issue.title,
              body: context.issue.body,
              labels: context.issue.labels,
            }),
            topK: 5,
            // 只在同一仓库内召回历史 Issue，避免把其他项目的 Issue 当作“相关”。
            repository: context.repository,
            // 当前 Issue 在召回前已入库，不排除会把自己列为最相关项。
            excludeIssueNumber: context.issue.number,
          },
        );
      } catch (error) {
        logger.warn({ err: error }, "related-issue recall skipped");
        return [];
      }
      if (recalled.length === 0) return [];

      // 让模型裁决召回候选，只保留确认相关/重复的，避免「文本相似但实际无关」
      // 的误关联（曾把提示词注入测试与获取模型失败这两个无关 issue 列在一起）。
      // 裁决失败或模型判定无关时一律不列出，而不是退回原始召回。
      try {
        const outcome = await judgeDuplicates(
          {
            adapters,
            candidates: issueCandidates,
            deadlineMs: analysisDeadlineMs,
            retryPolicy: analysisRetryPolicy,
          },
          {
            lead: {
              issueNumber: context.issue.number,
              title: context.issue.title,
              body: context.issue.body,
            },
            candidates: recalled.map((row) => ({
              issueNumber: row.issueNumber,
              title: row.title,
              body: row.body,
            })),
          },
        );
        if (outcome.outcome !== "valid") return [];
        if (
          outcome.judgment.decision === "not_duplicate" ||
          outcome.judgment.decision === "insufficient_evidence"
        )
          return [];
        const confirmed = new Set(outcome.judgment.relatedIssues);
        return recalled.filter((row) => confirmed.has(row.issueNumber));
      } catch (error) {
        logger.warn(
          { err: error },
          "related-issue adjudication failed; listing none",
        );
        return [];
      }
    },

    publishFinal: async (task, analysis, related, signal) => {
      signal.throwIfAborted();
      const { payload, identity } = issueIdentity(task);
      // #50：先做自动指派，并把「建议指派人」对齐到实际指派，再发布评论，
      // 避免模型输出的个人猜测与真实自动指派不一致。
      let assignedAssignees: string[] = [];
      try {
        assignedAssignees = await applyIssueEnhancements({
          github: assertGithub(github),
          installationId: payload.installationId,
          owner: identity.owner,
          name: identity.name,
          issueNumber: payload.subjectNumber,
          analysis: analysis.result,
        });
      } catch (error) {
        logger.warn(
          { err: error, taskId: task.id },
          "issue enhancement skipped",
        );
      }
      // #53：自动指派可多人，全部写回 suggestedAssignee（逗号分隔），
      // 评论与结果页逐个 @，不再只体现第一个。
      if (assignedAssignees.length > 0) {
        analysis.result.suggestedAssignee = assignedAssignees.join(", ");
      }
      // #57：发布前校验 proposedChanges.path 真实存在，移除编造的文件/文件夹路径。
      if ((analysis.result.proposedChanges ?? []).length > 0) {
        try {
          const verified = await verifyProposedChangePaths({
            reader: assertGithub(github),
            installationId: payload.installationId,
            owner: identity.owner,
            name: identity.name,
            changes: analysis.result.proposedChanges,
          });
          if (verified.length !== analysis.result.proposedChanges.length) {
            logger.warn(
              {
                repo: payload.repositoryFullName,
                subject: payload.subjectNumber,
                before: analysis.result.proposedChanges.length,
                after: verified.length,
              },
              "proposed change paths verified: dropped hallucinated paths",
            );
          }
          analysis.result.proposedChanges = verified;
        } catch (error) {
          // 校验整体失败（罕见）不阻断发布，保留原建议。
          logger.warn(
            { err: error, taskId: task.id },
            "proposed change path verification skipped",
          );
        }
      }
      await publishIssueComment({
        signal,
        store: publicationStore,
        github: assertGithub(github),
        taskId: task.id,
        installationId: payload.installationId,
        owner: identity.owner,
        name: identity.name,
        issueNumber: payload.subjectNumber,
        idempotencyKey: issueCommentIdempotencyKey(
          payload.repositoryFullName,
          payload.subjectNumber,
        ),
        body: buildIssueAnalysisComment(analysis, related),
      });
      await persistSubjectResult({
        taskId: task.id,
        subjectType: "issue",
        subjectNumber: payload.subjectNumber,
        repositoryFullName: payload.repositoryFullName,
        revision: payload.subjectRevision,
        result: related.length > 0 ? { ...analysis, related } : analysis,
      });
      // Apply configured label rules to the issue (best-effort, idempotent).
      await applyConfiguredLabels({
        github: assertGithub(github),
        installationId: payload.installationId,
        owner: identity.owner,
        name: identity.name,
        issueNumber: payload.subjectNumber,
        analysis: analysis.result,
      }).catch((error: unknown) =>
        logger.warn(
          { err: error, taskId: task.id },
          "label application skipped",
        ),
      );
    },

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

    recordMemory: async (task, analysis) => {
      try {
        const { payload } = issueIdentity(task);
        const repositoryId = await resolveRepositoryId(
          payload.repositoryFullName,
        );
        const result = analysis.result;
        const evidence = result.evidence
          .map((entry) => `[${entry.kind}] ${entry.excerpt}`)
          .join("\n");
        const content = [
          `摘要：${result.summary}`,
          `类别：${result.category}；严重度：${result.severity}；优先级：${result.priority}；质量：${result.quality}`,
          ...(evidence.length > 0 ? [`证据：\n${evidence}`] : []),
          ...(result.suggestedActions.length > 0
            ? [`建议动作：${result.suggestedActions.join("、")}`]
            : []),
        ].join("\n");
        await writeRepoMemory(database.db, {
          repositoryId: repositoryId ?? undefined,
          kind: "reflection",
          title: `Issue #${payload.subjectNumber} · ${result.category}/${result.severity} ${result.summary.slice(0, 50)}`,
          content,
          sourceType: "issue_analysis",
          sourceRef: `#${payload.subjectNumber}`,
        });
      } catch (error) {
        logger.warn(
          { err: error, taskId: task.id },
          "issue memory reflection skipped",
        );
      }
    },

    detectSpam: async (task, signal) => {
      try {
        if (!github) return null;
        const candidates =
          spamCandidates.length > 0 ? spamCandidates : issueCandidates;
        if (candidates.length === 0) return null;
        const { payload, identity } = issueIdentity(task);
        // issue #102：spam 检测同样用可配置预算（全局值，不按仓库覆盖）。
        const budgets = await resolveAnalysisBudgets(null);
        const context = await buildIssueContext(
          github,
          {
            installationId: payload.installationId,
            owner: identity.owner,
            name: identity.name,
            number: payload.subjectNumber,
          },
          undefined,
          signal,
        );
        const outcome = await detectSpamIssue(
          {
            adapters,
            candidates,
            deadlineMs: budgets.analysisDeadlineMs,
            retryPolicy: budgets.retryPolicy,
            signal,
          },
          context,
        );
        return outcome.outcome === "valid" ? outcome.verdict : null;
      } catch (error) {
        logger.warn({ err: error, taskId: task.id }, "spam detection skipped");
        return null;
      }
    },

    handleSpam: async (task, verdict) => {
      const { payload, identity } = issueIdentity(task);
      const githubClient = assertGithub(github);
      const target = `${payload.repositoryFullName}#${payload.subjectNumber}`;
      let action: "none" | "close" | "delete" = "none";
      try {
        action = await spamHandlingMode(payload.repositoryFullName);
        if (action === "close") {
          await closeSpamIssue(githubClient, payload, identity, verdict.reason);
        } else if (action === "delete") {
          try {
            await githubClient.deleteIssue({
              installationId: payload.installationId,
              owner: identity.owner,
              name: identity.name,
              number: payload.subjectNumber,
            });
          } catch (error) {
            if (
              error instanceof GitHubApiError &&
              error.category === "authentication_failed"
            ) {
              logger.warn(
                { err: error, target },
                "spam delete not permitted; falling back to close",
              );
              await closeSpamIssue(
                githubClient,
                payload,
                identity,
                verdict.reason,
              );
            } else {
              throw error;
            }
          }
        }
        // "none": no GitHub action; only the audit trail below.
      } catch (error) {
        logger.warn({ err: error, target, action }, "spam handling failed");
      }
      try {
        await writeAuditLog(database.db, {
          actor: "system",
          action: "issue.spam_handled",
          target,
          detail: {
            action,
            reason: verdict.reason,
            confidence: verdict.confidence,
          },
        });
      } catch (error) {
        logger.warn({ err: error, target }, "spam audit log write failed");
      }
    },
  });
  return issueHandler;
}
