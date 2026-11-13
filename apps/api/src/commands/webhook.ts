/**
 * commands/webhook
 * 调用示例：handleIssueCommentCommand(request, response, requestId)。
 * HTTP 路径保持兼容；跨文件依赖在下方显式列出。
 */
import type { HttpRoute } from "../utils/routes.js";
import {
  repositories,
  readPreviousValueWithinGrace,
  ingestGitHubWebhook,
} from "../../../../packages/database/src/index.js";
import {
  type NormalizedGitHubEvent,
  parseIssueCommand,
  verifyWebhookSignature,
  normalizeGitHubEvent,
  WebhookSignatureError,
  UnsupportedGitHubEventError,
} from "../../../../packages/github-adapter/src/index.js";
import {
  repositoryOwnerName,
  ISSUE_ANALYSIS_POLICY_VERSION,
} from "../../../../packages/issue-analysis/src/index.js";
import { metrics } from "../../../../packages/observability/src/index.js";
import { PR_REVIEW_POLICY_VERSION } from "../../../../packages/pr-review/src/index.js";
import { createAnalysisTask } from "../../../../packages/task-engine/src/index.js";
import { githubClientPromise } from "../github.js";
import { audit } from "../identity.js";
import { webhookEnabled, webhookSecret } from "../preferences.js";
import { database, logger } from "../runtime.js";
import { json, readBody } from "../utils/http.js";
import { and, eq } from "drizzle-orm";
import { type IncomingMessage, type ServerResponse } from "node:http";

/* ---------- Issue/PR comment command triggers ---------- */

const ISSUE_COMMAND_HELP = [
  "可用的指令（直接在 Issue / PR 评论里输入）：",
  "- `/analyze` 或 `/apertureprism analyze` — 触发 Issue 分析",
  "- `/review` 或 `/apertureprism review` — 触发 PR 代码审查（需在 PR 评论中）",
  "- `/help` 或 `/apertureprism help` — 显示本帮助",
].join("\n");

type CommentCommandOutcome =
  | { kind: "none" }
  | { kind: "help" }
  | {
      kind: "triggered";
      taskType: "issue_analysis" | "pr_review";
      taskId: string;
    }
  | { kind: "error"; reason: string };

/**
 * Reacts to `issue_comment` webhooks that carry a trigger command
 * (`/analyze`, `/review`, `/help`). Creates the matching task and replies with
 * an acknowledgement comment. Bot-authored comments are ignored to avoid
 * reply loops; comment posting failures are logged and never fail the webhook.
 */
