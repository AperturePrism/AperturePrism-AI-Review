/** CODEOWNERS 与路径边界回归：保持最后匹配、空负责人清除与相对路径约束。 */
import { describe, expect, it } from "vitest";
import {
  assignReviewOwners,
  ownersForPath,
  parseCodeOwners,
} from "./owners.js";
import {
  containsControlCharacters,
  matchPath,
  normalizeReviewPath,
  safeReportUrl,
} from "./utils/path.js";

it("applies the last matching CODEOWNERS rule including explicit clearing", () => {
  const owners = parseCodeOwners(
    "* @all\n/src/** @core\n/src/auth.ts @security\n/src/public.ts\n",
  );
  expect(ownersForPath(owners, "README.md")).toEqual(["@all"]);
  expect(ownersForPath(owners, "src/other.ts")).toEqual(["@core"]);
  expect(ownersForPath(owners, "src/auth.ts")).toEqual(["@security"]);
  expect(ownersForPath(owners, "src/public.ts")).toEqual([]);
});

it("warns about unsupported CODEOWNERS syntax and malformed identities", () => {
  const parsed = parseCodeOwners(
    "!secret @team\n[abc].ts @team\nsrc/** random-name\n/src/** @team # valid comment",
  );
  expect(parsed.warnings).toHaveLength(3);
  expect(parsed.rules).toHaveLength(1);
  expect(parsed.rules[0]?.owners).toEqual(["@team"]);
});

it("groups each owner once per path with sensitive paths ahead of ordinary churn", () => {
  const owners = parseCodeOwners("* @all\n/src/auth.ts @security @all\n");
  const result = assignReviewOwners(owners, [
    {
      path: "src/a.ts",
      additions: 100,
      deletions: 20,
      securitySensitive: false,
    },
    {
      path: "src/auth.ts",
      additions: 1,
      deletions: 0,
      securitySensitive: true,
    },
  ]);
  expect(result.find((item) => item.owner === "@all")?.changedLines).toBe(121);
  expect(
    result.find((item) => item.owner === "@security")?.sensitivePaths,
  ).toEqual(["src/auth.ts"]);
});

describe("repository path rules", () => {
  it.each([
    ["**/*.ts", "a.ts", true],
    ["**/*.ts", "src/deep/a.ts", true],
    ["src/*.ts", "src/deep/a.ts", false],
    ["src/?.ts", "src/a.ts", true],
    ["src/?.ts", "src/ab.ts", false],
    ["src/[a].ts", "src/[a].ts", true],
    ["src/a+b.ts", "src/ab.ts", false],
    ["src/a+b.ts", "src/a+b.ts", true],
    ["", "a.ts", false],
  ])("matches %s against %s as %s", (pattern, path, expected) => {
    expect(matchPath(pattern as string, path as string)).toBe(expected);
  });

  it("normalizes platform slashes without decoding repository filename bytes", () => {
    expect(normalizeReviewPath("src\\a.ts")).toBe("src/a.ts");
    expect(normalizeReviewPath("./src//a.ts")).toBe("src/a.ts");
    expect(normalizeReviewPath("src/%2e%2e.ts")).toBe("src/%2e%2e.ts");
  });

  it.each([
    "../secret",
    "src/../secret",
    "/tmp/file",
    "C:\\tmp\\file",
    "\u0000x",
    "\nfile",
  ])("rejects unsafe paths %s", (path) => {
    expect(() => normalizeReviewPath(path)).toThrow();
  });

  it("rejects control bytes and unsafe report URL protocols", () => {
    expect(containsControlCharacters("plain text")).toBe(false);
    expect(containsControlCharacters("line\nbreak")).toBe(true);
    expect(() => safeReportUrl("javascript:alert(1)")).toThrow();
    expect(() => safeReportUrl("https://user:secret@example.com")).toThrow();
    expect(safeReportUrl("https://github.com/o/r")).toBe(
      "https://github.com/o/r",
    );
  });
});
