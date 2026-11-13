import type {
  GitHubClient,
  GitHubPullRequest,
} from "../../../packages/github-adapter/src/index.js";
import type { ModelMessage } from "../../../packages/domain/src/index.js";
import {
  DEFAULT_PR_REVIEW_BUDGET,
  renderDiffForModel,
  type PrReviewBudget,
  type RenderedPrContext,
} from "./context.js";
import { parseUnifiedDiff } from "./diff.js";
import type { ToolExecutionContext } from "./tools.js";

export type PrContextInput = {
  installationId: string;
  owner: string;
  name: string;
  pullNumber: number;
};

export type PrReviewContext = {
  repository: { owner: string; name: string };
  pullRequest: GitHubPullRequest;
  rendered: RenderedPrContext;
  /** Whether the diff itself could not be parsed (e.g. empty or oversized). */
  degraded: readonly string[];
  /** Consolidated repo memory (rules/knowledge), rendered as reference text. */
  repoMemory?: string;
  /** 仓库 `.apertureprism/rules/` 目录下的审核规则（Sakura 式专属文件夹）。 */
  repoRules?: string;
  /** 可选：AI 主动探索工具的仓库只读上下文（由 worker 注入）。 */
  toolsContext?: ToolExecutionContext;
  /** 可选：同一 PR 此前的审查对话（增量续跑，由 worker 注入）。 */
  reviewHistory?: readonly ModelMessage[];
};

/**
 * Fetches the pull request metadata and diff, parses the unified diff into a
 * file/hunk model, and runs it through the token-budget degradation so the
 * model only ever sees a documented, reviewable subset. A failure to fetch the
 * diff surfaces as a GitHub error; an unparseable/empty diff yields an empty
 * reviewable context rather than a hard failure.
 */
export async function buildPrContext(
  github: GitHubClient,
  input: PrContextInput,
  budget: PrReviewBudget = DEFAULT_PR_REVIEW_BUDGET,
  signal?: AbortSignal,
): Promise<PrReviewContext> {
  const [pullRequest, diffText] = await Promise.all([
    github.getPullRequest(
      {
        installationId: input.installationId,
        owner: input.owner,
        name: input.name,
        number: input.pullNumber,
      },
      signal,
    ),
    github.getPullRequestDiff(
      {
        installationId: input.installationId,
        owner: input.owner,
        name: input.name,
        number: input.pullNumber,
      },
      signal,
    ),
  ]);

  const parsed = parseUnifiedDiff(diffText);
  const rendered = renderDiffForModel(parsed, budget);

  // #62/审查一致性：模型（尤其 deepseek 类）常不调 read_file。主动预读变更文件原文，
  // 使其无需调用工具也能看到文件周边代码，避免小 PR 只按 diff 臆断而误报。
  const CHANGED_FILE_PRELOAD_MAX = 5;
  const CHANGED_FILE_PRELOAD_CHARS = 24_000;
  const CHANGED_FILE_PRELOAD_TOTAL = 60_000;
  const textFiles = parsed.files
    .filter((f) => f.hunks && f.hunks.length > 0)
    .map((f) => ({ path: f.newPath, churn: f.additions + f.deletions }))
    .sort((a, b) => b.churn - a.churn)
    .slice(0, CHANGED_FILE_PRELOAD_MAX);
  // GitHubClient returns normalized metadata, not GitHub's nested REST payload.
  // Pin preloads to the same revision as the reviewed change, including fork PRs.
  const headSha = pullRequest.headSha;
  const preloadedFiles: { path: string; content: string }[] = [];
  let preloadTotal = 0;
  for (const f of textFiles) {
    if (preloadTotal >= CHANGED_FILE_PRELOAD_TOTAL) break;
    try {
      const file = await github.getFileContents(
        {
          installationId: input.installationId,
          owner: input.owner,
          name: input.name,
          path: f.path,
          ref: headSha,
        },
        signal,
      );
      if (file && file.content) {
        const content = file.content.slice(0, CHANGED_FILE_PRELOAD_CHARS);
        preloadTotal += content.length;
        preloadedFiles.push({ path: f.path, content });
      }
    } catch {
      // 单个文件读取失败不阻断，保留其它可读文件。
    }
  }
  if (preloadedFiles.length > 0) rendered.preloadedFiles = preloadedFiles;

  return {
    repository: { owner: input.owner, name: input.name },
    pullRequest,
    rendered,
    degraded: rendered.degraded,
  };
}