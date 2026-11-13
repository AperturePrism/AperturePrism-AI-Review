import { describe, expect, it } from "vitest";
import type {
  GitHubClient,
  GitHubIssue,
  GitHubIssueComment,
} from "../../../packages/github-adapter/src/index.js";
import {
  buildIssueContext,
  estimateTokens,
  type IssueContextBudget,
} from "./context.js";

const smallIssue: GitHubIssue = {
  number: 7,
  title: "Short title",
  body: "Short body",
  state: "open",
  htmlUrl: "https://github.test/o/r/issues/7",
  author: "alice",
  createdAt: "2026-08-17T00:00:00Z",
  updatedAt: "2026-08-17T01:00:00Z",
  labels: ["bug"],
};

function comment(id: number, body: string): GitHubIssueComment {
  return {
    id,
    body,
    htmlUrl: `https://github.test/c/${id}`,
    author: "bob",
    createdAt: "2026-08-17T02:00:00Z",
    updatedAt: "2026-08-17T02:00:00Z",
  };
}

function fakeGithub(
  issue: GitHubIssue,
  comments: GitHubIssueComment[] = [],
): GitHubClient {
  return {
    getIssue: async () => issue,
    listIssueComments: async () => comments,
  } as unknown as GitHubClient;
}

describe("issue context builder", () => {
  it("keeps a small issue and its comments intact", async () => {
    const context = await buildIssueContext(
      fakeGithub(smallIssue, [comment(1, "me too"), comment(2, "here too")]),
      { installationId: "42", owner: "o", name: "r", number: 7 },
    );

    expect(context.issue.body).toBe("Short body");
    expect(context.comments).toHaveLength(2);
    expect(context.degraded).toEqual([]);
    expect(context.estimatedTokens).toBeGreaterThan(0);
  });

  it("drops comments before truncating the body when over budget", async () => {
    const budget: IssueContextBudget = {
      maxTokens: 100,
      maxBodyChars: 80,
      maxComments: 10,
    };
    const context = await buildIssueContext(
      fakeGithub(smallIssue, [comment(1, "x".repeat(400))]),
      { installationId: "42", owner: "o", name: "r", number: 7 },
      budget,
    );

    expect(context.degraded).toContain("comments_dropped");
    expect(context.comments).toEqual([]);
    expect(context.issue.body).toBe("Short body");
  });

  it("keeps a meaningful head and tail instead of an arbitrary slice", async () => {
    const budget: IssueContextBudget = {
      maxTokens: 100,
      maxBodyChars: 200,
      maxComments: 10,
    };
    const body = "HEAD".concat("x".repeat(5_000)).concat("TAIL");
    const context = await buildIssueContext(
      fakeGithub({ ...smallIssue, body }, []),
      { installationId: "42", owner: "o", name: "r", number: 7 },
      budget,
    );

    expect(context.degraded).toContain("issue_body_truncated");
    expect(context.issue.body).toContain("HEAD");
    expect(context.issue.body).toContain("TAIL");
    expect(context.issue.body.length).toBeLessThan(250);
  });

  it("caps the context at the budget even when truncation is not enough", async () => {
    const budget: IssueContextBudget = {
      maxTokens: 10,
      maxBodyChars: 200,
      maxComments: 10,
    };
    const body = "y".repeat(1_000);
    const context = await buildIssueContext(
      fakeGithub({ ...smallIssue, body }, [comment(1, "z".repeat(500))]),
      { installationId: "42", owner: "o", name: "r", number: 7 },
      budget,
    );

    expect(context.degraded).toContain("issue_body_capped");
    expect(context.issue.body.length).toBeLessThan(60);
    expect(context.issue.body).toContain("上下文超限");
  });

  it("keeps only the newest comments up to the limit", async () => {
    const comments = [
      comment(1, "oldest"),
      comment(2, "middle"),
      comment(3, "newest"),
    ];
    const budget: IssueContextBudget = {
      maxTokens: 1_000,
      maxBodyChars: 80,
      maxComments: 2,
    };
    const context = await buildIssueContext(
      fakeGithub(smallIssue, comments),
      { installationId: "42", owner: "o", name: "r", number: 7 },
      budget,
    );

    expect(context.comments.map((entry) => entry.body)).toEqual([
      "middle",
      "newest",
    ]);
    expect(context.degraded).toEqual([]);
  });

  it("estimates tokens as roughly one token per four characters", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefghi")).toBe(3);
  });
});

describe("zero issue comment budget", () => {
  it("excludes every comment when maxComments is zero", async () => {
    const context = await buildIssueContext(
      fakeGithub(smallIssue, [comment(1, "oldest"), comment(2, "newest")]),
      { installationId: "42", owner: "o", name: "r", number: 7 },
      { maxTokens: 1_000, maxBodyChars: 80, maxComments: 0 },
    );
    expect(context.comments).toEqual([]);
    expect(context.issue.body).toBe(smallIssue.body);
    expect(context.estimatedTokens).toBe(
      estimateTokens(smallIssue.title) + estimateTokens(smallIssue.body),
    );
  });
});
