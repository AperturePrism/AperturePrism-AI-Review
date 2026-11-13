/**
 * 生效设置：仓库覆盖、提示词开关与分析时间预算。
 * 调用示例：await resolveAnalysisBudgets("owner/repository")。
 * 仅拆分内部实现；任务与数据契约保持兼容，依赖在下方显式列出。
 */
import {
  BOOLEAN_DEFAULTS,
  parseBool,
} from "../../../packages/config/src/index.js";
import {
  getRepositorySettingsFor,
  loadSettings,
} from "../../../packages/database/src/index.js";
import {
  DEFAULT_MIN_CHANGE_RATIO,
  ISSUE_RESULT_SECTIONS,
  type IssueResultSection,
  parseIssueResultSections,
  parseMinChangeRatio,
} from "../../../packages/issue-analysis/src/index.js";
import { resolveRepositoryId } from "./memory.js";
import {
  analysisDeadlineMs,
  analysisRetryPolicy,
  database,
  deepAnalysisDeadlineMs,
  logger,
  reviewDeadlineMs,
  reviewRetryPolicy,
} from "./runtime.js";

/**
 * 分析行为设置的取值：仓库级覆盖优先，其次全局 `system_settings`，都没有时返回
 * undefined 让调用方套用应用默认（不同开关的默认值不同，这一层不猜）。
 *
 * 同一实例常同时接入个人项目与协作项目 —— 自动改标题在后者未必受欢迎，所以这
 * 些开关必须能按仓库分别控制（issue #54）。仓库未入库或读取失败时退回全局。
 */
export async function resolveIssueSettings(
  repositoryFullName: string | null,
  keys: readonly string[],
): Promise<Map<string, string>> {
  let globals: Map<string, string>;
  try {
    globals = await loadSettings(database.db, keys);
  } catch (error) {
    logger.warn({ err: error }, "global settings read failed");
    throw error;
  }

  if (!repositoryFullName) return globals;
  try {
    const repositoryId = await resolveRepositoryId(repositoryFullName);
    if (!repositoryId) return globals;
    const overrides = await getRepositorySettingsFor(
      database.db,
      repositoryId,
      keys,
    );
    // 覆盖优先：仓库级有值就盖掉全局，没有的键保持全局值。
    for (const [key, value] of overrides) globals.set(key, value);
    return globals;
  } catch (error) {
    // 仓库级覆盖不可读时退回全局，而不是让整次分析失败。
    logger.warn(
      { err: error, repo: repositoryFullName },
      "repository settings read failed; using global settings",
    );
    return globals;
  }
}

/**
 * issue #102：把"秒"设置解析为毫秒预算。非法/越界值回退默认，钳制在
 * 1min–60min 之间，防止手滑填 0 或 99999 把 worker 拖死。
 */
function parseDeadlineSeconds(
  raw: string | undefined,
  fallbackMs: number,
): number {
  const MIN_MS = 60_000;
  const MAX_MS = 3_600_000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallbackMs;
  return Math.min(MAX_MS, Math.max(MIN_MS, value * 1000));
}

/**
 * issue #102：Issue 分析的时间预算与单候选重试次数，可在 WebUI 在线调整，
 * 不必改代码重新部署。读取失败时退回模块默认值，不影响分析可用性。
 */
export async function resolveAnalysisBudgets(
  repositoryFullName: string | null,
): Promise<{
  analysisDeadlineMs: number;
  deepAnalysisDeadlineMs: number;
  retryPolicy: typeof analysisRetryPolicy;
}> {
  try {
    const settings = await resolveIssueSettings(repositoryFullName, [
      "issue_analysis_deadline_seconds",
      "issue_deep_analysis_deadline_seconds",
      "issue_analysis_candidate_attempts",
    ]);
    const attempts = Number(settings.get("issue_analysis_candidate_attempts"));
    return {
      analysisDeadlineMs: parseDeadlineSeconds(
        settings.get("issue_analysis_deadline_seconds"),
        analysisDeadlineMs,
      ),
      deepAnalysisDeadlineMs: parseDeadlineSeconds(
        settings.get("issue_deep_analysis_deadline_seconds"),
        deepAnalysisDeadlineMs,
      ),
      retryPolicy:
        Number.isFinite(attempts) && attempts >= 1 && attempts <= 20
          ? {
              ...analysisRetryPolicy,
              maxAttemptsPerCandidate: Math.floor(attempts),
            }
          : analysisRetryPolicy,
    };
  } catch (error) {
    logger.warn(
      { err: error, repo: repositoryFullName },
      "analysis budget settings read failed; using defaults",
    );
    return {
      analysisDeadlineMs,
      deepAnalysisDeadlineMs,
      retryPolicy: analysisRetryPolicy,
    };
  }
}

