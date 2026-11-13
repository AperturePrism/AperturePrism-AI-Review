import { describe, expect, it } from "vitest";
import {
  findFile,
  lineSpan,
  parseUnifiedDiff,
} from "./diff.js";

const sample = `diff --git a/src/client.ts b/src/client.ts
index abc123..def456 100644
--- a/src/client.ts
+++ b/src/client.ts
@@ -1,4 +1,5 @@
 import { http } from "http";
+
 export async function connect() {
-  return http.get("///");
+  return http.get("https://api.example.com");
 }
diff --git a/package-lock.json b/package-lock.json
index 111..222 100644
Binary files a/package-lock.json and b/package-lock.json differ
diff --git a/README.md b/README.md
new file mode 100644
index 000..333
--- /dev/null
+++ b/README.md
@@ -0,0 +1,3 @@
+# Hello
+World
+End
`;

describe("parseUnifiedDiff", () => {
  it("splits files and counts additions/deletions from hunks", () => {
    const diff = parseUnifiedDiff(sample);
    expect(diff.files).toHaveLength(3);
    const client = findFile(diff, "src/client.ts");
    expect(client).toBeDefined();
    expect(client?.additions).toBe(2);
    expect(client?.deletions).toBe(1);
    expect(diff.additions).toBe(5);
    expect(diff.deletions).toBe(1);
  });

  it("marks binary files with no hunks", () => {
    const diff = parseUnifiedDiff(sample);
    const lock = findFile(diff, "package-lock.json");
    expect(lock?.hunks).toBeNull();
    expect(lock?.additions).toBe(0);
    expect(lock?.deletions).toBe(0);
  });

  it("maps after-line numbers across hunks", () => {
    const diff = parseUnifiedDiff(sample);
    const readme = findFile(diff, "README.md");
    const lines = readme?.hunks?.[0]?.lines ?? [];
    expect(lines[0]!).toMatchObject({ kind: "add", afterLine: 1 });
    expect(lines[2]!).toMatchObject({ kind: "add", afterLine: 3 });
  });

  it("returns the after-line span of a file", () => {
    const diff = parseUnifiedDiff(sample);
    const readme = findFile(diff, "README.md");
    const span = lineSpan(readme!);
    expect(span).toEqual({ minAfter: 1, maxAfter: 3 });
  });

  it("ignores diffstat/metadata lines outside hunks", () => {
    const metadataLaden = `diff --git a/x.txt b/x.txt
index 1..2 100644
--- a/x.txt
+++ b/x.txt
@@ -1 +1 @@
-old
+new
`;
    const diff = parseUnifiedDiff(metadataLaden);
    expect(diff.files).toHaveLength(1);
    expect(diff.additions).toBe(1);
    expect(diff.deletions).toBe(1);
  });
});
it("keeps header-like source lines inside a hunk as deletions and additions", () => {
  const parsed = parseUnifiedDiff(`diff --git a/notes.txt b/notes.txt
--- a/notes.txt
+++ b/notes.txt
@@ -1,2 +1,2 @@
--- old heading
+++ new heading
 unchanged
`);
  expect(parsed.files[0]).toMatchObject({
    oldPath: "notes.txt",
    newPath: "notes.txt",
    additions: 1,
    deletions: 1,
  });
  expect(parsed.files[0]?.hunks?.[0]?.lines).toEqual([
    { kind: "delete", afterLine: 0, text: "-- old heading" },
    { kind: "add", afterLine: 1, text: "++ new heading" },
    { kind: "context", afterLine: 2, text: "unchanged" },
  ]);
});
