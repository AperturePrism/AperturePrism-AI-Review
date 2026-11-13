import { describe, expect, it, vi } from "vitest";
import type { GitHubClient } from "../../../packages/github-adapter/src/index.js";
import { buildPrContext } from "./context-build.js";

const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
-import { x } from "./legacy";
+import { x } from "./modern";
+export const y = 1;
`;

function makeGithub(): GitHubClient {
  const github: GitHubClient = {
    getInstallationToken: async () => ({
      token: "t",
      expiresAt: new Date().toISOString(),
    }),
    getFileContents: async () => null,
    listDirectory: async () => [],
    writeFileContents: async () => true,
    deleteFileContents: async () => true,
    getRepository: async () => ({ defaultBranch: "main" }),
    getIssue: async () => {
      throw new Error("unused");
    },
    listIssues: async () => [],
    listCollaborators: async () => [],
    getAppMetadata: async () => ({ id: 1, slug: "app", name: "App" }),
    getWebhookConfig: async () => ({
      url: "",
      contentType: "json",
    }),
    pingAppWebhook: async () => undefined,
    listRecentWebhookDeliveries: async () => [],
    listIssueComments: async () => [],
    createIssueComment: async () => ({ id: 1, htmlUrl: "" }),
    closeIssue: async () => undefined,
    deleteIssue: async () => undefined,
    addIssueLabels: async () => undefined,
    updateIssueComment: async () => ({ id: 1, htmlUrl: "" }),
    createPullRequestReview: async () => ({ id: 1 }),
    listPullRequestReviews: async () => [],
    dismissPullRequestReview: async () => undefined,
    createCheckRun: async () => ({ id: 1, htmlUrl: "" }),
    updateCheckRun: async () => ({ id: 1, htmlUrl: "" }),
    getCheckRun: async () => ({
      id: 1,
      status: "completed" as const,
      conclusion: "success",
      title: "AI Review",
      htmlUrl: "https://github.com/o/r/actions/runs/1",
    }),
    removeIssueLabels: async () => undefined,
    deleteIssueComment: async () => undefined,
    listInstallationRepositories: async () => [],
    listInstallations: async () => [],
    getPullRequest: async () => ({
      number: 9,
      title: "modernize imports",
      body: "migrate to the newer helper",
      state: "open",
      headSha: "abc123",
      headRef: "feature/x",
      changedFiles: 1,
      additions: 2,
      deletions: 1,
    }),
    listPullRequests: async () => [],
    createIssue: async () => ({ number: 1, htmlUrl: "" }),
    updateIssue: async () => ({ number: 1, htmlUrl: "" }),
    getPullRequestDiff: async () => diff,
  };
  return github;
}

describe("buildPrContext", () => {
  it("fetches PR metadata and parses the diff into a reviewable context", async () => {
    const github = makeGithub();
    const context = await buildPrContext(github, {
      installationId: "i",
      owner: "o",
      name: "r",
      pullNumber: 9,
    });
    expect(context.pullRequest.headSha).toBe("abc123");
    expect(context.rendered.diff.files).toHaveLength(1);
    expect(context.rendered.diff.additions).toBe(2);
    expect(context.rendered.diff.deletions).toBe(1);
  });
});

it("preloads changed files at the normalized pull request head SHA", async () => {
  const github = makeGithub();
  const getFileContents = vi.fn<GitHubClient["getFileContents"]>().mockResolvedValue({
    content: "export const y = 1;",
    sha: "blob-sha",
  });
  github.getFileContents = getFileContents;
  await buildPrContext(github, {
    installationId: "i",
    owner: "o",
    name: "r",
    pullNumber: 9,
  });
  expect(getFileContents).toHaveBeenCalledWith(
    expect.objectContaining({ path: "src/a.ts", ref: "abc123" }),
    undefined,
  );
});
