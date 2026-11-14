import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { CreateTaskInput } from "../../../packages/domain/src/index.js";

export * from "./client.js";
export * from "./rules.js";
export * from "./rule-source.js";

export type GitHubEventName =
  "issues" | "issue_comment" | "pull_request" | "ping";

export type NormalizedGitHubEvent = {
  deliveryId: string;
  eventName: GitHubEventName;
  action: string;
  installationId: string | null;
  repositoryId: string | null;
  repositoryFullName: string | null;
  subjectNumber: number | null;
  subjectRevision: string | null;
  /** Login of the account that triggered the event, e.g. `octocat[bot]`. */
  senderLogin: string | null;
  /** True when GitHub marks the sender as a Bot account. */
  senderIsBot: boolean;
  receivedAt: string;
  payload: unknown;
};

export type GitHubTaskMapping =
  | { outcome: "task"; task: CreateTaskInput }
  | { outcome: "ignored"; reason: string }
  | { outcome: "invalid"; reason: string };

export class WebhookSignatureError extends Error {
  constructor() {
    super("invalid GitHub webhook signature");
    this.name = "WebhookSignatureError";
  }
}

export class UnsupportedGitHubEventError extends Error {
  constructor(eventName: string) {
    super(`unsupported GitHub event: ${eventName}`);
    this.name = "UnsupportedGitHubEventError";
  }
}

export function verifyWebhookSignature(
  payload: Buffer,
  signature: string | undefined,
  secret: string,
): void {
  if (!signature?.startsWith("sha256=") || !secret)
    throw new WebhookSignatureError();
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`,
  );
  const received = Buffer.from(signature);
  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  ) {
    throw new WebhookSignatureError();
  }
}

function stringValue(value: unknown): string | null {
  return (typeof value === "string" || typeof value === "number") &&
    String(value).length > 0
    ? String(value)
    : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeGitHubEvent(
  eventName: string,
  deliveryId: string,
  payload: unknown,
  receivedAt = new Date().toISOString(),
): NormalizedGitHubEvent {
  if (
    !["issues", "issue_comment", "pull_request", "ping"].includes(eventName)
  ) {
    throw new UnsupportedGitHubEventError(eventName);
  }
  const root = objectValue(payload);
  const repository = objectValue(root.repository);
  const installation = objectValue(root.installation);
  const issue = objectValue(root.issue);
  const pullRequest = objectValue(root.pull_request);
  const subject = eventName === "pull_request" ? pullRequest : issue;
  const sender = objectValue(root.sender);
  const senderLogin = stringValue(sender.login);

  return {
    deliveryId,
    eventName: eventName as GitHubEventName,
    action: stringValue(root.action) ?? "unknown",
    installationId: stringValue(installation.id),
    repositoryId: stringValue(repository.id),
    repositoryFullName: stringValue(repository.full_name),
    subjectNumber: numberValue(subject.number),
    subjectRevision:
      eventName === "pull_request"
        ? stringValue(pullRequest.head && objectValue(pullRequest.head).sha)
        : stringValue(issue.updated_at),
    senderLogin,
    senderIsBot:
      stringValue(sender.type) === "Bot" ||
      (senderLogin !== null && senderLogin.endsWith("[bot]")),
    receivedAt,
    payload,
  };
}

const issueActions = new Set(["opened", "edited", "reopened"]);
const pullRequestActions = new Set(["opened", "reopened", "synchronize"]);

function policyRevision(event: NormalizedGitHubEvent): string {
  return createHash("sha256")
    .update(
      [
        event.eventName,
        event.repositoryId,
        event.subjectNumber,
        event.subjectRevision,
      ].join(":"),
    )
    .digest("hex");
}

export function mapGitHubEventToTask(
  event: NormalizedGitHubEvent,
  repositoryId: string,
  policyVersion: string,
): GitHubTaskMapping {
  if (event.eventName === "ping") return { outcome: "ignored", reason: "ping" };
  if (event.eventName === "issue_comment")
    return { outcome: "ignored", reason: "comment_commands_not_enabled" };
  // Posting or editing our own analysis comment bumps the issue's updated_at,
  // which is the issue revision. Without this guard that arrives back as an
  // `edited` event with a fresh revision, so it dedupes as a new task and
  // publishes another comment — a self-sustaining loop (observed on #2).
  if (event.senderIsBot)
    return { outcome: "ignored", reason: "bot_originated_event" };
  if (
    (event.eventName === "issues" && !issueActions.has(event.action)) ||
    (event.eventName === "pull_request" &&
      !pullRequestActions.has(event.action))
  ) {
    return { outcome: "ignored", reason: "unsupported_action" };
  }
  if (!event.repositoryId || !event.repositoryFullName)
    return { outcome: "invalid", reason: "missing_repository" };
  if (event.subjectNumber === null)
    return { outcome: "invalid", reason: "missing_subject_number" };
  if (!event.subjectRevision)
    return { outcome: "invalid", reason: "missing_subject_revision" };

  const taskType =
    event.eventName === "issues" ? "issue_analysis" : "pr_review";
  const keyPrefix =
    event.eventName === "issues" ? "issue-analysis" : "pr-review";
  return {
    outcome: "task",
    task: {
      taskType,
      repositoryId,
      subjectNumber: event.subjectNumber,
      subjectRevision: event.subjectRevision,
      policyVersion,
      dedupeKey: `${keyPrefix}:${repositoryId}:${event.subjectNumber}:${event.subjectRevision}:${policyVersion}`,
      payload: {
        installationId: event.installationId,
        repositoryExternalId: event.repositoryId,
        repositoryFullName: event.repositoryFullName,
        subjectNumber: event.subjectNumber,
        subjectRevision: event.subjectRevision,
        sourceEvent: event.eventName,
        // action 必须带进 payload：worker 要区分「新开 Issue」和「编辑 Issue」
        // 才能对后者按变化幅度决定是否重新分析，而它只能看到 payload。
        sourceAction: event.action,
        sourceRevision: policyRevision(event),
      },
    },
  };
}

/* ---------- Issue/PR comment commands (e.g. "/apertureprism analyze") ---------- */

export type IssueCommand =
  | { kind: "analyze" }
  | { kind: "review" }
  | { kind: "help" }
  | { kind: "none" };

/**
 * Parses a comment body for a trigger command. The first non-empty, non-code
 * fence line is considered; a leading blockquote marker is stripped. Known
 * commands: `/analyze`, `/review`, `/help` (optionally prefixed with
 * `/apertureprism`). Anything else (including other bots' slash commands)
 * resolves to `none` so we never act on foreign commands.
 */
export function parseIssueCommand(body: string): IssueCommand {
  let line = "";
  let inFence = false;
  for (const raw of body.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (/^```/.test(trimmed) || /^~~~/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!trimmed) continue;
    line = trimmed.replace(/^>+\s?/, "").trim();
    break;
  }
  if (!line.startsWith("/")) return { kind: "none" };
  const parts = line.slice(1).split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { kind: "none" };
  const first = parts[0]!.toLowerCase();
  const second = parts[1]?.toLowerCase();
  const effective = first === "apertureprism" ? second : first;
  if (effective === "analyze") return { kind: "analyze" };
  if (effective === "review") return { kind: "review" };
  if (effective === "help") return { kind: "help" };
  return { kind: "none" };
}
