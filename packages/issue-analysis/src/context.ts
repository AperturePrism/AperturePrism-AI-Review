import type {
  GitHubClient,
  GitHubIssue,
} from "../../../packages/github-adapter/src/index.js";
import type { ModelImagePart } from "../../../packages/domain/src/index.js";

export type IssueContextInput = {
  installationId: string;
  owner: string;
  name: string;
  number: number;
};

export type IssueCommentDocument = {
  author: string | null;
  body: string;
  createdAt: string;
};

export type IssueDocument = GitHubIssue;

export type IssueContext = {
  repository: { owner: string; name: string };
  /** 供代码探索使用：读取仓库文件需要 installation 授权。 */
  installationId: string;
  issue: IssueDocument;
  comments: readonly IssueCommentDocument[];
  /** Why the context was reduced below the full source, for the prompt. */
  degraded: readonly string[];
  /**
   * 多模态图片（issue_vision_enabled 开启时下载自 Issue 正文 / 评论的图）。
   * 默认空数组；有内容时随 user 消息以 OpenAI image_url 块发给模型。
   */
  images: readonly ModelImagePart[];
  /** Estimated input tokens consumed by the rendered issue context. */
  estimatedTokens: number;
  /** Consolidated repo memory (rules/knowledge), rendered as reference text. */
  repoMemory?: string;
  /** 仓库 `.apertureprism/rules/` 目录下的审核规则（Sakura 式专属文件夹）。 */
  repoRules?: string;
  /**
   * 方案B：服务端主动预读的目标文件源码（审查/缺陷请求注入）。模型不必依赖
   * 调用 read_file（deepseek 对 function-calling 不稳定）即可直接看到代码；
   * 内容由 worker 用 installation 读取，仅作待分析数据注入，非用户指令。
   */
  preloadedFiles?: { path: string; content: string }[];
};

export type IssueContextBudget = {
  /** Rough token ceiling for the issue context portion of the prompt. */
  maxTokens: number;
  /** Character ceiling for a single oversized body. */
  maxBodyChars: number;
  /** Newest comments to consider; zero omits all comments. */
  maxComments: number;
};

export const DEFAULT_CONTEXT_BUDGET: IssueContextBudget = {
  maxTokens: 8_000,
  maxBodyChars: 10_000,
  maxComments: 20,
};

/** A coarse heuristic (~4 chars per token) used only for budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncateBody(
  body: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (body.length <= maxChars) return { text: body, truncated: false };
  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = maxChars - headChars;
  return {
    text: `${body.slice(0, headChars)}\n\n…[正文过长，已截取开头与结尾]…\n\n${body.slice(-tailChars)}`,
    truncated: true,
  };
}

/**
 * Fetches the issue and its comments and keeps the model-relevant content
 * inside the token budget. Degradation drops lower-value content (comments
 * first) and only then trims the body, preserving both head and tail instead
 * of truncating into an arbitrary, meaningless slice.
 */
export async function buildIssueContext(
  github: GitHubClient,
  input: IssueContextInput,
  budget: IssueContextBudget = DEFAULT_CONTEXT_BUDGET,
  signal?: AbortSignal,
): Promise<IssueContext> {
  const [issue, allComments] = await Promise.all([
    github.getIssue(input, signal),
    github.listIssueComments(input, signal),
  ]);

  const degraded: string[] = [];
  let body = issue.body;
  let comments =
    budget.maxComments > 0 ? allComments.slice(-budget.maxComments) : [];

  const baseTokens = estimateTokens(issue.title) + estimateTokens(body);
  const commentTokens = comments.reduce(
    (sum, comment) => sum + estimateTokens(comment.body),
    0,
  );
  if (baseTokens + commentTokens > budget.maxTokens) {
    degraded.push("comments_dropped");
    comments = [];
  }

  if (estimateTokens(issue.title) + estimateTokens(body) > budget.maxTokens) {
    const trimmed = truncateBody(body, budget.maxBodyChars);
    body = trimmed.text;
    if (trimmed.truncated) degraded.push("issue_body_truncated");
  }

  // Hard safety cap so the rendered context never exceeds the budget.
  const bodyCharBudget = Math.max(
    0,
    budget.maxTokens * 4 - estimateTokens(issue.title) * 4,
  );
  if (body.length > bodyCharBudget) {
    body = `${body.slice(0, bodyCharBudget)}\n\n…[上下文超限，其余内容省略]…`;
    degraded.push("issue_body_capped");
  }

  const estimatedTokens =
    estimateTokens(issue.title) +
    estimateTokens(body) +
    comments.reduce((sum, comment) => sum + estimateTokens(comment.body), 0);

  return {
    repository: { owner: input.owner, name: input.name },
    installationId: input.installationId,
    issue: { ...issue, body },
    comments,
    degraded,
    images: [],
    estimatedTokens,
  };
}
