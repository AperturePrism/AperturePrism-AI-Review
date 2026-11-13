import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGitHubClient, GitHubApiError } from "./client.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const head = "a".repeat(40);
const identity = {
  installationId: "42",
  owner: "owner",
  name: "repo",
  pullNumber: 7,
};
const commit = {
  installationId: "42",
  owner: "owner",
  name: "repo",
  ref: head,
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
function setup(
  handle: (url: URL, init: RequestInit) => Response | Promise<Response>,
) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const client = createGitHubClient({
    appId: "123",
    privateKeyPem: privateKey,
    apiBaseUrl: "https://api.github.test",
    fetchImpl: (async (input, init = {}) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      if (url.pathname === "/app/installations/42/access_tokens")
        return json({ token: "test-installation-token" });
      return handle(url, init);
    }) as typeof fetch,
  });
  return { client, calls };
}
const run = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: `check-${id}`,
  head_sha: head,
  status: "completed",
  conclusion: "success",
  ...extra,
});
const status = (id: number, context = `status-${id}`, state = "success") => ({
  id,
  context,
  state,
});
const review = (id: number, state = "APPROVED") => ({
  id,
  state,
  user: { login: "reviewer", type: "User" },
  submitted_at: "2026-11-13T00:00:00Z",
  commit_id: head,
});

