import { describe, expect, it } from "vitest";
import {
  parseAutoMergeSettings,
  parseRequiredAutoMergeChecks,
  MAX_AUTO_MERGE_CHECKS,
  MAX_AUTO_MERGE_CHECK_NAME,
} from "./auto-merge.js";
import { validateSettingValue } from "./settings-registry.js";

describe("repository auto-merge settings", () => {
  it("requires an explicit true and defaults to squash without inherited settings", () => {
    expect(parseAutoMergeSettings(new Map())).toEqual({
      enabled: false,
      method: "squash",
      requiredChecks: [],
    });
    for (const enabled of ["", "1", "yes", "TRUE", "true ", "false"])
      expect(
        parseAutoMergeSettings(new Map([["pr_auto_merge_enabled", enabled]]))
          .enabled,
      ).toBe(false);
    expect(
      parseAutoMergeSettings(new Map([["pr_auto_merge_enabled", "true"]])),
    ).toEqual({ enabled: true, method: "squash", requiredChecks: [] });
  });

  it("preserves exact JSON check names, including commas, and deduplicates", () => {
    const requiredChecks = JSON.stringify([
      "  build (Linux, Node 22)  ",
      "tests / integration",
      "tests / integration",
    ]);
    expect(
      parseAutoMergeSettings(
        new Map([
          ["pr_auto_merge_enabled", "true"],
          ["pr_auto_merge_method", "rebase"],
          ["pr_auto_merge_required_checks", requiredChecks],
        ]),
      ),
    ).toEqual({
      enabled: true,
      method: "rebase",
      requiredChecks: ["build (Linux, Node 22)", "tests / integration"],
    });
    expect(parseRequiredAutoMergeChecks("build, test\r\n lint\n\n")).toEqual([
      "build",
      "test",
      "lint",
    ]);
  });

  it("disables auto-merge instead of dropping malformed required checks", () => {
    for (const checks of [
      "[not-json",
      "[null]",
      "[1]",
      '[""]',
      '["build\\nother"]',
      "test\u0000bad",
      "x".repeat(MAX_AUTO_MERGE_CHECK_NAME + 1),
      JSON.stringify(
        Array.from(
          { length: MAX_AUTO_MERGE_CHECKS + 1 },
          (_, i) => `check${i}`,
        ),
      ),
    ]) {
      expect(
        parseAutoMergeSettings(
          new Map([
            ["pr_auto_merge_enabled", "true"],
            ["pr_auto_merge_required_checks", checks],
          ]),
        ).enabled,
      ).toBe(false);
      expect(
        validateSettingValue("pr_auto_merge_required_checks", checks),
      ).not.toBeNull();
    }
  });

  it("accepts bounded maximum names and rejects an invalid merge method", () => {
    const checks = JSON.stringify(
      Array.from({ length: MAX_AUTO_MERGE_CHECKS }, (_, i) => `check${i}`),
    );
    expect(parseRequiredAutoMergeChecks(checks)).toHaveLength(
      MAX_AUTO_MERGE_CHECKS,
    );
    expect(
      parseRequiredAutoMergeChecks(
        JSON.stringify(["x".repeat(MAX_AUTO_MERGE_CHECK_NAME)]),
      )[0],
    ).toHaveLength(MAX_AUTO_MERGE_CHECK_NAME);
    expect(
      parseAutoMergeSettings(
        new Map([
          ["pr_auto_merge_enabled", "true"],
          ["pr_auto_merge_method", "force"],
        ]),
      ).enabled,
    ).toBe(false);
    expect(
      validateSettingValue("pr_auto_merge_method", "force"),
    ).not.toBeNull();
    for (const method of ["merge", "squash", "rebase"])
      expect(validateSettingValue("pr_auto_merge_method", method)).toBeNull();
    expect(
      validateSettingValue("pr_auto_merge_required_checks", checks),
    ).toBeNull();
  });
});
