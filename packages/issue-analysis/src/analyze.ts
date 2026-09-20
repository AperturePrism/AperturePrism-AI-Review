import {
  parseIssueAnalysisJson,
  type GradedIssueAnalysis,
  type IssueAnalysisResult,
} from "../../../packages/contracts/src/index.js";
import type {
  ModelAttemptOutcome,
  ModelCandidate,
  ModelInvocationRequest,
  ModelProviderAdapter,
  ModelUsage,
} from "../../../packages/domain/src/index.js";
import {
  routeModelInvocation,
  type RetryPolicy,
} from "../../../packages/model-router/src/index.js";
import {
  builtinTools,
  runToolLoop,
  type ToolExecutionContext,
} from "../../../packages/pr-review/src/index.js";
import type { IssueContext } from "./context.js";
import {
  buildIssueAnalysisMessages,
  buildIssueAnalysisRepairRequest,
  buildIssueAnalysisRequest,
  type IssueResultSection,
  type PromptMode,
} from "./prompt.js";

export type IssueAnalyzerOptions = {
  adapters: ReadonlyMap<string, ModelProviderAdapter>;
  candidates: readonly ModelCandidate[];
  /** Shared logical deadline across main call, retries, and the repair. */
  deadlineMs: number;
  retryPolicy: RetryPolicy;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /**
   * Issue 系统提示词版本（如 "v6"）。缺省用当前版本；改「分析设置 → Issue 提示词
   * 版本」可在线回退到历史版本，无需重新部署。
   */
  promptVersion?: string;
  /**
   * 分析强度模式（adaptive / light / full）。缺省 adaptive（分类差异化）；
   * 改「分析设置 → Issue 提示词模式」可全局轻量或全量。
   */
  promptMode?: PromptMode;
  /**
   * 结果区块开关（summary / probable_cause / missing_information / …）。
   * 缺省全开。关闭的区块：prompt 不要求输出，且校验后强制清空对应字段，
   * 保证评论 / 结果页 / 标签都不再出现。
   */
  sections?: ReadonlySet<IssueResultSection>;
  /**
   * 按 Issue 类别分别配置的结果区块开关（#28）。
   * - prompt 阶段（前置）：用标题 / 标签的启发式猜测类别，取对应组的开关；
   * - 校验阶段（后置）：用模型输出的真实 category 取对应组的开关。
   * 缺省时回落到 `sections`（未配置该类别时也用 `sections` 兜底）。
   */
  sectionsByCategory?: Readonly<{
    bug?: ReadonlySet<IssueResultSection>;
    feature?: ReadonlySet<IssueResultSection>;
    default?: ReadonlySet<IssueResultSection>;
  }>;
  /**
   * 开启后主分析先做一轮工具探索，让模型读取仓库源码再作答。不开启时模型只能
   * 看到 Issue 文本，无法给出定位到文件与位置的修复建议。默认关闭：探索会显著
   * 增加 token 消耗与单任务耗时。
   *
   * 前提：模型网关必须支持 tools / function calling。NAS 上的 newapi 网关实测
   * 对携带 tools 的请求返回 5xx（与它对 response_format 的已知问题同类，见
   * model-router/src/openai-compatible.ts 中的注释），此时任务会重试直至失败。
   */
  tools?: {
    context: ToolExecutionContext;
    maxRounds?: number;
    /**
     * 强制读仓：审查/缺陷任务开启后，若模型未调用任何工具就打算收尾（输出
     * "无代码访问能力"等逃避模板），runToolLoop 会插入强制指令要求它先读取
     * 目标文件再作答。仅当 tools 注入时有意义。
     */
    forceToolUse?: boolean;
  };
};

