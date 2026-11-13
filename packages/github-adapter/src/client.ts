import { createSign } from "node:crypto";

export type GitHubIssue = {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  htmlUrl: string;
  author: string | null;
  createdAt: string;
  updatedAt: string;
  labels: readonly string[];
};

export type GitHubIssueComment = {
  id: number;
  body: string;
  htmlUrl: string;
  author: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GitHubCreatedComment = {
  id: number;
  htmlUrl: string;
};

export type GitHubCreatedIssue = {
  number: number;
  htmlUrl: string;
};

export type GitHubPullRequest = {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  headSha: string;
  headRef: string;
  changedFiles: number;
  additions: number;
  deletions: number;
};

/** A repository installed to the GitHub App, from `GET /installation/repositories`. */
export type InstalledRepository = {
  id: number;
  owner: string;
  name: string;
  fullName: string;
};

export type GitHubErrorCategory =
  | "rate_limited"
  | "authentication_failed"
  | "not_found"
  | "server_error"
  | "invalid_request"
  | "network"
  | "canceled";

/**
 * A GitHub API failure mapped onto stable categories so callers can decide
 * whether a retry could ever help instead of swallowing provider specifics.
 */
export class GitHubApiError extends Error {
  readonly category: GitHubErrorCategory;
  readonly status: number | null;
  readonly retryAfterMs: number | undefined;

  constructor(
    category: GitHubErrorCategory,
    message: string,
    status: number | null,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
    this.category = category;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export type GitHubClientOptions = {
  appId: string;
  /** PEM-encoded GitHub App private key, used only to mint JWTs. */
  privateKeyPem: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export type InstallationToken = {
  token: string;
  expiresAt: string;
};

export type GitHubClient = {
  getInstallationToken: (
    installationId: string,
    signal?: AbortSignal,
  ) => Promise<InstallationToken>;
  /**
   * 读取 App 自身信息（GET /app，用 App JWT 认证）。用于在保存凭据时验证
   * appId 与私钥是否匹配 —— 不需要任何安装或仓库权限。
   */
  getAppMetadata: (
    signal?: AbortSignal,
  ) => Promise<{ id: number; slug: string; name: string }>;
  /**
   * 读取 App 级 webhook 配置（GET /app/hook/config，App JWT 认证）。
   * Webhook 自检第一步：先让用户看到 GitHub 侧实际配的 URL 是什么。
   */
  getWebhookConfig: (signal?: AbortSignal) => Promise<{
    url: string;
    contentType: string;
  }>;
  /**
   * 触发 App webhook 测试投递（POST /app/hook/pings，App JWT 认证）。GitHub
   * 会向配置的 URL 投递一个 ping 事件；204 表示 GitHub 已受理投递，实际到不到
   * 本服务还要看签名与入口连通性 —— 由随后查询最近投递结果来闭环。
   */
  pingAppWebhook: (signal?: AbortSignal) => Promise<void>;
  /** Webhook 最近投递概要（GET /app/hook/deliveries，App JWT 认证），新→旧。 */
  listRecentWebhookDeliveries: (
    signal?: AbortSignal,
  ) => Promise<
    readonly {
      id: string;
      event: string;
      statusCode: number | null;
      deliveredAt: string;
    }[]
  >;
  /**
   * Reads repository metadata (GET /repos/{owner}/{name}), primarily to learn
   * the default branch so repo-scoped file reads (rules folder etc.) can pin a
   * stable ref. Returns null when the repo is unknown to this installation.
   */
  getRepository: (
    input: {
      installationId: string;
      owner: string;
      name: string;
    },
    signal?: AbortSignal,
  ) => Promise<{ defaultBranch: string } | null>;
  getIssue: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      number: number;
    },
    signal?: AbortSignal,
  ) => Promise<GitHubIssue>;
  /** Lists repository issues (PRs excluded), newest first, paged. */
  listIssues: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      state?: "open" | "closed" | "all";
      perPage?: number;
      page?: number;
    },
    signal?: AbortSignal,
  ) => Promise<GitHubIssue[]>;
  /**
   * Lists accounts with push access, used as the default assignee set. Requires
   * the installation to have repository admin/metadata access; callers degrade
   * to the owner alone when it fails.
   */
  listCollaborators: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      perPage?: number;
    },
    signal?: AbortSignal,
  ) => Promise<string[]>;
  getPullRequest: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      number: number;
    },
    signal?: AbortSignal,
  ) => Promise<GitHubPullRequest>;
  /** Lists pull requests (PRs only, unlike `/issues`), newest first, paged. */
  listPullRequests: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      state?: "open" | "closed" | "all";
      perPage?: number;
      page?: number;
    },
    signal?: AbortSignal,
  ) => Promise<GitHubPullRequest[]>;
  /** Creates a new issue in the repository and returns its number + URL. */
  createIssue: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      title: string;
      body: string;
      labels?: readonly string[];
    },
    signal?: AbortSignal,
  ) => Promise<GitHubCreatedIssue>;
  /**
   * Patches an existing issue (rewrite title and/or assign users). Idempotent:
   * GitHub ignores unchanged fields and re-assigning the same assignee is a no-op.
   */
  updateIssue: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      number: number;
      title?: string;
      assignees?: readonly string[];
    },
    signal?: AbortSignal,
  ) => Promise<{ number: number; htmlUrl: string }>;
  /** Returns the raw unified diff text of a pull request. */
  getPullRequestDiff: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      number: number;
    },
    signal?: AbortSignal,
  ) => Promise<string>;
  /** Reads a single file's UTF-8 content at a ref via the contents API. */
  getFileContents: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      path: string;
      ref: string;
    },
    signal?: AbortSignal,
  ) => Promise<{ content: string; truncated?: boolean; sha?: string } | null>;
  /** Lists directory entries at a ref via the contents API. */
  listDirectory: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      path: string;
      ref: string;
    },
    signal?: AbortSignal,
  ) => Promise<{ name: string; path: string; type: string }[]>;
  /**
   * Creates or updates a file via the contents API (PUT /repos/{owner}/{name}/contents/{path}).
   * `sha` present → update (must match current blob sha); absent → create (fails if exists).
   * Used to seed an example rules file on a repo's first analysis and to edit rules from the WebUI.
   * Returns false if the file already exists (create mode) or the blob sha mismatched.
   */
  writeFileContents: (input: {
    installationId: string;
    owner: string;
    name: string;
    path: string;
    ref: string;
    content: string;
    sha?: string;
  }, signal?: AbortSignal) => Promise<boolean>;
  /**
   * Deletes a file via the contents API (DELETE /repos/{owner}/{name}/contents/{path}).
   * Requires the current blob sha. Returns false when the file does not exist.
   */
  deleteFileContents: (input: {
    installationId: string;
    owner: string;
    name: string;
    path: string;
    ref: string;
    sha: string;
  }, signal?: AbortSignal) => Promise<boolean>;
  listIssueComments: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      number: number;
    },
    signal?: AbortSignal,
  ) => Promise<GitHubIssueComment[]>;
  createIssueComment: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      number: number;
      body: string;
    },
    signal?: AbortSignal,
  ) => Promise<GitHubCreatedComment>;
  /**
   * Closes an issue. When `body` is given, a closing comment is posted first
   * (best-effort, failures do not block the close) and then the issue state
   * is patched to "closed".
   */
  closeIssue: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      number: number;
      body?: string;
    },
    signal?: AbortSignal,
  ) => Promise<void>;
  /**
   * Deletes an issue. GitHub requires the token to have write/admin access to
   * the repository; otherwise it responds 403, which surfaces as a
   * `authentication_failed` GitHubApiError so callers can degrade to close.
   */
  deleteIssue: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      number: number;
    },
    signal?: AbortSignal,
  ) => Promise<void>;
  /**
   * Adds labels to an issue. Idempotent: GitHub ignores labels that already
   * exist. Used by the worker to apply configured label rules after analysis.
   */
  addIssueLabels: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      number: number;
      labels: readonly string[];
    },
    signal?: AbortSignal,
  ) => Promise<void>;
  updateIssueComment: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      commentId: number;
      body: string;
    },
    signal?: AbortSignal,
  ) => Promise<GitHubCreatedComment>;
  /** Submits an immutable PR review tied to a commit (head) SHA. */
  createPullRequestReview: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      pullNumber: number;
      commitId: string;
      body: string;
      event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
      /** Optional inline review comments (diff position by new-file line). */
      comments?: readonly { path: string; line: number; body: string }[];
    },
    signal?: AbortSignal,
  ) => Promise<{ id: number }>;
  /** Lists the reviews already submitted on a pull request. */
  listPullRequestReviews: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      pullNumber: number;
    },
    signal?: AbortSignal,
  ) => Promise<{ id: number; state: string }[]>;
  /** Dismisses a submitted PR review (one-click revoke support). */
  dismissPullRequestReview: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      pullNumber: number;
      reviewId: number;
      message: string;
    },
    signal?: AbortSignal,
  ) => Promise<void>;
  /**
   * Creates a GitHub Check Run tied to a head SHA so the analysis state is
   * visible in the PR checks UI. Requires `checks: write` on the App.
   */
  createCheckRun: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      headSha: string;
      runName: string;
      status: "queued" | "in_progress" | "completed";
      conclusion?:
        | "success"
        | "failure"
        | "neutral"
        | "cancelled"
        | "timed_out"
        | "action_required";
      title?: string;
      summary?: string;
    },
    signal?: AbortSignal,
  ) => Promise<{ id: number; htmlUrl: string }>;
  /** Updates an existing check run (e.g. in_progress -> completed). */
  updateCheckRun: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      checkRunId: number;
      status: "queued" | "in_progress" | "completed";
      conclusion?:
        | "success"
        | "failure"
        | "neutral"
        | "cancelled"
        | "timed_out"
        | "action_required";
      title?: string;
      summary?: string;
    },
    signal?: AbortSignal,
  ) => Promise<{ id: number; htmlUrl: string }>;
  /** Fetches the live status of a check run (for WebUI polling). */
  getCheckRun: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      checkRunId: number;
    },
    signal?: AbortSignal,
  ) => Promise<{
    id: number;
    status: "queued" | "in_progress" | "completed";
    conclusion: string | null;
    title: string | null;
    htmlUrl: string | null;
  }>;
  /** Removes the given labels from an issue (idempotent). */
  removeIssueLabels: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      number: number;
      labels: readonly string[];
    },
    signal?: AbortSignal,
  ) => Promise<void>;
  /** Deletes an issue comment by id. */
  deleteIssueComment: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      commentId: number;
    },
    signal?: AbortSignal,
  ) => Promise<void>;
  /** Lists every repository installed to the app for a given installation. */
  listInstallationRepositories: (
    installationId: string,
    signal?: AbortSignal,
  ) => Promise<InstalledRepository[]>;
  /**
   * 列出 App 的所有安装（用 App JWT，非安装令牌）。同步用它对账：本地表的
   * 安装 ID 只能反映「已经同步过的」，新用户安装 App 后必须靠这里发现。
   */
  listInstallations: (signal?: AbortSignal) => Promise<{ id: string }[]>;
};

