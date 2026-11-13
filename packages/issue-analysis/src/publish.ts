import type { GitHubClient } from "../../../packages/github-adapter/src/index.js";

/**
 * The persisted bookkeeping a publication needs. The worker supplies a
 * Drizzle-backed implementation so this module never imports Drizzle tables.
 */
export type PublicationStore = {
  /** External object id already recorded for this key, if any. */
  findExternalObjectId: (idempotencyKey: string) => Promise<string | null>;
  insert: (input: {
    taskId: string;
    idempotencyKey: string;
    externalObjectId: string;
    channel: string;
  }) => Promise<void>;
  touch: (idempotencyKey: string) => Promise<void>;
};

export type PublishIssueCommentInput = {
  store: PublicationStore;
  github: GitHubClient;
  taskId: string;
  installationId: string;
  owner: string;
  name: string;
  issueNumber: number;
  /** Stable across retries so a retried task never posts a second comment. */
  idempotencyKey: string;
  body: string;
  signal?: AbortSignal;
};

export type PublishIssueCommentResult = {
  commentId: number;
  created: boolean;
};

/**
 * Creates the comment on its first call and updates it in place on later
 * calls, so retries and the placeholder->final transition never produce a
 * duplicate. The external_object_id is persisted so a crash mid-publish can
 * be resumed instead of creating an orphan comment.
 */
export async function publishIssueComment(
  input: PublishIssueCommentInput,
): Promise<PublishIssueCommentResult> {
  input.signal?.throwIfAborted();
  const externalObjectId = await input.store.findExternalObjectId(
    input.idempotencyKey,
  );

  if (externalObjectId) {
    input.signal?.throwIfAborted();
    const updated = await input.github.updateIssueComment(
      {
        installationId: input.installationId,
        owner: input.owner,
        name: input.name,
        commentId: Number(externalObjectId),
        body: input.body,
      },
      input.signal,
    );
    await input.store.touch(input.idempotencyKey);
    return { commentId: updated.id, created: false };
  }

  input.signal?.throwIfAborted();
  const created = await input.github.createIssueComment(
    {
      installationId: input.installationId,
      owner: input.owner,
      name: input.name,
      number: input.issueNumber,
      body: input.body,
    },
    input.signal,
  );
  await input.store.insert({
    taskId: input.taskId,
    idempotencyKey: input.idempotencyKey,
    externalObjectId: String(created.id),
    channel: "github_issue_comment",
  });
  return { commentId: created.id, created: true };
}
