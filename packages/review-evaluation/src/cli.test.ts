/** CLI 在临时目录操作真实文件，检查退出码、报告、旧版本拒绝与覆盖保护。 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const script = join(repository, "scripts/review-evaluation.mjs");
const temporary = new Set<string>();

function command(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [script, ...args],
      { cwd: tmpdir(), timeout: 20_000, maxBuffer: 2_000_000 },
      (error, stdout, stderr) => {
        done({
          code:
            error && typeof error.code === "number"
              ? error.code
              : error
                ? -1
                : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

async function example(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "review-evaluation-"));
  temporary.add(directory);
  const created = await command(["example", "--output-dir", directory]);
  expect(created.code, created.stderr).toBe(0);
  return directory;
}

beforeAll(async () => {
  await new Promise<void>((done, fail) => {
    execFile(
      process.execPath,
      [
        join(repository, "node_modules/typescript/bin/tsc"),
        "-p",
        join(repository, "packages/review-evaluation/tsconfig.json"),
      ],
      { timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) fail(new Error(`${stdout}\n${stderr}`));
        else done();
      },
    );
  });
}, 35_000);

afterEach(async () => {
  await Promise.all(
    [...temporary].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  temporary.clear();
});

describe("offline review evaluation CLI", () => {
  it("provides help without requiring data files or contacting services", async () => {
    const result = await command(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("所有命令离线运行");
    expect((await command(["evaluate", "--unknown", "value"])).code).toBe(1);
  });

  it("creates example files and validates the exact dataset hash", async () => {
    const directory = await example();
    const validated = await command([
      "validate",
      "--dataset",
      join(directory, "cases.jsonl"),
    ]);
    expect(validated.code, validated.stderr).toBe(0);
    const result = JSON.parse(validated.stdout);
    const manifest = JSON.parse(
      await readFile(join(directory, "candidate.json"), "utf8"),
    );
    expect(result.hash).toBe(manifest.datasetHash);
    expect(result.cases).toBe(2);
    expect(result.leakage.clean).toBe(true);
  });

  it("runs paired comparison and passes a concrete gate", async () => {
    const directory = await example();
    const compared = await command([
      "compare",
      "--dataset",
      join(directory, "cases.jsonl"),
      "--run",
      join(directory, "candidate.json"),
      "--baseline",
      join(directory, "baseline.json"),
      "--gate",
      join(directory, "gate.json"),
      "--samples",
      "100",
      "--seed",
      "42",
      "--currency",
      "USD",
    ]);
    expect(compared.code, compared.stderr).toBe(0);
    const report = JSON.parse(compared.stdout);
    expect(report.evaluation.metrics.f1).toBe(1);
    expect(report.comparison.delta.f1).toBe(1);
    expect(report.comparison.intervals.f1.seed).toBe(42);
    expect(report.gate.passed).toBe(true);
  });

  it("returns a gate failure code and still produces the reviewable report", async () => {
    const directory = await example();
    const gate = join(directory, "strict.json");
    await writeFile(gate, JSON.stringify({ minF1: 0.9 }));
    const result = await command([
      "evaluate",
      "--dataset",
      join(directory, "cases.jsonl"),
      "--run",
      join(directory, "baseline.json"),
      "--gate",
      gate,
    ]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).gate.blockers).toContain("f1");
  });

  it("rejects an old prediction manifest rather than relabeling its version", async () => {
    const directory = await example();
    const path = join(directory, "candidate.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.datasetHash = "0".repeat(64);
    await writeFile(path, JSON.stringify(manifest));
    const result = await command([
      "evaluate",
      "--dataset",
      join(directory, "cases.jsonl"),
      "--run",
      path,
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("hash does not match");
  });

  it("writes Markdown and protects existing output unless overwrite is explicit", async () => {
    const directory = await example();
    const output = join(directory, "report.md");
    const args = [
      "evaluate",
      "--dataset",
      join(directory, "cases.jsonl"),
      "--run",
      join(directory, "candidate.json"),
      "--format",
      "markdown",
      "--output",
      output,
    ];
    expect((await command(args)).code).toBe(0);
    expect(await readFile(output, "utf8")).toContain("审查评估");
    expect((await command(args)).code).toBe(1);
    expect((await command([...args, "--overwrite"])).code).toBe(0);
  });

  it("exports a workbench payload and does not echo malformed prediction source", async () => {
    const directory = await example();
    const args = [
      "evaluate",
      "--dataset",
      join(directory, "cases.jsonl"),
      "--run",
      join(directory, "candidate.json"),
    ];
    const exported = await command([...args, "--format", "workbench"]);
    expect(exported.code).toBe(0);
    expect(JSON.parse(exported.stdout).cases).toHaveLength(2);
    await writeFile(
      join(directory, "candidate.jsonl"),
      "private source text that should not appear",
    );
    const failed = await command(args);
    expect(failed.code).toBe(1);
    expect(failed.stderr).not.toContain("private source text");
  });
});