/**
 * issue #102：PR 审查时间预算（全局设置 pr_review_deadline_seconds）。
 * 读取失败时退回模块默认值。
 */
export async function resolveReviewBudget(): Promise<{
  deadlineMs: number;
  retryPolicy: typeof reviewRetryPolicy;
}> {
  try {
    const map = await loadSettings(database.db, ["pr_review_deadline_seconds"]);
    return {
      deadlineMs: parseDeadlineSeconds(
        map.get("pr_review_deadline_seconds"),
        reviewDeadlineMs,
      ),
      retryPolicy: reviewRetryPolicy,
    };
  } catch (error) {
    logger.warn(
      { err: error },
      "review budget settings read failed; using defaults",
    );
    return { deadlineMs: reviewDeadlineMs, retryPolicy: reviewRetryPolicy };
  }
}

/**
 * 是否允许 Issue 分析读取仓库源码。默认启用：读仓让模型给出可落地、精确到
 * 文件/函数的建议（用户 09-04 反馈）。读取失败时按关闭处理，不因设置不可用
 * 而改变行为。
 */
export async function issueDeepAnalysisEnabled(
  repositoryFullName: string | null,
): Promise<boolean> {
  try {
    const settings = await resolveIssueSettings(repositoryFullName, [
      "issue_deep_analysis",
    ]);
    return parseBool(
      settings.get("issue_deep_analysis"),
      BOOLEAN_DEFAULTS.issue_deep_analysis ?? false,
    );
  } catch (error) {
    // 读设置失败时静默降级为不读仓（安全），但必须留痕，否则 deep 读仓会无影无踪地
    // 失效、极难排查（工具不注入时模型无法读仓挑错，评论只会诚实说"未读取文件"）。
    logger.warn(
      { err: error, repo: repositoryFullName },
      "issue deep analysis settings read failed; disabling deep source reading",
    );
    return false;
  }
}

/**
 * 当前 Issue 分析的提示词版本。读「分析设置 → Issue 提示词版本」；
 * 缺省或读取失败回落到当前版本（analysis-worker 每轮 pass 重新读，改设置即生效）。
 */
