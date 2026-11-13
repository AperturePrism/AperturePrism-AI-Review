import type {
  IssueSignals,
  LeadIssueNormalized,
  SignalOverlap,
} from "./types.js";

// No leading boundary so a "v1.2.3" version is matched from its "1", not from a
// later segment like "2.3". Optional "v" prefix is stripped by the caller.
const VERSION_PATTERN = /[Vv]?(?:\d+\.){1,3}\d+(?:[-+][0-9A-Za-z.-]+)?/gu;
const ERROR_CODE_PATTERN =
  /\b(?:[A-Z]{2,}[0-9]{2,}|HTTP_[A-Z0-9_]+|0x[0-9A-Fa-f]{4,})\b/gu;
// Detection-only regexes must NOT be global: a global /g keeps lastIndex across
// .test() calls and makes hasStackTrace stateful between issues.
const STACK_PATTERN =
  /(?:stack\s*trace|at\s+[\w$<>:/.]+\(|^\s*at\s+[\w$/.:]+)/imu;
const LANG_SPLIT = /(?:^|\n)\s*```(\w+)/gu;
const MODULE_PATTERN = /\b(?:from|require|import)\s+['"]([^'"]+)['"]/gu;
const REPRODUCTION_PATTERN =
  /\b(?:(?:step(s)?\s+to\s+)?repro(?:duce)?|actual\s+output|expected\s+output)\b/iu;

/** Extracts structured signals used for candidate recall and evidence overlap. */
export function extractIssueSignals(input: LeadIssueNormalized): IssueSignals {
  const haystack = `${input.title}\n${input.body}`;

  const versions = Array.from(
    new Set(
      Array.from(haystack.matchAll(VERSION_PATTERN), (m) =>
        (m[0] ?? "").replace(/^[Vv]/u, ""),
      ),
    ),
  ).filter((v) => v.length > 0);

  const errorCodes = Array.from(
    new Set(
      Array.from(haystack.matchAll(ERROR_CODE_PATTERN), (m) =>
        (m[0] ?? "").toUpperCase(),
      ),
    ),
  );

  const paths = Array.from(
    new Set(
      Array.from(haystack.matchAll(MODULE_PATTERN), (m) => m[1])
        .map((path) => {
          if (!path) return "";
          const parts = path.split("/");
          // A scope alone is not a package: @scope/http and @scope/storage
          // must not contribute a shared strong signal.
          return path.startsWith("@")
            ? parts.slice(0, 2).join("/")
            : (parts[0] ?? "");
        })
        .filter(Boolean),
    ),
  );

  const languages = Array.from(
    new Set(
      Array.from(haystack.matchAll(LANG_SPLIT), (m) =>
        (m[1] ?? "").toLowerCase(),
      ),
    ),
  );

  const templateFields: [string, string][] = [];
  const fieldMatch = haystack.match(/([\w ]\*{1,3}:?)\s*[:：]\s*([^\n]+)/gu);
  const fieldLines = (fieldMatch ?? []).slice(0, 12);
  for (const line of fieldLines) {
    const parts = line.split(/[:：]/u);
    if (parts.length >= 2) {
      const key = (parts.shift() ?? "").trim().replace(/[*]+/gu, "");
      const value = parts.join(":").trim();
      if (key && value) templateFields.push([key.toLowerCase(), value]);
    }
  }

  return {
    versions,
    errorCodes,
    paths,
    languages,
    hasStackTrace: STACK_PATTERN.test(haystack),
    hasReproduction: REPRODUCTION_PATTERN.test(haystack),
    templateFields,
  };
}

/**
 * Counts the strong signals two issues share. Strong signals are error codes,
 * stack traces (markers), module paths, and languages — things a model cannot
 * fabricate from thin air — and are the basis for calling a candidate a true
 * duplicate rather than merely related.
 */
export function computeSignalOverlap(
  lead: IssueSignals,
  candidate: IssueSignals,
): SignalOverlap {
  const sharedErrorCodes = intersectionSize(
    lead.errorCodes,
    candidate.errorCodes,
  );
  const sharedPaths = intersectionSize(lead.paths, candidate.paths);
  const sharedLanguages = intersectionSize(lead.languages, candidate.languages);
  const sharedStack = lead.hasStackTrace && candidate.hasStackTrace ? 1 : 0;
  const strongShared =
    sharedErrorCodes + sharedPaths + sharedStack + Math.min(sharedLanguages, 1);
  return {
    sharedVersions: intersectionSize(lead.versions, candidate.versions),
    sharedErrorCodes,
    sharedPaths,
    sharedLanguages,
    strongShared,
  };
}

function intersectionSize(
  left: readonly string[],
  right: readonly string[],
): number {
  const set = new Set(right);
  let count = 0;
  for (const value of left) if (set.has(value)) count += 1;
  return count;
}
