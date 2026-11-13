import { describe, expect, it } from "vitest";
import type {
  ModelCandidate,
  ModelProviderAdapter,
} from "../../../packages/domain/src/index.js";
import { judgeDuplicates, parseDuplicateJudgmentJson } from "./judge.js";

const candidate: ModelCandidate = {
  provider: "newapi",
  model: "deepseek-chat",
  accountName: "newapi-main",
};

const validJudgment = JSON.stringify({
  contractVersion: "duplicate-judgment/v1",
  decision: "duplicate",
  relatedIssues: [7],
  sharedSignals: ["HTTP_511", "same module"],
  differingSignals: ["different version"],
  confidence: 0.92,
});

function adapter(contents: readonly string[]) {
  let calls = 0;
  const a: ModelProviderAdapter = {
    provider: "newapi",
    invoke: async () => {
      const content = contents[Math.min(calls, contents.length - 1)] ?? "";
      calls += 1;
      return { content, usage: { inputTokens: 5, outputTokens: 3 } };
    },
  };
  return { a, calls: () => calls };
}

const refOptions = {
  deadlineMs: 10_000,
  retryPolicy: { maxAttemptsPerCandidate: 1, baseDelayMs: 10, maxDelayMs: 100 },
};

describe("duplicate judgment parsing", () => {
  it("parses a valid duplicate judgment", () => {
    const result = parseDuplicateJudgmentJson(validJudgment);
    expect(result.outcome).toBe("valid");
    if (result.outcome !== "valid") return;
    expect(result.judgment.decision).toBe("duplicate");
    expect(result.judgment.relatedIssues).toEqual([7]);
    expect(result.judgment.confidence).toBe(0.92);
  });
});

describe("judgeDuplicates", () => {
  it("returns a valid judgment from the model", async () => {
    const { a, calls } = adapter([validJudgment]);
    const outcome = await judgeDuplicates(
      {
        adapters: new Map([["newapi", a]]),
        candidates: [candidate],
        ...refOptions,
      },
      {
        lead: { issueNumber: 1, title: "crash", body: "HTTP_511 on api" },
        candidates: [
          { issueNumber: 7, title: "same crash", body: "HTTP_511 api" },
        ],
      },
    );
    expect(calls()).toBe(1);
    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.judgment.decision).toBe("duplicate");
    expect(outcome.judgment.relatedIssues).toEqual([7]);
  });

  it("repairs invalid output once and then reports valid", async () => {
    const { a, calls } = adapter(["not json", validJudgment]);
    const outcome = await judgeDuplicates(
      {
        adapters: new Map([["newapi", a]]),
        candidates: [candidate],
        ...refOptions,
      },
      {
        lead: { issueNumber: 1, title: "c", body: "b" },
        candidates: [{ issueNumber: 7, title: "c2", body: "b2" }],
      },
    );
    expect(calls()).toBe(2);
    expect(outcome.outcome).toBe("valid");
  });

  it("reports invalid when repair also fails", async () => {
    const { a, calls } = adapter(["not json", JSON.stringify({ nope: true })]);
    const outcome = await judgeDuplicates(
      {
        adapters: new Map([["newapi", a]]),
        candidates: [candidate],
        ...refOptions,
      },
      {
        lead: { issueNumber: 1, title: "c", body: "b" },
        candidates: [{ issueNumber: 7, title: "c2", body: "b2" }],
      },
    );
    expect(calls()).toBe(2);
    expect(outcome.outcome).toBe("invalid");
  });
});

describe("duplicate repair cancellation", () => {
  const input = {
    lead: { issueNumber: 1, title: "crash", body: "HTTP_511" },
    candidates: [{ issueNumber: 7, title: "same crash", body: "HTTP_511" }],
  };

  it("does not start a repair after the caller has canceled", async () => {
    const controller = new AbortController();
    let calls = 0;
    const a: ModelProviderAdapter = {
      provider: "newapi",
      invoke: async () => {
        calls += 1;
        if (calls === 1) {
          controller.abort();
          return {
            content: "not JSON",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        return {
          content: validJudgment,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    await expect(
      judgeDuplicates(
        {
          adapters: new Map([["newapi", a]]),
          candidates: [candidate],
          ...refOptions,
          signal: controller.signal,
        },
        input,
      ),
    ).rejects.toThrow(/canceled/);
    expect(calls).toBe(1);
  });

  it("forwards cancellation while a repair is in progress", async () => {
    const controller = new AbortController();
    let calls = 0;
    const a: ModelProviderAdapter = {
      provider: "newapi",
      invoke: async (_candidate, _request, signal) => {
        calls += 1;
        if (calls === 1)
          return {
            content: "not JSON",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        controller.abort();
        if (signal.aborted) throw new DOMException("canceled", "AbortError");
        return {
          content: validJudgment,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    await expect(
      judgeDuplicates(
        {
          adapters: new Map([["newapi", a]]),
          candidates: [candidate],
          ...refOptions,
          signal: controller.signal,
        },
        input,
      ),
    ).rejects.toThrow(/canceled/);
    expect(calls).toBe(2);
  });
});