export async function resolveIssuePromptVersion(): Promise<string | undefined> {
  try {
    const settings = await resolveIssueSettings(null, ["issue_prompt_version"]);
    const raw = settings.get("issue_prompt_version");
    return raw && raw.trim().length > 0 ? raw.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 当前 Issue 分析的强度模式（adaptive / light / full）。读「分析设置 →
 * Issue 提示词模式」；缺省或读取失败返回 undefined（默认 adaptive）。
 */
export async function resolveIssuePromptMode(): Promise<
  "adaptive" | "light" | "full" | undefined
> {
  try {
    const settings = await resolveIssueSettings(null, ["issue_prompt_mode"]);
    const raw = settings.get("issue_prompt_mode");
    if (raw === "light" || raw === "full" || raw === "adaptive") return raw;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 当前 Issue 分析的结果区块开关（summary / probable_cause / missing_information / …）。
 * 返回「通用兜底组 + bug 组 + feature 组」，交给 analyzer 按类别做前置 / 后置选择。
 * 三个组各自读「分析设置 → Issue 结果区块（通用 / 缺陷类 / 功能请求）」；
 * 某个组没配置时用 undefined 表示「未单独设置」，analyzer 会回落到通用组或全开。
 *
 * 若该仓库开启了 `issue_use_unified_sections`（#44），则所有类别一律回落到通用组：
 * 返回的 bug / feature 组均为 undefined，analyzer 对任何分类都走通用区块。
 */
export async function resolveIssueSections(
  repositoryFullName: string | null,
): Promise<{
  sections: ReadonlySet<IssueResultSection> | undefined;
  sectionsByCategory: {
    bug: ReadonlySet<IssueResultSection> | undefined;
    feature: ReadonlySet<IssueResultSection> | undefined;
  };
}> {
  const read = async (
    key: string,
    isCategory: boolean,
  ): Promise<ReadonlySet<IssueResultSection> | undefined> => {
    try {
      const settings = await resolveIssueSettings(repositoryFullName, [key]);
      const raw = settings.get(key);
      // 分类组（bug / feature）未单独配置时返回 undefined，让 analyzer 回落到通用组。
      if (isCategory && !raw) return undefined;
      const parsed = parseIssueResultSections(raw);
      return parsed.size === ISSUE_RESULT_SECTIONS.length ? undefined : parsed;
    } catch {
      return undefined;
    }
  };
  const unified = await issueUseUnifiedSections(repositoryFullName);
  return {
    sections: await read("issue_result_sections", false),
    sectionsByCategory: unified
      ? { bug: undefined, feature: undefined }
      : {
          bug: await read("issue_result_sections_bug", true),
          feature: await read("issue_result_sections_feature", true),
        },
  };
}

/**
 * 是否让该仓库所有 Issue 都使用通用统一区块（#44）。
 * 仓库级覆盖 → 全局默认（false）。开启后不再按功能请求 / 缺陷分类选择区块。
 */
async function issueUseUnifiedSections(
  repositoryFullName: string | null,
): Promise<boolean> {
  try {
    const settings = await resolveIssueSettings(repositoryFullName, [
      "issue_use_unified_sections",
    ]);
    return parseBool(
      settings.get("issue_use_unified_sections"),
      BOOLEAN_DEFAULTS.issue_use_unified_sections ?? false,
    );
  } catch {
    return false;
  }
}

/**
 * 是否开启该仓库的 Issue 图片多模态分析（#545 Phase 1）。
 * 仓库级覆盖 → 全局默认（false）。开启后把 Issue 里的图随分析发给模型。
 */
export async function issueVisionEnabled(
  repositoryFullName: string | null,
): Promise<boolean> {
  try {
    const settings = await resolveIssueSettings(repositoryFullName, [
      "issue_vision_enabled",
    ]);
    return parseBool(
      settings.get("issue_vision_enabled"),
      BOOLEAN_DEFAULTS.issue_vision_enabled ?? false,
    );
  } catch {
    return false;
  }
}

/** 重新分析的最小变化比例（`issue_reanalyze_min_change`），可按仓库覆盖。 */
export async function issueMinChangeRatio(
  repositoryFullName: string | null,
): Promise<number> {
  try {
    const settings = await resolveIssueSettings(repositoryFullName, [
      "issue_reanalyze_min_change",
    ]);
    return parseMinChangeRatio(settings.get("issue_reanalyze_min_change"));
  } catch {
    return DEFAULT_MIN_CHANGE_RATIO;
  }
}

/** PR 审查交互开关（运行时设置，可在 WebUI「系统配置」热更新）。 */
export async function prReviewConfig(): Promise<{
  checkRun: boolean;
  autoReview: boolean;
}> {
  try {
    const map = await loadSettings(database.db, [
      "pr_check_run",
      "pr_auto_review",
    ]);
    return {
      checkRun: parseBool(
        map.get("pr_check_run"),
        BOOLEAN_DEFAULTS.pr_check_run ?? true,
      ),
      autoReview: parseBool(
        map.get("pr_auto_review"),
        BOOLEAN_DEFAULTS.pr_auto_review ?? true,
      ),
    };
  } catch {
    return { checkRun: true, autoReview: true };
  }
}