describe("GitHub automatic merge transport", () => {
  it("reads merge eligibility without treating an unknown mergeability calculation as clean", async () => {
    const { client, calls } = setup(() =>
      json({
        number: 7,
        state: "open",
        head: { sha: head },
        base: { ref: "main" },
        draft: false,
        merged: false,
        merge_commit_sha: null,
        mergeable: null,
        mergeable_state: "unknown",
      }),
    );
    expect(await client.getPullRequestMergeState(identity)).toEqual({
      number: 7,
      state: "open",
      headSha: head,
      baseRef: "main",
      draft: false,
      merged: false,
      mergeCommitSha: null,
      mergeable: null,
      mergeableState: "unknown",
    });
    expect(calls[1]?.url.pathname).toBe("/repos/owner/repo/pulls/7");
    expect(calls[1]?.init.headers).toMatchObject({
      authorization: "Bearer test-installation-token",
    });
  });

  it("rejects missing PR eligibility fields instead of assuming safe defaults", async () => {
    const { client } = setup(() =>
      json({
        number: 7,
        state: "open",
        head: { sha: head },
        base: { ref: "main" },
      }),
    );
    await expect(
      client.getPullRequestMergeState(identity),
    ).rejects.toMatchObject({ category: "invalid_request" });
  });

  it("reads later check and status pages and keeps a newer failure over older success", async () => {
    const { client, calls } = setup((url) => {
      const page = Number(url.searchParams.get("page"));
      if (url.pathname.endsWith("/check-runs")) {
        expect(url.searchParams.get("filter")).toBe("latest");
        return json({
          total_count: 101,
          check_runs:
            page === 1
              ? Array.from({ length: 100 }, (_, i) => run(i + 1))
              : [run(101, { name: "late-failure", conclusion: "failure" })],
        });
      }
      return json(
        page === 1
          ? [
              status(201, "deploy", "failure"),
              ...Array.from({ length: 99 }, (_, i) => status(i + 202)),
            ]
          : [
              status(301, "deploy", "success"),
              status(302, "late-status", "pending"),
            ],
      );
    });
    const result = await client.getCommitChecks(commit);
    expect(result.checks).toHaveLength(202);
    expect(result.checks).toContainEqual({
      name: "late-failure",
      status: "completed",
      conclusion: "failure",
      source: "check_run",
    });
    expect(result.checks.filter((check) => check.name === "deploy")).toEqual([
      {
        name: "deploy",
        status: "completed",
        conclusion: "failure",
        source: "status",
      },
    ]);
    expect(result.checks).toContainEqual({
      name: "late-status",
      status: "queued",
      conclusion: null,
      source: "status",
    });
    expect(
      calls.filter((call) => call.url.searchParams.get("page") === "2"),
    ).toHaveLength(2);
  });

  it("retains same-named checks from separate runs and maps GitHub waiting states to pending", async () => {
    const { client } = setup((url) =>
      url.pathname.endsWith("/check-runs")
        ? json({
            total_count: 3,
            check_runs: [
              run(1, { name: "ci" }),
              run(2, { name: "ci", conclusion: "failure" }),
              run(3, { status: "waiting", conclusion: null }),
            ],
          })
        : json([]),
    );
    const result = await client.getCommitChecks(commit);
    expect(result.checks.filter((check) => check.name === "ci")).toHaveLength(
      2,
    );
    expect(result.checks[2]).toMatchObject({
      status: "queued",
      conclusion: null,
    });
  });

  it.each([
    { total_count: 2, check_runs: [run(1)] },
    { total_count: 1, check_runs: [run(1, { status: "unrecognized" })] },
    { total_count: 1, check_runs: [run(1, { conclusion: "unrecognized" })] },
    { total_count: 1, check_runs: [run(1, { head_sha: "b".repeat(40) })] },
    { total_count: 2, check_runs: [run(1), run(1)] },
    { total_count: 0 },
  ])(
    "rejects incomplete or inconsistent check snapshots: %j",
    async (value) => {
      const { client } = setup(() => json(value));
      await expect(client.getCommitChecks(commit)).rejects.toMatchObject({
        category: "invalid_request",
      });
    },
  );

  it("does not return successful checks when legacy status access fails", async () => {
    const { client } = setup((url) =>
      url.pathname.endsWith("/check-runs")
        ? json({ total_count: 1, check_runs: [run(1)] })
        : json({ message: "forbidden" }, 403),
    );
    await expect(client.getCommitChecks(commit)).rejects.toMatchObject({
      category: "authentication_failed",
      status: 403,
    });
  });

  it("reads every review page, including a late request for changes", async () => {
    const { client } = setup((url) =>
      json(
        url.searchParams.get("page") === "1"
          ? Array.from({ length: 100 }, (_, i) => review(i + 1))
          : [review(101, "CHANGES_REQUESTED")],
      ),
    );
    const result = await client.listPullRequestReviewStates(identity);
    expect(result).toHaveLength(101);
    expect(result[100]).toEqual({
      user: "reviewer",
      state: "CHANGES_REQUESTED",
      submittedAt: "2026-11-13T00:00:00Z",
      commitId: head,
      userType: "User",
    });
  });

  it.each([
    { ...review(1), user: null },
    { ...review(1), state: "UNKNOWN" },
    { ...review(1), submitted_at: "invalid" },
  ])(
    "rejects reviews whose safety state cannot be determined: %j",
    async (value) => {
      const { client } = setup(() => json([value]));
      await expect(
        client.listPullRequestReviewStates(identity),
      ).rejects.toBeInstanceOf(GitHubApiError);
    },
  );

  it("encodes repository and ref path segments instead of allowing ref slashes to change the route", async () => {
    const { client, calls } = setup((url) =>
      url.pathname.endsWith("/check-runs")
        ? json({ total_count: 0, check_runs: [] })
        : json([]),
    );
    await client.getCommitChecks({
      ...commit,
      owner: "owner/name",
      ref: "refs/heads/feature",
    });
    expect(calls[1]?.url.pathname).toBe(
      "/repos/owner%2Fname/repo/commits/refs%2Fheads%2Ffeature/check-runs",
    );
  });

  it("sends a version-bound PUT with the requested merge method and abort signal", async () => {
    const signal = new AbortController().signal;
    const { client, calls } = setup(() =>
      json({
        merged: true,
        sha: "c".repeat(40),
        message: "Pull Request successfully merged",
      }),
    );
    expect(
      await client.mergePullRequest(
        { ...identity, expectedHeadSha: head, method: "squash" },
        signal,
      ),
    ).toEqual({
      merged: true,
      sha: "c".repeat(40),
      message: "Pull Request successfully merged",
    });
    expect(calls[1]?.url.pathname).toBe("/repos/owner/repo/pulls/7/merge");
    expect(calls[1]?.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      sha: head,
      merge_method: "squash",
    });
    expect(calls.every((call) => call.init.signal === signal)).toBe(true);
  });

  it("preserves a head mismatch response as an error and never retries the merge write", async () => {
    const { client, calls } = setup(() =>
      json({ message: "Head branch was modified" }, 409),
    );
    await expect(
      client.mergePullRequest({
        ...identity,
        expectedHeadSha: head,
        method: "merge",
      }),
    ).rejects.toMatchObject({ category: "invalid_request", status: 409 });
    expect(calls.filter((call) => call.init.method === "PUT")).toHaveLength(1);
  });

  it("rejects a merge without a concrete reviewed SHA before touching GitHub", async () => {
    const { client, calls } = setup(() =>
      json({ merged: true, sha: "unsafe" }),
    );
    await expect(
      client.mergePullRequest({
        ...identity,
        expectedHeadSha: "",
        method: "squash",
      }),
    ).rejects.toMatchObject({ category: "invalid_request" });
    expect(calls).toHaveLength(0);
  });

  it("keeps a refused merge refused and rejects malformed success responses", async () => {
    let value: unknown = { merged: false, sha: null, message: "Merge blocked" };
    const { client } = setup(() => json(value));
    const input = {
      ...identity,
      expectedHeadSha: head,
      method: "rebase" as const,
    };
    expect(await client.mergePullRequest(input)).toEqual(value);
    value = { merged: true, sha: null, message: "ok" };
    await expect(client.mergePullRequest(input)).rejects.toMatchObject({
      category: "invalid_request",
    });
  });
});
