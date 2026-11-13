import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGitHubClient, GitHubApiError } from "./client.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

type Call = { url: string; init: RequestInit };

function clientWith(responder: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const client = createGitHubClient({
    appId: "12345",
    privateKeyPem: privateKey,
    apiBaseUrl: "https://api.github.test",
    now: () => 1_700_000_000_000,
    fetchImpl: (async (url, init) => {
      const call = { url: String(url), init: init ?? {} };
      calls.push(call);
      return responder(call);
    }) as typeof fetch,
  });
  return { client, calls };
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** Routes the mandatory installation-token exchange then hands off. */
function withToken(next: (call: Call) => Response) {
  return (call: Call): Response => {
    if (call.url.endsWith("/app/installations/42/access_tokens"))
      return jsonResponse({
        token: "installation-token",
        expires_at: "2026-08-18T00:00:00Z",
      });
    return next(call);
  };
}

describe("GitHub API client", () => {
  it("exchanges an app JWT for an installation token", async () => {
    const { client, calls } = clientWith(() =>
      jsonResponse({ token: "installation-token" }),
    );

    const token = await client.getInstallationToken("42");

    expect(token.token).toBe("installation-token");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://api.github.test/app/installations/42/access_tokens",
    );
    expect(calls[0]?.init.method).toBe("POST");
    const authorization = String(
      (calls[0]?.init.headers as Record<string, string>).authorization,
    );
    expect(authorization).toMatch(
      /^Bearer [a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+$/i,
    );
  });

  it("fetches and maps an issue using the installation token", async () => {
    const { client, calls } = clientWith(
      withToken(() =>
        jsonResponse({
          number: 7,
          title: "App crashes",
          body: "It crashes.",
          state: "open",
          html_url: "https://github.test/o/r/issues/7",
          user: { login: "alice" },
          created_at: "2026-08-17T00:00:00Z",
          updated_at: "2026-08-17T01:00:00Z",
          labels: [{ name: "bug" }, { name: "priority:high" }],
        }),
      ),
    );

    const issue = await client.getIssue({
      installationId: "42",
      owner: "o",
      name: "r",
      number: 7,
    });

    expect(issue).toEqual({
      number: 7,
      title: "App crashes",
      body: "It crashes.",
      state: "open",
      htmlUrl: "https://github.test/o/r/issues/7",
      author: "alice",
      createdAt: "2026-08-17T00:00:00Z",
      updatedAt: "2026-08-17T01:00:00Z",
      labels: ["bug", "priority:high"],
    });
    expect(calls[1]?.url).toBe("https://api.github.test/repos/o/r/issues/7");
    expect(calls[1]?.init.method).toBe("GET");
    expect(
      (calls[1]?.init.headers as Record<string, string>).authorization,
    ).toBe("Bearer installation-token");
  });

  it("lists issue comments", async () => {
    const { client, calls } = clientWith(
      withToken(() =>
        jsonResponse([{ id: 11, body: "me too", user: { login: "bob" } }]),
      ),
    );

    const comments = await client.listIssueComments({
      installationId: "42",
      owner: "o",
      name: "r",
      number: 7,
    });

    expect(comments).toEqual([
      expect.objectContaining({ id: 11, body: "me too", author: "bob" }),
    ]);
    expect(calls[1]?.url).toBe(
      "https://api.github.test/repos/o/r/issues/7/comments",
    );
  });

  it("creates and updates comments with the right method and body", async () => {
    let created = false;
    const { client, calls } = clientWith(
      withToken((call) => {
        if (call.url.endsWith("/issues/7/comments")) {
          created = true;
          return jsonResponse({ id: 21, html_url: "https://github.test/c/21" });
        }
        return jsonResponse({ id: 21, html_url: "https://github.test/c/21" });
      }),
    );

    const createdComment = await client.createIssueComment({
      installationId: "42",
      owner: "o",
      name: "r",
      number: 7,
      body: "placeholder",
    });
    expect(createdComment).toEqual(
      expect.objectContaining({ id: 21, htmlUrl: "https://github.test/c/21" }),
    );
    expect(created).toBe(true);

    const updatedComment = await client.updateIssueComment({
      installationId: "42",
      owner: "o",
      name: "r",
      commentId: 21,
      body: "final",
    });
    expect(updatedComment.id).toBe(21);
    const updateCall = calls.at(-1);
    expect(updateCall?.url).toBe(
      "https://api.github.test/repos/o/r/issues/comments/21",
    );
    expect(updateCall?.init.method).toBe("PATCH");
    expect(JSON.parse(String(updateCall?.init.body))).toEqual({
      body: "final",
    });
  });

  it("maps HTTP statuses to stable error categories", async () => {
    const cases: [number, string, number | null][] = [
      [429, "rate_limited", 429],
      [401, "authentication_failed", 401],
      [403, "authentication_failed", 403],
      [404, "not_found", 404],
      [500, "server_error", 500],
      [422, "invalid_request", 422],
    ];
    for (const [status, category, reportedStatus] of cases) {
      const { client } = clientWith(
        withToken(() => new Response("failure", { status })),
      );
      try {
        await client.getIssue({
          installationId: "42",
          owner: "o",
          name: "r",
          number: 7,
        });
        throw new Error("expected the request to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(GitHubApiError);
        expect((error as GitHubApiError).category).toBe(category);
        expect((error as GitHubApiError).status).toBe(reportedStatus);
      }
    }
  });

  it("honors Retry-After on rate limits", async () => {
    const { client } = clientWith(
      withToken(
        () =>
          new Response("slow", {
            status: 429,
            headers: { "retry-after": "5" },
          }),
      ),
    );
    try {
      await client.getIssue({
        installationId: "42",
        owner: "o",
        name: "r",
        number: 7,
      });
      throw new Error("expected the request to fail");
    } catch (error) {
      expect((error as GitHubApiError).retryAfterMs).toBe(5_000);
    }
  });

  it("reports network failures and caller cancellation distinctly", async () => {
    const broken = clientWith(() => {
      throw new Error("ECONNRESET");
    });
    try {
      await broken.client.getInstallationToken("42");
      throw new Error("expected the request to fail");
    } catch (error) {
      expect((error as GitHubApiError).category).toBe("network");
    }

    const controller = new AbortController();
    const canceled = clientWith(() => {
      controller.abort();
      throw new Error("aborted");
    });
    try {
      await canceled.client.getInstallationToken("42", controller.signal);
      throw new Error("expected the request to fail");
    } catch (error) {
      expect((error as GitHubApiError).category).toBe("canceled");
    }
  });

  it("fetches and maps a pull request", async () => {
    const { client, calls } = clientWith(
      withToken(() =>
        jsonResponse({
          number: 9,
          title: "modernize imports",
          body: "migrate",
          state: "open",
          head: { sha: "abc123", ref: "feature/x" },
          changed_files: 3,
          additions: 12,
          deletions: 4,
        }),
      ),
    );
    const pullRequest = await client.getPullRequest({
      installationId: "42",
      owner: "o",
      name: "r",
      number: 9,
    });
    expect(pullRequest).toEqual({
      number: 9,
      title: "modernize imports",
      body: "migrate",
      state: "open",
      headSha: "abc123",
      headRef: "feature/x",
      changedFiles: 3,
      additions: 12,
      deletions: 4,
    });
    expect(calls[1]?.url).toBe(
      "https://api.github.test/repos/o/r/pulls/9",
    );
  });

  it("fetches the pull request diff as text with a diff accept header", async () => {
    const { client, calls } = clientWith(
      withToken(() => new Response("diff --git a/x b/x\n", { status: 200 })),
    );
    const diff = await client.getPullRequestDiff({
      installationId: "42",
      owner: "o",
      name: "r",
      number: 9,
    });
    expect(diff.startsWith("diff --git")).toBe(true);
    const headers = calls[1]?.init.headers as Record<string, string>;
    expect(headers.accept).toBe("application/vnd.github.diff");
  });

  it("submits a pull request review with head commit and event", async () => {
    const { client, calls } = clientWith(
      withToken(() => jsonResponse({ id: 77 })),
    );
    const review = await client.createPullRequestReview({
      installationId: "42",
      owner: "o",
      name: "r",
      pullNumber: 9,
      commitId: "abc123",
      body: "looks good",
      event: "APPROVE",
    });
    expect(review.id).toBe(77);
    const call = calls.at(-1);
    expect(call?.url).toBe(
      "https://api.github.test/repos/o/r/pulls/9/reviews",
    );
    expect(call?.init.method).toBe("POST");
    expect(JSON.parse(String(call?.init.body))).toEqual({
      commit_id: "abc123",
      body: "looks good",
      event: "APPROVE",
    });
  });

  it("lists collaborator logins and drops malformed entries", async () => {
    const { client, calls } = clientWith(
      withToken(() =>
        jsonResponse([
          { login: "owner-user" },
          { login: "collab-user" },
          { id: 3 },
          { login: "" },
        ]),
      ),
    );

    const logins = await client.listCollaborators({
      installationId: "42",
      owner: "o",
      name: "r",
    });

    expect(logins).toEqual(["owner-user", "collab-user"]);
    expect(calls.at(-1)?.url).toBe(
      "https://api.github.test/repos/o/r/collaborators?per_page=100",
    );
  });

  it("writeFileContents PUTs a new file with base64 content and returns true", async () => {
    const { client, calls } = clientWith(
      withToken(() => jsonResponse({ content: { name: "README.md" } })),
    );
    const ok = await client.writeFileContents({
      installationId: "42",
      owner: "o",
      name: "r",
      path: ".apertureprism/rules/README.md",
      ref: "main",
      content: "# rules",
    });
    expect(ok).toBe(true);
    const last = calls.at(-1)!;
    expect(last.url).toBe(
      "https://api.github.test/repos/o/r/contents/.apertureprism/rules/README.md",
    );
    expect(last.init.method).toBe("PUT");
    const body = JSON.parse(String(last.init.body));
    expect(body.branch).toBe("main");
    expect(body.sha).toBeUndefined();
    expect(Buffer.from(body.content, "base64").toString("utf8")).toBe("# rules");
  });

  it("writeFileContents with sha sends an update body (update mode)", async () => {
    const { client, calls } = clientWith(
      withToken(() => jsonResponse({ content: { name: "a.md" } })),
    );
    const ok = await client.writeFileContents({
      installationId: "42",
      owner: "o",
      name: "r",
      path: ".apertureprism/rules/a.md",
      ref: "main",
      content: "v2",
      sha: "abc123",
    });
    expect(ok).toBe(true);
    const body = JSON.parse(String(calls.at(-1)!.init.body));
    expect(body.sha).toBe("abc123");
  });

  it("deleteFileContents DELETEs with the blob sha", async () => {
    const { client, calls } = clientWith(
      withToken(() => jsonResponse({ content: null })),
    );
    const ok = await client.deleteFileContents({
      installationId: "42",
      owner: "o",
      name: "r",
      path: ".apertureprism/rules/a.md",
      ref: "main",
      sha: "abc123",
    });
    expect(ok).toBe(true);
    const last = calls.at(-1)!;
    expect(last.init.method).toBe("DELETE");
    expect(last.url).toBe(
      "https://api.github.test/repos/o/r/contents/.apertureprism/rules/a.md",
    );
    const body = JSON.parse(String(last.init.body));
    expect(body.sha).toBe("abc123");
    expect(body.branch).toBe("main");
  });

  it("writeFileContents reports false when the file already exists", async () => {
    const { client } = clientWith(
      withToken(() => jsonResponse({ message: "already exists" }, { status: 422 })),
    );
    const ok = await client.writeFileContents({
      installationId: "42",
      owner: "o",
      name: "r",
      path: ".apertureprism/rules/README.md",
      ref: "main",
      content: "# rules",
    });
    expect(ok).toBe(false);
  });
});


describe("installation repository pagination", () => {
  const repository = (id: number) => ({ id, owner: { login: "o" }, name: `r${id}`, full_name: `o/r${id}` });
  const fullPage = Array.from({ length: 100 }, (_, index) => repository(index + 1));

  it("returns repositories beyond the first page and forwards cancellation", async () => {
    const { client, calls } = clientWith(withToken((call) => {
      const page = new URL(call.url).searchParams.get("page");
      return jsonResponse({ total_count: 101, repositories: page === "2" ? [repository(101)] : fullPage });
    }));
    const controller = new AbortController();
    const repos = await client.listInstallationRepositories("42", controller.signal);
    expect(repos).toHaveLength(101);
    expect(repos.at(-1)).toEqual({ id: 101, owner: "o", name: "r101", fullName: "o/r101" });
    const requests = calls.filter((call) => call.url.includes("/installation/repositories"));
    expect(requests.map((call) => new URL(call.url).search)).toEqual(["?per_page=100&page=1", "?per_page=100&page=2"]);
    expect(requests.every((call) => call.init.signal === controller.signal)).toBe(true);
  });

  it("stops after an empty first page", async () => {
    const { client, calls } = clientWith(withToken(() => jsonResponse({ repositories: [] })));
    expect(await client.listInstallationRepositories("42")).toEqual([]);
    expect(calls.filter((call) => call.url.includes("/installation/repositories"))).toHaveLength(1);
  });

  it("does not report partial synchronization as success when a later page fails", async () => {
    const { client } = clientWith(withToken((call) => {
      if (new URL(call.url).searchParams.get("page") === "2") return jsonResponse({ message: "unavailable" }, { status: 503 });
      return jsonResponse({ repositories: fullPage });
    }));
    await expect(client.listInstallationRepositories("42")).rejects.toMatchObject({ category: "server_error", status: 503 });
  });
});