async function handleIssueCommentCommand(
  event: NormalizedGitHubEvent,
): Promise<CommentCommandOutcome> {
  const payload = (event.payload ?? {}) as {
    comment?: { body?: string };
    issue?: { pull_request?: unknown };
    sender?: { type?: string };
  };
  if (payload.sender?.type === "Bot") return { kind: "none" };
  const command = parseIssueCommand(payload.comment?.body ?? "");
  if (command.kind === "none") return { kind: "none" };

  const fullName = event.repositoryFullName ?? "";
  const identity = repositoryOwnerName(fullName);
  const issueNumber = event.subjectNumber;
  if (!identity || issueNumber === null)
    return { kind: "error", reason: "missing_repository_context" };
  const subjectNumber: number = issueNumber;
  const owner = identity.owner;
  const repoName = identity.name;
  const rows = await database.db
    .select({
      id: repositories.id,
      githubId: repositories.githubId,
      installationId: repositories.installationId,
    })
    .from(repositories)
    .where(and(eq(repositories.owner, owner), eq(repositories.name, repoName)))
    .limit(1);
  const repo = rows[0];
  if (!repo || !repo.installationId)
    return { kind: "error", reason: "repository_not_installed" };
  const installationId = repo.installationId;
  const github = await githubClientPromise;

  const postComment = (body: string): void => {
    if (!github) return;
    void github
      .createIssueComment({
        installationId,
        owner,
        name: repoName,
        number: subjectNumber,
        body,
      })
      .catch((error: unknown) =>
        logger.warn({ err: error }, "command ack comment failed"),
      );
  };

  if (command.kind === "help") {
    void postComment(ISSUE_COMMAND_HELP);
    return { kind: "help" };
  }

  if (command.kind === "analyze") {
    const subjectRevision = new Date().toISOString();
    const result = await createAnalysisTask(database.db, {
      taskType: "issue_analysis",
      repositoryId: repo.id,
      subjectNumber: issueNumber,
      subjectRevision,
      policyVersion: ISSUE_ANALYSIS_POLICY_VERSION,
      dedupeKey: `issue-analysis:${repo.id}:${issueNumber}:${subjectRevision}:${ISSUE_ANALYSIS_POLICY_VERSION}`,
      payload: {
        installationId: repo.installationId,
        repositoryExternalId: repo.githubId,
        repositoryFullName: fullName,
        subjectNumber: issueNumber,
        subjectRevision,
        sourceEvent: "issue_comment_command",
        command: "analyze",
      },
    });
    void postComment(
      `已触发 Issue 分析，结果将发布为本 Issue 的评论（任务 ${result.task.id.slice(0, 8)}）。`,
    );
    return {
      kind: "triggered",
      taskType: "issue_analysis",
      taskId: result.task.id,
    };
  }

  // review: only valid on pull requests; needs the PR head SHA as revision.
  if (!github) {
    void postComment("GitHub App 未配置，无法触发 PR 审查。");
    return { kind: "error", reason: "github_not_configured" };
  }
  if (!payload.issue?.pull_request) {
    void postComment("该评论所在的对象不是 Pull Request，无法触发代码审查。");
    return { kind: "error", reason: "not_a_pull_request" };
  }
  try {
    const pullRequest = await github.getPullRequest({
      installationId: repo.installationId,
      owner: identity.owner,
      name: identity.name,
      number: issueNumber,
    });
    const subjectRevision = pullRequest.headSha;
    const result = await createAnalysisTask(database.db, {
      taskType: "pr_review",
      repositoryId: repo.id,
      subjectNumber: issueNumber,
      subjectRevision,
      policyVersion: PR_REVIEW_POLICY_VERSION,
      dedupeKey: `pr-review:${repo.id}:${issueNumber}:${subjectRevision}:${PR_REVIEW_POLICY_VERSION}`,
      payload: {
        installationId: repo.installationId,
        repositoryExternalId: repo.githubId,
        repositoryFullName: fullName,
        subjectNumber: issueNumber,
        subjectRevision,
        sourceEvent: "issue_comment_command",
        command: "review",
      },
    });
    void postComment(
      `已触发 PR 代码审查，结果将发布为该 PR 的 Review（任务 ${result.task.id.slice(0, 8)}）。`,
    );
    return {
      kind: "triggered",
      taskType: "pr_review",
      taskId: result.task.id,
    };
  } catch (error) {
    logger.warn({ err: error }, "command review trigger failed");
    void postComment("触发 PR 审查失败：无法读取该 PR 的最新提交。");
    return { kind: "error", reason: "pr_fetch_failed" };
  }
}

/**
 * Webhook 自检（issue #22/#23 排查经验的沉淀）：GitHub 侧路径配错、签名不一致、
 * 入口不通，这三类故障此前只能靠人肉对比配置 + 手工 curl。GitHub 不提供可程序化
 * 触发的 App 级 ping（/app/hook/ping|pings 均 404），自检改为两步：读 GitHub 侧
 * 实际配置 + 统计最近投递的成功率，据此给出中文诊断。
 */
export async function handleWebhookSelfTest(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const github = await githubClientPromise;
  if (!github) {
    json(
      response,
      503,
      { status: "error", reason: "github_app_not_configured" },
      requestId,
    );
    return;
  }
  try {
    // 第一步：GitHub 侧实际配置（URL 错误是最常见根因）。
    const hookConfig = await github.getWebhookConfig();
    // 第二步：最近投递记录（新→旧）的成功率。
    const deliveries = await github.listRecentWebhookDeliveries();
    const recent = deliveries.slice(0, 5);
    const okCount = recent.filter(
      (entry) => entry.statusCode !== null && entry.statusCode < 400,
    ).length;
    const latest = recent[0] ?? null;

    const urlLooksRight = hookConfig.url.endsWith("/github/webhook");
    let diagnosis: string;
    if (!urlLooksRight) {
      diagnosis = `webhook URL 应以 /github/webhook 结尾，当前为「${hookConfig.url || "（空）"}」——这是投递失败最常见的原因，请在 GitHub App 设置页修正`;
    } else if (recent.length === 0) {
      diagnosis =
        "配置正确但还没有任何投递记录：新建或编辑一个 Issue 即会产生事件，几秒后再点一次自检";
    } else if (okCount === recent.length) {
      diagnosis = `链路正常：最近 ${recent.length} 次投递全部成功（最新 ${latest?.event} → ${latest?.statusCode}）`;
    } else {
      const lastFail = recent.find(
        (entry) => entry.statusCode !== null && entry.statusCode >= 400,
      );
      diagnosis = `最近 ${recent.length} 次投递中 ${recent.length - okCount} 次失败（如 ${lastFail?.event} → ${lastFail?.statusCode}）：签名不一致通常表现为非 2xx，请核对 Webhook 签名密钥与 env 是否一致`;
    }

    audit(request, "webhook.selftest", hookConfig.url, {
      urlLooksRight,
      okCount,
      total: recent.length,
    });
    json(
      response,
      200,
      {
        status: "ok",
        webhookUrl: hookConfig.url,
        urlLooksRight,
        contentType: hookConfig.contentType,
        recentDeliveries: recent.map((entry) => ({
          event: entry.event,
          statusCode: entry.statusCode,
          deliveredAt: entry.deliveredAt,
        })),
        diagnosis,
      },
      requestId,
    );
  } catch (error) {
    logger.warn({ err: error }, "webhook self-test failed");
    json(
      response,
      502,
      {
        status: "error",
        reason: "selftest_failed",
        detail: error instanceof Error ? error.message : String(error),
      },
      requestId,
    );
  }
}