function signAppJwt(
  appId: string,
  privateKeyPem: string,
  nowMs: number,
): string {
  const nowSec = Math.floor(nowMs / 1_000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({ iat: nowSec - 60, exp: nowSec + 600, iss: appId }),
  ).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(privateKeyPem, "base64url");
  return `${header}.${claims}.${signature}`;
}

function retryAfterMs(headers: Headers): number | undefined {
  const header = headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function categorizeStatus(
  status: number,
  retryAfter: number | undefined,
): GitHubApiError {
  if (status === 429)
    return new GitHubApiError(
      "rate_limited",
      `GitHub responded with ${status}`,
      status,
      retryAfter,
    );
  if (status === 401 || status === 403)
    return new GitHubApiError(
      "authentication_failed",
      `GitHub responded with ${status}`,
      status,
    );
  if (status === 404)
    return new GitHubApiError("not_found", "GitHub object not found", status);
  if (status >= 500)
    return new GitHubApiError(
      "server_error",
      `GitHub responded with ${status}`,
      status,
    );
  return new GitHubApiError(
    "invalid_request",
    `GitHub responded with ${status}`,
    status,
  );
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(
    /\/$/,
    "",
  );
  const now = options.now ?? (() => Date.now());

  const request = async <T>(
    path: string,
    init: {
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
      token: string;
      body?: unknown | undefined;
      signal?: AbortSignal | undefined;
      /** Override the Accept header, e.g. for a diff (text/plain). */
      accept?: string | undefined;
      rawText?: boolean | undefined;
    },
  ): Promise<T> => {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: init.method,
        headers: {
          accept: init.accept ?? "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          authorization: `Bearer ${init.token}`,
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        ...(init.signal === undefined ? {} : { signal: init.signal }),
      });
    } catch (error) {
      if (init.signal?.aborted)
        throw new GitHubApiError("canceled", "request was canceled", null);
      throw new GitHubApiError(
        "network",
        error instanceof Error ? error.message : "GitHub request failed",
        null,
      );
    }

    if (!response.ok) {
      throw categorizeStatus(response.status, retryAfterMs(response.headers));
    }
    if (init.rawText) return (await response.text()) as T;
    if (response.status === 204) return null as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw new GitHubApiError(
        "invalid_request",
        "GitHub response was not JSON",
        response.status,
      );
    }
  };

  /**
   * The installation access_tokens endpoint intermittently returns 401 even
   * with a valid App JWT (observed repeatedly on the live test repo). Re-sign
   * a fresh JWT and retry once before giving up, so a transient rejection
   * never fails the whole operation.
   */
  const getInstallationToken = async (
    installationId: string,
    signal?: AbortSignal,
    attempt = 0,
  ): Promise<string> => {
    try {
      const response = await request<{ token: string }>(
        `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
        {
          method: "POST",
          token: signAppJwt(options.appId, options.privateKeyPem, now()),
          body: {},
          signal,
        },
      );
      return response.token;
    } catch (error) {
      if (
        attempt === 0 &&
        error instanceof GitHubApiError &&
        error.category === "authentication_failed"
      ) {
        return getInstallationToken(installationId, signal, 1);
      }
      throw error;
    }
  };

  /**
   * Mints an installation token and issues a request, retrying once on a 401:
   * GitHub intermittently rejects a freshly-minted installation token on the
   * API call itself (observed repeatedly). A fresh token + one retry covers it.
   */
  const authorized = async <T>(
    installationId: string,
    init: {
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
      path: string;
      body?: unknown;
      accept?: string;
      rawText?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<T> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await getInstallationToken(installationId, signal);
      try {
        return await request<T>(init.path, {
          method: init.method,
          token,
          body: init.body,
          accept: init.accept,
          rawText: init.rawText,
          signal,
        });
      } catch (error) {
        if (
          attempt === 0 &&
          error instanceof GitHubApiError &&
          error.category === "authentication_failed"
        )
          continue;
        throw error;
      }
    }
    throw new GitHubApiError(
      "authentication_failed",
      "authorized request failed after retry",
      401,
    );
  };

  return {
    getInstallationToken: async (installationId, signal) => ({
      token: await getInstallationToken(installationId, signal),
      expiresAt: new Date(now() + 60_000).toISOString(),
    }),

    getAppMetadata: async (signal) => {
      // 用 App JWT（而非 installation token）直调 /app：这是验证 appId 与私钥
      // 是否匹配的最轻量方式，不需要任何仓库或安装。
      const app = await request<{ id?: unknown; slug?: unknown; name?: unknown }>(
        "/app",
        {
          method: "GET",
          token: signAppJwt(options.appId, options.privateKeyPem, now()),
          ...(signal ? { signal } : {}),
        },
      );
      return {
        id: typeof app.id === "number" ? app.id : 0,
        slug: typeof app.slug === "string" ? app.slug : "",
        name: typeof app.name === "string" ? app.name : "",
      };
    },

    getWebhookConfig: async (signal) => {
      // /app/hook/config 返回的是扁平配置对象：{url, content_type, secret, ...}，
      // 没有 config 包裹，也没有 active 字段（active 在 /app/hook 里，但该端点对
      // App JWT 实测返回 401——scope 限制）。因此这里只读 url 与 content_type。
      const hook = await request<{
        url?: unknown;
        content_type?: unknown;
      }>("/app/hook/config", {
        method: "GET",
        token: signAppJwt(options.appId, options.privateKeyPem, now()),
        ...(signal ? { signal } : {}),
      });
      return {
        url: typeof hook.url === "string" ? hook.url : "",
        contentType:
          typeof hook.content_type === "string" ? hook.content_type : "",
      };
    },

    pingAppWebhook: async (signal) => {
      // 说明：GitHub 的 App 级 webhook 没有可程序化触发的 ping 端点
      // （POST /app/hook/ping 与 /pings 均 404，实测于 App 4486804；仓库级
      // /repos/*/hooks/{id}/pings 对 App token 返回 403）。自检流程因此不
      // 触发新投递，而是回查最近投递记录判断链路健康度。
      await Promise.resolve(signal);
    },

    listRecentWebhookDeliveries: async (signal) => {
      const deliveries = await request<
        {
          id?: unknown;
          event?: unknown;
          status_code?: unknown;
          delivered_at?: unknown;
        }[]
      >("/app/hook/deliveries?per_page=10", {
        method: "GET",
        token: signAppJwt(options.appId, options.privateKeyPem, now()),
        ...(signal ? { signal } : {}),
      });
      return deliveries.map((entry) => ({
        id: typeof entry.id === "string" || typeof entry.id === "number" ? String(entry.id) : "",
        event: typeof entry.event === "string" ? entry.event : "unknown",
        statusCode: typeof entry.status_code === "number" ? entry.status_code : null,
        deliveredAt:
          typeof entry.delivered_at === "string" ? entry.delivered_at : "",
      }));
    },

    getIssue: async ({ installationId, owner, name, number }, signal) => {
      const issue = await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "GET",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`,
        },
        signal,
      );
      return mapIssue(issue);
    },

    getRepository: async ({ installationId, owner, name }, signal) => {
      try {
        const repo = await authorized<Record<string, unknown>>(
          installationId,
          {
            method: "GET",
            path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
          },
          signal,
        );
        return {
          defaultBranch:
            typeof repo.default_branch === "string" ? repo.default_branch : "main",
        };
      } catch (error) {
        if (error instanceof GitHubApiError && error.status === 404) return null;
        throw error;
      }
    },

    listIssues: async (
      { installationId, owner, name, state = "all", perPage = 100, page = 1 },
      signal,
    ) => {
      const query = new URLSearchParams({
        state,
        per_page: String(perPage),
        page: String(page),
      }).toString();
      const items = await authorized<Record<string, unknown>[]>(
        installationId,
        {
          method: "GET",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues?${query}`,
        },
        signal,
      );
      // The issues endpoint also returns pull requests; skip them.
      return items.filter((item) => !item.pull_request).map(mapIssue);
    },

    listCollaborators: async (
      { installationId, owner, name, perPage = 100 },
      signal,
    ) => {
      const query = new URLSearchParams({
        per_page: String(perPage),
      }).toString();
      const items = await authorized<Record<string, unknown>[]>(
        installationId,
        {
          method: "GET",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/collaborators?${query}`,
        },
        signal,
      );
      return items
        .map((item) => (typeof item.login === "string" ? item.login : ""))
        .filter((login) => login.length > 0);
    },

    getPullRequest: async ({ installationId, owner, name, number }, signal) => {
      const pullRequest = await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "GET",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`,
        },
        signal,
      );
      return mapPullRequest(pullRequest);
    },

    listPullRequests: async (
      { installationId, owner, name, state = "open", perPage = 100, page = 1 },
      signal,
    ) => {
      const query = new URLSearchParams({
        state,
        per_page: String(perPage),
        page: String(page),
      }).toString();
      const items = await authorized<Record<string, unknown>[]>(
        installationId,
        {
          method: "GET",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?${query}`,
        },
        signal,
      );
      return items.map(mapPullRequest);
    },

    getPullRequestDiff: async (
      { installationId, owner, name, number },
      signal,
    ) =>
      authorized<string>(
        installationId,
        {
          method: "GET",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`,
          accept: "application/vnd.github.diff",
          rawText: true,
        },
        signal,
      ),

    getFileContents: async (
      { installationId, owner, name, path, ref },
      signal,
    ) => {
      const safePath = String(path || "").replace(/^\/+/, "");
      if (!safePath) return null;
      const encoded = safePath.split("/").map(encodeURIComponent).join("/");
      let data: Record<string, unknown>;
      try {
        data = await authorized<Record<string, unknown>>(
          installationId,
          {
            method: "GET",
            path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
          },
          signal,
        );
      } catch (error) {
        if (error instanceof GitHubApiError && error.status === 404) return null;
        throw error;
      }
      // A directory path returns an array instead of a file object.
      if (Array.isArray(data)) return null;
      if (typeof data.type === "string" && data.type !== "file") return null;
      const base64 = typeof data.content === "string" ? data.content : "";
      if (!base64) return null;
      const sha = typeof data.sha === "string" ? data.sha : undefined;
      return {
        content: Buffer.from(base64, "base64").toString("utf8"),
        truncated: data.truncated === true,
        ...(sha ? { sha } : {}),
      };
    },

    listDirectory: async ({ installationId, owner, name, path, ref }, signal) => {
      const safePath = String(path || "").replace(/^\/+/, "").replace(/\/+$/, "");
      const encoded = safePath.split("/").map(encodeURIComponent).join("/");
      let data: unknown;
      try {
        data = await authorized<unknown>(
          installationId,
          {
            method: "GET",
            path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
          },
          signal,
        );
      } catch (error) {
        if (error instanceof GitHubApiError && error.status === 404) return [];
        throw error;
      }
      if (!Array.isArray(data)) return [];
      return (data as Record<string, unknown>[]).map((entry) => ({
        name: typeof entry.name === "string" ? entry.name : "",
        path: typeof entry.path === "string" ? entry.path : "",
        type: typeof entry.type === "string" ? entry.type : "file",
      }));
    },

    writeFileContents: async (
      { installationId, owner, name, path, ref, content, sha },
      signal,
    ) => {
      const safePath = String(path || "").replace(/^\/+/, "");
      if (!safePath) return false;
      const encoded = safePath.split("/").map(encodeURIComponent).join("/");
      // GitHub contents API 只写文件，目录随文件的中间路径隐式创建（只支持单层：
      // 中间目录已存在才能创建更深文件，重复创建目录由先创建的规则文件保证）。
      try {
        await authorized<Record<string, unknown>>(
          installationId,
          {
            method: "PUT",
            path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encoded}`,
            // authorized -> request 会再做 JSON.stringify，这里传对象即可。
            body: {
              message: sha
                ? `chore: update AperturePrism review rule ${path}`
                : "chore: seed AperturePrism example review rules",
              content: Buffer.from(content, "utf8").toString("base64"),
              branch: ref,
              ...(sha ? { sha } : {}),
            },
          },
          signal,
        );
        return true;
      } catch (error) {
        // 文件已存在（422 或 conflict）或 sha 不匹配（409）视为「未成功」，不是致命错误。
        if (error instanceof GitHubApiError) return false;
        throw error;
      }
    },

    deleteFileContents: async (
      { installationId, owner, name, path, ref, sha },
      signal,
    ) => {
      const safePath = String(path || "").replace(/^\/+/, "");
      if (!safePath || !sha) return false;
      const encoded = safePath.split("/").map(encodeURIComponent).join("/");
      try {
        await authorized<Record<string, unknown>>(
          installationId,
          {
            method: "DELETE",
            path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encoded}`,
            body: { message: `chore: remove AperturePrism review rule ${path}`, branch: ref, sha },
          },
          signal,
        );
        return true;
      } catch (error) {
        // 文件不存在（404）或 sha 不匹配视为「未删除」，不是致命错误。
        if (error instanceof GitHubApiError) return false;
        throw error;
      }
    },

    listIssueComments: async (
      { installationId, owner, name, number },
      signal,
    ) => {
      const comments = await authorized<Record<string, unknown>[]>(
        installationId,
        {
          method: "GET",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/comments`,
        },
        signal,
      );
      return comments.map(mapComment);
    },

    createIssueComment: async (
      { installationId, owner, name, number, body },
      signal,
    ) => {
      const comment = await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "POST",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/comments`,
          body: { body },
        },
        signal,
      );
      return mapComment(comment);
    },

    createIssue: async (
      { installationId, owner, name, title, body, labels },
      signal,
    ) => {
      const issue = await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "POST",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues`,
          body: {
            title,
            body,
            ...(labels && labels.length > 0 ? { labels: [...labels] } : {}),
          },
        },
        signal,
      );
      return { number: numberValue(issue.number), htmlUrl: stringValue(issue.html_url) };
    },

    updateIssue: async (
      { installationId, owner, name, number, title, assignees },
      signal,
    ) => {
      const body: Record<string, unknown> = {};
      if (title !== undefined && title.trim().length > 0) body.title = title.trim();
      if (assignees !== undefined && assignees.length > 0)
        body.assignees = [...assignees];
      if (Object.keys(body).length === 0)
        return { number, htmlUrl: `https://github.com/${owner}/${name}/issues/${number}` };
      const issue = await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "PATCH",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`,
          body,
        },
        signal,
      );
      return { number: numberValue(issue.number), htmlUrl: stringValue(issue.html_url) };
    },

    closeIssue: async (
      { installationId, owner, name, number, body },
      signal,
    ) => {
      if (body && body.trim().length > 0) {
        try {
          await authorized<Record<string, unknown>>(
            installationId,
            {
              method: "POST",
              path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/comments`,
              body: { body },
            },
            signal,
          );
        } catch (error) {
          // The closing comment is best-effort; never block the close on it.
          void error;
        }
      }
      await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "PATCH",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`,
          body: { state: "closed" },
        },
        signal,
      );
    },

    deleteIssue: async ({ installationId, owner, name, number }, signal) => {
      await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "DELETE",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`,
        },
        signal,
      );
    },

    addIssueLabels: async (
      { installationId, owner, name, number, labels },
      signal,
    ) => {
      const unique = [...new Set(labels)].filter((label) => label.trim().length > 0);
      if (unique.length === 0) return;
      await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "POST",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/labels`,
          body: { labels: unique },
        },
        signal,
      );
    },

    updateIssueComment: async (
      { installationId, owner, name, commentId, body },
      signal,
    ) => {
      const comment = await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "PATCH",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/comments/${commentId}`,
          body: { body },
        },
        signal,
      );
      return mapComment(comment);
    },

    createPullRequestReview: async (
      { installationId, owner, name, pullNumber, commitId, body, event, comments },
      signal,
    ) => {
      const review = await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "POST",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${pullNumber}/reviews`,
          body: {
            commit_id: commitId,
            body,
            event,
            ...(comments && comments.length > 0 ? { comments: [...comments] } : {}),
          },
        },
        signal,
      );
      return { id: numberValue(review.id) };
    },

    listPullRequestReviews: async (
      { installationId, owner, name, pullNumber },
      signal,
    ) => {
      const data = await authorized<Record<string, unknown>[]>(
        installationId,
        {
          method: "GET",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${pullNumber}/reviews`,
        },
        signal,
      );
      return data.map((review) => ({
        id: numberValue(review.id),
        state: stringValue(review.state),
      }));
    },

    dismissPullRequestReview: async (
      { installationId, owner, name, pullNumber, reviewId, message },
      signal,
    ) => {
      await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "PUT",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${pullNumber}/reviews/${reviewId}/dismissals`,
          body: { message },
        },
        signal,
      );
    },

    createCheckRun: async (
      { installationId, owner, name, headSha, runName, status, conclusion, title, summary },
      signal,
    ) => {
      const output = title || summary ? { title: title ?? runName, summary: summary ?? "" } : undefined;
      const run = await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "POST",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/check-runs`,
          body: {
            head_sha: headSha,
            name: runName,
            status,
            ...(conclusion === undefined ? {} : { conclusion }),
            ...(output === undefined ? {} : { output }),
          },
        },
        signal,
      );
      return {
        id: numberValue(run.id),
        htmlUrl: stringValue(run.html_url),
      };
    },

    updateCheckRun: async (
      { installationId, owner, name, checkRunId, status, conclusion, title, summary },
      signal,
    ) => {
      const output = title || summary ? { title: title ?? `Check ${checkRunId}`, summary: summary ?? "" } : undefined;
      const run = await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "PATCH",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/check-runs/${checkRunId}`,
          body: {
            status,
            ...(conclusion === undefined ? {} : { conclusion }),
            ...(output === undefined ? {} : { output }),
          },
        },
        signal,
      );
      return {
        id: numberValue(run.id),
        htmlUrl: stringValue(run.html_url),
      };
    },

    getCheckRun: async (
      { installationId, owner, name, checkRunId },
      signal,
    ) => {
      const run = await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "GET",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/check-runs/${checkRunId}`,
        },
        signal,
      );
      const output = (run.output ?? {}) as { title?: unknown };
      return {
        id: numberValue(run.id),
        status: (["queued", "in_progress", "completed"].includes(String(run.status))
          ? String(run.status)
          : "queued") as "queued" | "in_progress" | "completed",
        conclusion:
          typeof run.conclusion === "string" && run.conclusion.length > 0
            ? run.conclusion
            : null,
        title: typeof output.title === "string" ? output.title : null,
        htmlUrl: typeof run.html_url === "string" ? run.html_url : null,
      };
    },

    removeIssueLabels: async (
      { installationId, owner, name, number, labels },
      signal,
    ) => {
      for (const label of labels) {
        if (!label || label.trim().length === 0) continue;
        try {
          await authorized<Record<string, unknown>>(
            installationId,
            {
              method: "DELETE",
              path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/labels/${encodeURIComponent(label.trim())}`,
            },
            signal,
          );
        } catch {
          // Removing a label that is not present returns 404; treat as done.
        }
      }
    },

    deleteIssueComment: async (
      { installationId, owner, name, commentId },
      signal,
    ) => {
      await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "DELETE",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/comments/${commentId}`,
        },
        signal,
      );
    },

    listInstallationRepositories: async (installationId, signal) => {
      const repositories: InstalledRepository[] = [];
      const perPage = 100;
      for (let page = 1; ; page += 1) {
        const data = await authorized<Record<string, unknown>>(
          installationId,
          {
            method: "GET",
            path: `/installation/repositories?per_page=${perPage}&page=${page}`,
          },
          signal,
        );
        const list = Array.isArray(data.repositories)
          ? (data.repositories as Record<string, unknown>[])
          : [];
        for (const repo of list) {
          const owner = objectOr(repo.owner);
          repositories.push({
            id: numberValue(repo.id),
            owner: stringValue(owner.login),
            name: stringValue(repo.name),
            fullName: stringValue(repo.full_name),
          });
        }
        if (list.length < perPage) return repositories;
      }
    },

    listInstallations: async (signal) => {
      // App 级端点：用 App JWT（每次现签），不需要安装令牌。
      const data = await request<Record<string, unknown>[]>(
        "/app/installations?per_page=100",
        {
          method: "GET",
          token: signAppJwt(options.appId, options.privateKeyPem, now()),
          signal,
        },
      );
      const list = Array.isArray(data) ? data : [];
      return list.map((installation) => ({
        id: String(numberValue(installation.id)),
      }));
    },
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function mapPullRequest(value: Record<string, unknown>): GitHubPullRequest {
  const head = objectOr(value.head);
  return {
    number: numberValue(value.number),
    title: stringValue(value.title),
    body: stringValue(value.body),
    state: value.state === "closed" ? "closed" : "open",
    headSha: stringValue(head.sha),
    headRef: stringValue(head.ref),
    changedFiles: numberValue(value.changed_files),
    additions: numberValue(value.additions),
    deletions: numberValue(value.deletions),
  };
}

function objectOr(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function mapIssue(value: Record<string, unknown>): GitHubIssue {
  const labels = Array.isArray(value.labels)
    ? value.labels
        .map((label) =>
          typeof label === "object" && label !== null
            ? stringValue((label as Record<string, unknown>).name)
            : stringValue(label),
        )
        .filter((label) => label.length > 0)
    : [];
  return {
    number: numberValue(value.number),
    title: stringValue(value.title),
    body: stringValue(value.body),
    state: value.state === "closed" ? "closed" : "open",
    htmlUrl: stringValue(value.html_url),
    author: stringOrNull(
      typeof value.user === "object" && value.user !== null
        ? (value.user as Record<string, unknown>).login
        : null,
    ),
    createdAt: stringValue(value.created_at),
    updatedAt: stringValue(value.updated_at),
    labels,
  };
}

function mapComment(value: Record<string, unknown>): GitHubIssueComment {
  return {
    id: numberValue(value.id),
    body: stringValue(value.body),
    htmlUrl: stringValue(value.html_url),
    author: stringOrNull(
      typeof value.user === "object" && value.user !== null
        ? (value.user as Record<string, unknown>).login
        : null,
    ),
    createdAt: stringValue(value.created_at),
    updatedAt: stringValue(value.updated_at),
  };
}
