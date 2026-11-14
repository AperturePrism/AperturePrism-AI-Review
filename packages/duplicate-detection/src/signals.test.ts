import { describe, expect, it } from "vitest";
import { computeSignalOverlap, extractIssueSignals } from "./signals.js";
import { normalizeTokenString, normalizedIndexText } from "./normalize.js";

describe("issue normalization", () => {
  it("strips template boilerplate and collapses whitespace", () => {
    const body = `
      When submitting an issue please include

      OS version           : 16.0
      Steps to reproduce:

      The app crashes on double-tap.
    `;
    const normalized = normalizedIndexText({
      title: "  Double-tap crash  ",
      body,
    });
    expect(normalizeTokenString(normalized)).toContain("double-tap crash");
    expect(normalizeTokenString(normalized)).toContain("app crashes");
    expect(normalizeTokenString(normalized)).not.toContain("when submitting");
    expect(normalizeTokenString(normalized)).not.toContain("os version");
  });
});

describe("issue signal extraction", () => {
  it("extracts version, error code, language, module and reproduction signals", () => {
    const signals = extractIssueSignals({
      title: "v1.2.3 crash 0x0000A1F and HTTP_511 on startup",
      body: '\n          ```ts\n          import { foo } from "@scope/util";\n          ```\n          Steps to reproduce: open app\n          Stack trace:\n            at Object.<anonymous>\n        ',
      labels: ["bug"],
    });
    expect(signals.versions).toContain("1.2.3");
    expect(signals.errorCodes.some((c) => c === "0X0000A1F")).toBe(true);
    expect(signals.errorCodes.some((c) => c === "HTTP_511")).toBe(true);
    expect(signals.paths).toContain("@scope/util");
    expect(signals.languages).toContain("ts");
    expect(signals.hasStackTrace).toBe(true);
    expect(signals.hasReproduction).toBe(true);
  });

  it("counts strong-signal overlap between two issues", () => {
    const lead = extractIssueSignals({
      title: "crash",
      body: "HTTP_500 at ./api 1.2.3\nStack trace:\n at main",
      labels: [],
    });
    const same = extractIssueSignals({
      title: "also crash",
      body: "HTTP_500 ./api 1.2.3\nStack trace:\n at main",
      labels: [],
    });
    const different = extractIssueSignals({
      title: "typo",
      body: "just a typo in the docs",
      labels: [],
    });
    const overlap = computeSignalOverlap(lead, same);
    expect(overlap.strongShared).toBeGreaterThanOrEqual(2);
    expect(computeSignalOverlap(lead, different).strongShared).toBe(0);
  });
});

describe("scoped package signals", () => {
  function signals(module: string) {
    return extractIssueSignals({
      title: "crash",
      body: `import value from "${module}";`,
      labels: [],
    });
  }

  it("keeps scope and package name as one module identity", () => {
    expect(signals("@scope/util/subpath").paths).toEqual(["@scope/util"]);
    expect(signals("lodash/fp").paths).toEqual(["lodash"]);
  });

  it("does not treat unrelated packages in the same scope as shared evidence", () => {
    const overlap = computeSignalOverlap(
      signals("@scope/http"),
      signals("@scope/storage"),
    );
    expect(overlap.sharedPaths).toBe(0);
    expect(overlap.strongShared).toBe(0);
  });

  it("recognizes different subpaths of the same scoped package", () => {
    expect(
      computeSignalOverlap(signals("@scope/util/a"), signals("@scope/util/b"))
        .sharedPaths,
    ).toBe(1);
  });
});
