/**
 * Minimal, well-tested unified-diff parsing. Only the subset GitHub returns in
 * a PR diff is needed: a `diff --git` header per file, optional `---`/`+++`
 * path markers, `@@ -a,b +c,d @@` hunk headers, and ` ` / `+` / `-` lines.
 * Binary files appear as `Binary files ... differ` with no hunks.
 */

export type DiffLineKind = "context" | "add" | "delete";

export type DiffLine = {
  kind: DiffLineKind;
  /** After (new file) 1-based line number; 0 for pure deletions. */
  afterLine: number;
  text: string;
};

export type DiffHunk = {
  newStart: number;
  lines: readonly DiffLine[];
  additions: number;
  deletions: number;
};

export type DiffFile = {
  oldPath: string | null;
  newPath: string;
  /** null when the file is binary or has no text hunks. */
  hunks: readonly DiffHunk[] | null;
  additions: number;
  deletions: number;
};

export type ParsedDiff = {
  files: readonly DiffFile[];
  additions: number;
  deletions: number;
};

export function parseUnifiedDiff(diffText: string): ParsedDiff {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let inHunk = false;
  let after = 0;

  const flush = () => {
    if (!current) return;
    if (hunk) {
      current.hunks = [...(current.hunks ?? []), hunk];
      hunk = null;
    }
    if (current.hunks && current.hunks.length > 0) {
      current.additions = current.hunks.reduce((s, h) => s + h.additions, 0);
      current.deletions = current.hunks.reduce((s, h) => s + h.deletions, 0);
    }
    files.push(current);
    current = null;
    inHunk = false;
  };

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      flush();
      const paths = parseDiffGitHeader(line);
      current = {
        oldPath: paths.oldPath,
        newPath: paths.newPath,
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      continue;
    }
    if (!current) continue;

    if (!inHunk && line.startsWith("--- ")) {
      current.oldPath = decodePath(line.slice(4));
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      current.newPath = decodePath(line.slice(4));
      continue;
    }
    if (/^Binary files /.test(line) || /^GIT binary patch/.test(line)) {
      current.hunks = null;
      hunk = null;
      inHunk = false;
      continue;
    }

    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      if (current.hunks === null) continue;
      if (hunk) current.hunks = [...current.hunks, hunk];
      hunk = {
        newStart: Number(hunkMatch[1]),
        lines: [],
        additions: 0,
        deletions: 0,
      };
      after = hunk.newStart;
      inHunk = true;
      continue;
    }

    if (!inHunk || !hunk) continue;

    const body = line.slice(1);
    if (line.startsWith("+")) {
      hunk.lines = [...hunk.lines, { kind: "add", afterLine: after, text: body }];
      hunk.additions += 1;
      after += 1;
    } else if (line.startsWith("-")) {
      hunk.lines = [...hunk.lines, { kind: "delete", afterLine: 0, text: body }];
      hunk.deletions += 1;
    } else if (line.startsWith(" ")) {
      hunk.lines = [...hunk.lines, { kind: "context", afterLine: after, text: body }];
      after += 1;
    }
  }
  flush();

  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  return { files, additions, deletions };
}

function decodePath(raw: string): string {
  const value = raw.replace(/\s+$/, "");
  if (value === "/dev/null") return value;
  if (value.startsWith("a/") || value.startsWith("b/")) return value.slice(2);
  return value;
}

/**
 * `diff --git a/OLD b/NEW` may be the only path source for binary files (which
 * have no `---`/`+++` markers). Falls back to `/dev/null` for the old path so
 * deleted/new files parse even without the `---` line. Paths containing the
 * ` b/` separator are quoted by git; this simple split covers the common case.
 */
function parseDiffGitHeader(line: string): {
  oldPath: string | null;
  newPath: string;
} {
  const rest = line.slice("diff --git ".length);
  const bIndex = rest.indexOf(" b/");
  if (bIndex < 0) return { oldPath: null, newPath: "" };
  const aPart = rest.slice(0, bIndex);
  const newPart = rest.slice(bIndex + 3);
  const oldPath = aPart.startsWith("a/") ? aPart.slice(2) : aPart;
  return { oldPath: oldPath || null, newPath: newPart || "" };
}

export function findFile(diff: ParsedDiff, path: string): DiffFile | undefined {
  return diff.files.find((f) => f.newPath === path);
}

/** After-line span covered by the file's text hunks (for anchoring). */
export function lineSpan(file: DiffFile): { minAfter: number; maxAfter: number } {
  if (!file.hunks || file.hunks.length === 0) return { minAfter: 0, maxAfter: 0 };
  let minAfter = Number.POSITIVE_INFINITY;
  let maxAfter = 0;
  for (const hunk of file.hunks) {
    for (const entry of hunk.lines) {
      if (entry.afterLine === 0) continue;
      if (entry.afterLine < minAfter) minAfter = entry.afterLine;
      if (entry.afterLine > maxAfter) maxAfter = entry.afterLine;
    }
  }
  if (minAfter === Number.POSITIVE_INFINITY) return { minAfter: 0, maxAfter };
  return { minAfter, maxAfter };
}