export async function handleWebhook(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  if (!webhookEnabled()) {
    json(
      response,
      503,
      { status: "error", reason: "GitHub webhook is not enabled" },
      requestId,
    );
    return;
  }
  const body = await readBody(request);
  try {
    // 轮换宽限期内双密钥接收：先用当前密钥验签，失败再试旧值（换密钥时对端
    // 可能还在用旧密钥推送）。
    const signature =
      typeof request.headers["x-hub-signature-256"] === "string"
        ? request.headers["x-hub-signature-256"]
        : undefined;
    const secrets = [webhookSecret()];
    try {
      // 轮换回退是增强：数据库不可用时（如测试/启动早期）不阻塞验签。
      const previous = await readPreviousValueWithinGrace(
        database.db,
        "github_webhook_secret",
      );
      if (previous) secrets.push(previous);
    } catch {
      // best-effort：继续只用当前密钥验签。
    }
    let verified = false;
    let lastError: unknown;
    for (const secret of secrets) {
      try {
        verifyWebhookSignature(body, signature, secret);
        verified = true;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!verified) throw lastError;
    const deliveryId = request.headers["x-github-delivery"]?.toString();
    const eventName = request.headers["x-github-event"]?.toString();
    if (!deliveryId || !eventName) {
      json(
        response,
        400,
        { status: "error", reason: "missing GitHub webhook headers" },
        requestId,
      );
      return;
    }
    const normalized = normalizeGitHubEvent(
      eventName,
      deliveryId,
      JSON.parse(body.toString("utf8")),
    );
    const policyVersion =
      normalized.eventName === "pull_request"
        ? PR_REVIEW_POLICY_VERSION
        : ISSUE_ANALYSIS_POLICY_VERSION;
    const result = await ingestGitHubWebhook(
      database.db,
      normalized,
      policyVersion,
    );
    metrics.increment("webhook.deliveries");
    metrics.increment(`webhook.outcome.${result.outcome}`);
    // Issue/PR comment commands (e.g. "/apertureprism analyze") trigger tasks.
    const commandOutcome =
      normalized.eventName === "issue_comment"
        ? await handleIssueCommentCommand(normalized)
        : { kind: "none" as const };
    const duplicate = result.outcome === "delivery_duplicate";
    json(
      response,
      duplicate ? 200 : 202,
      {
        status: "accepted",
        duplicate,
        outcome: result.outcome,
        ...("taskId" in result ? { taskId: result.taskId } : {}),
        ...commandOutcome,
      },
      requestId,
    );
  } catch (error) {
    if (error instanceof WebhookSignatureError) {
      json(
        response,
        401,
        { status: "error", reason: "invalid webhook signature" },
        requestId,
      );
      return;
    }
    if (error instanceof SyntaxError) {
      json(
        response,
        400,
        { status: "error", reason: "invalid JSON payload" },
        requestId,
      );
      return;
    }
    // 不在处理范围的事件（check_suite / check_run / workflow_run 等，GitHub App
    // 订阅 check_suite 用于 PR 审查的 check run）必须 2xx 确认收讫，否则 GitHub
    // 记为投递失败并重试，Webhook 自检的最近投递成功率会常年被这些噪声拉低
    // （NAS 实测：最近 5 条投递全是 check_suite → 500，误报「签名不一致」）。
    if (error instanceof UnsupportedGitHubEventError) {
      metrics.increment("webhook.unsupported_event");
      json(
        response,
        202,
        {
          status: "accepted",
          outcome: "ignored",
          reason: "unsupported_event",
        },
        requestId,
      );
      return;
    }
    throw error;
  }
}

// HTTP 入口与业务放在同一处：新增同类入口只修改本文件。
export const routes = [
  { path: "/github/webhook", methods: ["POST"], handle: handleWebhook },
  {
    path: "/webhook-selftest",
    methods: ["POST"],
    admin: true,
    handle: handleWebhookSelfTest,
  },
] satisfies readonly HttpRoute[];
