import { describe, expect, it, vi } from "vitest";
import type { PrReviewContract } from "../../../packages/pr-review/src/types.js";
import {
  syncReviewToWorkbench,
  reviewAutomationEvent,
  type ReviewWorkbench,
} from "./workbench.js";

const review: PrReviewContract = {
  contractVersion: "pr-review/v1",
  summary: "Review",
  changedFileCount: 1,
  additions: 5,
  deletions: 1,
  overallTone: "comment",
  findings: [
    {
      rule: "null-check",
      file: "src/app.ts",
      afterLine: 0,
      severity: "medium",
      message: "Handle missing config",
      evidence: "readConfig().port",
      impact: "Startup fails",
      confidence: 0.9,
      suggestion: "Check the result",
    },
  ],
};

describe("review workbench integration", () => {
  it("maps real findings and confines the worker actor to the task repository", async () => {
    const execute = vi
      .fn<ReviewWorkbench["execute"]>()
      .mockResolvedValue({ imported: 1 });
    await syncReviewToWorkbench(
      { execute },
      {
        repository: "o/r",
        reference: "head-a",
        pullNumber: 7,
        review,
        workerId: "worker-a",
      },
    );
    const [actor, command] = execute.mock.calls[0]!;
    expect(actor.canAccessRepository("o/r", true)).toBe(true);
    expect(actor.canAccessRepository("o/other", false)).toBe(false);
    expect(command.action).toBe("review.sync");
    expect(command.input).toMatchObject({
      repository: "o/r",
      source: "pr#7",
      reference: "head-a",
      resolveMissing: false,
      findings: [{ ruleId: "null-check", path: "src/app.ts", line: 1 }],
    });
  });

  it("keeps fingerprints stable when the line moves and isolates different PRs", async () => {
    const execute = vi.fn<ReviewWorkbench["execute"]>().mockResolvedValue({});
    const input = {
      repository: "o/r",
      reference: "head-a",
      pullNumber: 7,
      review,
      workerId: "worker-a",
    };
    await syncReviewToWorkbench({ execute }, input);
    await syncReviewToWorkbench(
      { execute },
      {
        ...input,
        reference: "head-b",
        review: {
          ...review,
          findings: review.findings.map((finding) => ({
            ...finding,
            afterLine: 42,
          })),
        },
      },
    );
    await syncReviewToWorkbench({ execute }, { ...input, pullNumber: 8 });
    const fingerprint = (index: number) =>
      (
        execute.mock.calls[index]![1].input.findings as {
          fingerprint: string;
        }[]
      )[0]!.fingerprint;
    expect(fingerprint(0)).toBe(fingerprint(1));
    expect(fingerprint(0)).not.toBe(fingerprint(2));
  });

  it("sends an empty successful review to resolve older findings from that PR", async () => {
    const execute = vi.fn<ReviewWorkbench["execute"]>().mockResolvedValue({});
    await syncReviewToWorkbench(
      { execute },
      {
        repository: "o/r",
        reference: "head",
        pullNumber: 7,
        review: { ...review, findings: [] },
        workerId: "worker",
      },
    );
    expect(execute.mock.calls[0]![1].input.findings).toEqual([]);
  });

  it("uses the same evidence identity when the model changes its wording", async () => {
    const execute = vi.fn<ReviewWorkbench["execute"]>().mockResolvedValue({});
    const input = {
      repository: "o/r",
      reference: "head",
      pullNumber: 7,
      review,
      workerId: "worker",
    };
    await syncReviewToWorkbench({ execute }, input);
    await syncReviewToWorkbench(
      { execute },
      {
        ...input,
        review: {
          ...review,
          findings: review.findings.map((finding) => ({
            ...finding,
            message: "Configuration might be missing",
            severity: "high",
          })),
        },
      },
    );
    const first = (
      execute.mock.calls[0]![1].input.findings as { fingerprint: string }[]
    )[0]!.fingerprint;
    const second = (
      execute.mock.calls[1]![1].input.findings as { fingerprint: string }[]
    )[0]!.fingerprint;
    expect(first).toBe(second);
  });

  it("preserves write failures for the caller to record and retry", async () => {
    const workbench: ReviewWorkbench = {
      execute: async () => {
        throw new Error("disk full");
      },
    };
    await expect(
      syncReviewToWorkbench(workbench, {
        repository: "o/r",
        reference: "head",
        pullNumber: 7,
        review,
        workerId: "worker",
      }),
    ).rejects.toThrow("disk full");
  });
});

describe("review automation event privacy and identity", () => {
  it("preserves delivery identity and time while sending only non-source metadata", () => {
    const input = {
      repository: "O/R",
      reference: "head",
      pullNumber: 7,
      review,
      workerId: "worker",
      deliveryKey: "permanent-attempt",
      occurredAt: "2026-11-13T10:00:00.000Z",
    };
    const event = reviewAutomationEvent(input, { gate: { decision: "fail" } });
    expect(event).toMatchObject({
      id: "review:permanent-attempt",
      type: "review.completed",
      repository: "o/r",
      gate: "fail",
      occurredAt: input.occurredAt,
      findings: { total: 1, medium: 1 },
    });
    expect(JSON.stringify(event)).not.toContain(review.findings[0]!.evidence);
    expect(JSON.stringify(event)).not.toContain(review.findings[0]!.suggestion);
    expect(
      reviewAutomationEvent(input, { gate: { decision: "fail" } }),
    ).toEqual(event);
  });
  it("does not emit a fresh automation event for an obsolete source revision", () => {
    expect(
      reviewAutomationEvent(
        {
          repository: "o/r",
          reference: "old-head",
          pullNumber: 7,
          review,
          workerId: "worker",
        },
        { ignored: true },
      ),
    ).toBeNull();
  });
});
