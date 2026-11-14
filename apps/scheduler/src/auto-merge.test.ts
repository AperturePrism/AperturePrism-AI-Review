import { describe, expect, it } from "vitest";
import {
  autoMergeChecksDecision,
  autoMergeReviewsDecision,
} from "./auto-merge.js";

const success = {
  name: "tests",
  status: "completed" as const,
  conclusion: "success",
  source: "check_run" as const,
};
describe("automatic merge check policy", () => {
  it("requires at least one check and every required exact name", () => {
    expect(autoMergeChecksDecision([], [])?.reason).toBe("no_checks");
    expect(autoMergeChecksDecision([success], ["lint"])?.reason).toBe(
      "required_checks_missing",
    );
    expect(autoMergeChecksDecision([success], ["Tests"])?.reason).toBe(
      "required_checks_missing",
    );
    expect(autoMergeChecksDecision([success], ["tests"])).toBeNull();
  });
  it.each(["failure", "timed_out", "cancelled", "neutral", "skipped", null])(
    "does not accept %s as passing",
    (conclusion) => {
      expect(
        autoMergeChecksDecision([{ ...success, conclusion }], [])?.reason,
      ).toBe("checks_failed");
    },
  );
  it("waits for in-progress work and does not let duplicate names mask a failing app", () => {
    expect(
      autoMergeChecksDecision(
        [{ ...success, status: "in_progress", conclusion: null }],
        [],
      )?.reason,
    ).toBe("checks_pending");
    expect(
      autoMergeChecksDecision(
        [success, { ...success, conclusion: "failure" }],
        [],
      )?.reason,
    ).toBe("checks_failed");
  });
});

describe("automatic merge review policy", () => {
  const review = {
    user: "reviewer",
    state: "CHANGES_REQUESTED",
    submittedAt: "2026-11-13T00:00:00Z",
    commitId: "a".repeat(40),
    userType: "User",
  };
  it("retains changes_requested through a later comment or pending review", () => {
    const comment = {
      ...review,
      state: "COMMENTED",
      submittedAt: "2026-11-13T00:01:00Z",
    };
    expect(autoMergeReviewsDecision([review, comment])?.reason).toBe(
      "changes_requested",
    );
    expect(
      autoMergeReviewsDecision([review, { ...comment, state: "PENDING" }])
        ?.reason,
    ).toBe("changes_requested");
  });
  it("uses the latest substantive decision per case-insensitive user", () => {
    const approved = {
      ...review,
      user: "Reviewer",
      state: "APPROVED",
      submittedAt: "2026-11-13T00:01:00Z",
    };
    expect(autoMergeReviewsDecision([approved, review])).toBeNull();
    expect(
      autoMergeReviewsDecision([review, { ...approved, state: "DISMISSED" }]),
    ).toBeNull();
    expect(
      autoMergeReviewsDecision([approved, { ...review, user: "other" }])
        ?.reason,
    ).toBe("changes_requested");
  });
});