/**
 * 是否为「代码审查请求」（issue #60 / #14）：
 * 用户请 bot 去检查某个文件 / 代码有没有 bug（常见于外部仓库「帮我看看 xxx 的
 * bug」），而不是报告一个带复现步骤的缺陷。这类请求的模型输出天然是一份自由
 * 格式缺陷清单，很多时候无法通过结构化 JSON 契约校验；命中时允许在 repair 仍
 * 失败后走宽松降级，把原始清单发布出去，而不是只回一条「分析未完成」。
 *
 * 只在 repair 两次都拿不到合法 JSON 之后才咨询这个判定，因此即使放宽也不会把
 * 正常输出 JSON 的分析降级——判定的是「模型确实在写自由文本」的审查请求。
 */
function isCodeReviewRequest(
  context: IssueContext,
): boolean {
  const title = context.issue.title ?? "";
  const body = context.issue.body ?? "";
  const hay = `${title}\n${body}`;
  // 点名了源码文件（如 main.py / app.js）并要求查问题。
  const namesFileWithBug =
    /[\w.-]+\.(py|js|ts|tsx|go|java|rs|c|cpp|h|sh|json)\b[\s\S]{0,24}(bug|错误|缺陷|问题|毛病|哪里不对|哪里有问题)/i.test(
      hay,
    );
  // 审查动作 + 代码/源码/文件 目标 + 缺陷词（字符序不限）。
  const reviewsCodeAgainstBug =
    /(找|查|检查|审查|审阅|看看|找找|查看|看下)[\s\S]{0,12}(代码|源码|文件|仓库)[\s\S]{0,12}(bug|错误|缺陷|问题|毛病)/i.test(
      hay,
    ) ||
    /(代码|源码)[\s\S]{0,12}(找|查|检查|审查|看看)[\s\S]{0,12}(bug|错误|缺陷|问题|毛病)/i.test(
      hay,
    );
  return namesFileWithBug || reviewsCodeAgainstBug;
}

/**
 * 宽松降级：把模型输出的原始缺陷清单包装成一份合法分析结果，使评论能展示真实
 * 的代码审查产出，而不是「分析未完成」的泛化失败消息（issue #60）。structured
 * 信息（severity/priority/evidence）无法从自由文本中可靠提取，统一保守取值，
 * 并把降级原因记入 adjustments 以便用户知情。
 */
function lenientCodeReviewOutcome(
  rawText: string,
  usage: ModelUsage,
  candidate: ModelCandidate,
  attempts: readonly ModelAttemptOutcome[],
  durationMs: number,
): { outcome: "valid"; analysis: GradedIssueAnalysis; usage: ModelUsage; candidate: ModelCandidate; attempts: readonly ModelAttemptOutcome[]; durationMs: number } {
  const trimmed = (rawText ?? "").trim();
  const summary =
    trimmed.length > 0
      ? trimmed.slice(0, 2_000)
      : "（模型未返回具体缺陷清单）";
  const analysis: GradedIssueAnalysis = {
    result: {
      contractVersion: "issue-analysis/v1",
      category: "bug",
      summary,
      severity: "unknown",
      priority: "needs_triage",
      quality: trimmed.length > 0 ? "actionable" : "invalid",
      proposedChanges: [],
      evidence: [],
      missingInformation: [],
      troubleshooting: [],
      suggestedLabels: ["code-review"],
      suggestedActions:
        trimmed.length > 0
          ? ["请人工核对上方缺陷清单，确认后再实施修改。"]
          : [],
      confidence: { severity: 0, rootCause: 0, suggestion: 0.5 },
    },
    adjustments: [
      {
        field: "severity",
        from: "schema-json",
        to: "raw-text",
        reason:
          "代码审查请求的模型输出未通过结构化契约校验，已按原始缺陷清单发布（issue #60）。",
      },
    ],
  };
  return {
    outcome: "valid",
    analysis,
    usage,
    candidate,
    attempts,
    durationMs,
  };
}

export type IssueAnalysisOutcome =
  | {
      outcome: "valid";
      analysis: GradedIssueAnalysis;
      usage: ModelUsage;
      candidate: ModelCandidate;
      attempts: readonly ModelAttemptOutcome[];
      /** Wall-clock time consumed by the model phase, including the repair. */
      durationMs: number;
    }
  | {
      outcome: "invalid";
      usage: ModelUsage;
      attempts: readonly ModelAttemptOutcome[];
      durationMs: number;
    };

function totalUsage(...usage: readonly ModelUsage[]): ModelUsage {
  return usage.reduce(
    (total, entry) => ({
      inputTokens: total.inputTokens + entry.inputTokens,
      outputTokens: total.outputTokens + entry.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 },
  );
}

/**
 * 启发式猜测 Issue 的疑似类别（bug / feature / 其它），仅用于 prompt 阶段的
 * 前置区块选择。真实类别以模型输出为准（后置校正）。
 *
 * 依据：标题 / 正文中的关键词与标签。feature 常见词：功能/新增/支持/建议/希望/
 * 能否/添加/优化；bug 常见词：报错/失败/bug/崩溃/异常/无法/不能/坏了。
 */
function guessIssueCategory(context: IssueContext): "bug" | "feature" | "other" {
  const issue = context.issue;
  const title = issue.title ?? "";
  const body = issue.body ?? "";
  const labels = issue.labels ?? [];
  const hay = `${title}\n${body}\n${labels.join(" ")}`.toLowerCase();

  const featureWords = ["feature", "feat:", "feat ", "enhancement", "新增", "添加", "支持", "建议", "希望", "能否", "功能", "优化", "需求"];
  const bugWords = ["bug", "fix", "fix:", "报错", "错误", "失败", "异常", "崩溃", "无法", "不能", "坏了", "卡", "闪退", "崩溃", "死"];
  const featureCount = featureWords.filter((w) => hay.includes(w)).length;
  const bugCount = bugWords.filter((w) => hay.includes(w)).length;
  if (bugCount > featureCount) return "bug";
  if (featureCount > 0 && featureCount >= bugCount) return "feature";
  return "other";
}

/**
 * 前置：prompt 阶段根据启发式猜测类别选择区块组。未配置分类组时回落到 options.sections。
 */
function resolvePromptSections(
  options: Pick<IssueAnalyzerOptions, "sections" | "sectionsByCategory">,
  context: IssueContext,
): ReadonlySet<IssueResultSection> | undefined {
  if (!options.sectionsByCategory) return options.sections;
  const category = guessIssueCategory(context);
  const key: "bug" | "feature" | "default" =
    category === "other" ? "default" : category;
  return (
    options.sectionsByCategory[key] ??
    options.sectionsByCategory.default ??
    options.sections
  );
}

/**
 * 后置：按模型输出的真实 category 选择区块组。未配置该类别时回落到 default / options.sections。
 */
function resolveResultSections(
  options: Pick<IssueAnalyzerOptions, "sections" | "sectionsByCategory">,
  category: string,
): ReadonlySet<IssueResultSection> | undefined {
  if (!options.sectionsByCategory) return options.sections;
  const key = category === "bug" || category === "feature" ? category : "default";
  return (
    options.sectionsByCategory[key] ??
    options.sectionsByCategory.default ??
    options.sections
  );
}

/**
 * 结果区块后置过滤：关闭的区块在 prompt 里已不要求输出，但模型仍可能不守约，
 * 这里对校验后的结果强制清空对应字段，保证评论 / 结果页 / 标签都不再出现。
 * summary 始终保留（契约硬性要求）。缺省（sections 未传）不修改原结果。
 */
function applyResultSections(
  graded: GradedIssueAnalysis,
  sections?: ReadonlySet<IssueResultSection>,
): GradedIssueAnalysis {
  if (!sections) return graded;
  const result = graded.result;
  // 先剔除可选字段：条件展开只能「加」不能「删」，留着会在 ...result 时被原样带回。
  const {
    suggestedTitle: _title,
    probableCause: _cause,
    suggestedAssignee: _assignee,
    ...rest
  } = result;

  const next: IssueAnalysisResult = {
    ...rest,
    troubleshooting: sections.has("troubleshooting")
      ? result.troubleshooting
      : [],
    proposedChanges: sections.has("proposed_changes")
      ? result.proposedChanges
      : [],
    evidence: sections.has("evidence") ? result.evidence : [],
    missingInformation: sections.has("missing_information")
      ? result.missingInformation
      : [],
    suggestedLabels: sections.has("suggested_labels")
      ? result.suggestedLabels
      : [],
    suggestedActions: sections.has("suggested_actions")
      ? result.suggestedActions
      : [],
    ...(sections.has("suggested_title") && result.suggestedTitle !== undefined
      ? { suggestedTitle: result.suggestedTitle }
      : {}),
    ...(sections.has("probable_cause") && result.probableCause !== undefined
      ? { probableCause: result.probableCause }
      : {}),
    ...(sections.has("suggested_assignee") &&
    result.suggestedAssignee !== undefined &&
    result.suggestedAssignee.length > 0
      ? { suggestedAssignee: result.suggestedAssignee }
      : {}),
  };

  return { ...graded, result: next };
}

/**
 * Runs the main analysis, validates the contract, and performs exactly one
 * bounded repair when the contract fails. A still-invalid result is reported
 * as `invalid` so the engine can retry the task; no automatic decision is
 * ever published from an unvalidated response.
 */
export async function analyzeIssue(
  options: IssueAnalyzerOptions,
  context: IssueContext,
): Promise<IssueAnalysisOutcome> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const remainingMsFrom = () =>
    Math.max(0, options.deadlineMs - (now() - startedAt));

  /** 单次模型调用，共享同一个逻辑 deadline。 */
  const invokeOnce = (request: ModelInvocationRequest) =>
    routeModelInvocation(options.adapters, {
      candidates: options.candidates,
      request,
      deadlineMs: remainingMsFrom(),
      retryPolicy: options.retryPolicy,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      now,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });

  // 空响应重试（与 pr-review 工具循环的 invokeWithEmptyRetry 同策略）：部分
  // reasoning 模型（如 DeepSeek/MiniMax 渠道）在携带预读源码的大请求下偶发
  // 返回「既无 content 也无 tool_calls」的空消息。这是瞬态抖动而非真实失败，
  // 直接上抛会让整个分析无谓地致命失败（issue #72 现场）。
  const invokeOnceWithEmptyRetry: typeof invokeOnce = async (request) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await invokeOnce(request);
      } catch (error) {
        const emptyResponse =
          error instanceof Error &&
          /did not contain message content/.test(error.message);
        if (!emptyResponse || attempt >= 2) throw error;
      }
    }
  };

  // 工具探索复用 PR 审查已验证的循环实现，它自行构造请求并注入工具定义。
  // 仍保留 main 这次路由调用：candidate 供修复阶段 sticky，attempts/usage
  // 供 attempt 记账，两者都无法从循环内部获得。代价是开启探索时多一次调用，
  // 这也是该能力默认关闭的原因之一。
  //
  // codeAccess 随 tools 同步注入提示词：有工具 → 模型可读源码，路径可精确；
  // 无工具 → 系统消息末尾追加「当前代码访问」段落，明令禁止编造文件路径。
  const codeAccess: "enabled" | "disabled" = options.tools
    ? "enabled"
    : "disabled";
  const main = await invokeOnceWithEmptyRetry(
    buildIssueAnalysisRequest(
      context,
      options.promptVersion,
      options.promptMode,
      resolvePromptSections(options, context),
      codeAccess,
    ),
  );
  let mainContent = main.response.content;
  if (options.tools) {
    const loop = await runToolLoop(
      (request) => invokeOnceWithEmptyRetry(request).then((result) => result.response),
      buildIssueAnalysisMessages(
        context,
        options.promptVersion,
        options.promptMode,
        resolvePromptSections(options, context),
        codeAccess,
      ),
      options.tools.context,
      {
        tools: builtinTools(),
        exploreInstruction:
          "你可以调用 read_file / list_directory / get_git_info 查看仓库源码，" +
          "以定位这个 Issue 描述的问题出在哪个文件。请先定位再作答：\n" +
          "- 第一步必须用 list_directory 且 path 传空字符串 \"\" 查看仓库根目录，" +
          "再据结果用相对路径进子目录；绝对路径与 /home/user/repos/... 这类仓库名/用户目录前缀一律无效，不要编造。\n" +
          "- 优先读 README 等文档，理解该功能 / 命令 / 指令的正确使用与触发方式，" +
          "据此判断报告者的操作是否符合预期（很多「指令没反应 / 按钮不存在」其实是触发方式问题，先自查再下结论）。\n" +
          "- 如果用户点名要求检查某个文件或代码（如「检查 main.py 的 bug」），必须当场" +
          "用 read_file 读取该文件（连同其依赖/同目录文件），逐条找出真实代码错误并回报，" +
          "不要只做成建议步骤或反问更多信息。\n" +
          "proposedChanges 里的 path 必须是你确实读到过的真实文件；找不到相关代码时省略该字段并说明原因，不要凭猜测编造路径或行号。",
        ...(options.tools.maxRounds === undefined
          ? {}
          : { maxRounds: options.tools.maxRounds }),
        ...(options.tools.forceToolUse === undefined
          ? {}
          : { forceToolUse: options.tools.forceToolUse }),
      },
    );
    mainContent =
      loop.messages[loop.messages.length - 1]?.content ?? main.response.content;
  }

  // exploredCode 决定服务端是否保留 proposedChanges 的行号定位。
  const gradingOptions = { exploredCode: options.tools !== undefined };
  const validation = parseIssueAnalysisJson(mainContent, gradingOptions);
  if (validation.outcome === "valid") {
    return {
      outcome: "valid",
      analysis: applyResultSections(
        validation.analysis,
        resolveResultSections(options, validation.analysis.result.category),
      ),
      usage: main.response.usage,
      candidate: main.candidate,
      attempts: main.attempts,
      durationMs: now() - startedAt,
    };
  }

  const remainingMs = remainingMsFrom();
  const repair = await routeModelInvocation(options.adapters, {
    candidates: options.candidates,
    request: buildIssueAnalysisRepairRequest(
      context,
      // 修复要基于实际待修的那份输出：开启探索时是循环结果，而非被丢弃的首答。
      mainContent,
      validation.issues,
      options.promptVersion,
      options.promptMode,
      resolvePromptSections(options, context),
      codeAccess,
    ),
    deadlineMs: remainingMs,
    retryPolicy: options.retryPolicy,
    // Prefer the candidate that already answered, so repairs stay consistent.
    stickyCandidate: main.candidate,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    now,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });

  const repaired = parseIssueAnalysisJson(
    repair.response.content,
    gradingOptions,
  );
  const attempts = [...main.attempts, ...repair.attempts];
  const usage = totalUsage(main.response.usage, repair.response.usage);

  if (repaired.outcome === "valid") {
    return {
      outcome: "valid",
      analysis: applyResultSections(
        repaired.analysis,
        resolveResultSections(options, repaired.analysis.result.category),
      ),
      usage,
      candidate: repair.candidate,
      attempts,
      durationMs: now() - startedAt,
    };
  }

  // 宽松降级（issue #60）：代码审查请求（外部仓库「帮我检查 xxx 的 bug」）的模型
  // 输出是自由格式缺陷清单，JSON 契约校验天然难以通过，main + repair 两次都拿不
  // 到合法 JSON 时仍不回泛化失败，而是把评审产物直接发布——用户要的是缺陷结论，
  // 不是「分析未完成」。
  if (isCodeReviewRequest(context)) {
    const raw = repair.response.content.trim();
    if (raw.length > 0) {
      return lenientCodeReviewOutcome(
        raw,
        usage,
        repair.candidate,
        attempts,
        now() - startedAt,
      );
    }
  }

  return { outcome: "invalid", usage, attempts, durationMs: now() - startedAt };
}
