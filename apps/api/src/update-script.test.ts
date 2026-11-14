import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const fixtures: string[] = [];
const source = await readFile(
  new URL("../../../scripts/update.sh", import.meta.url),
  "utf8",
);

function shellPath(path: string) {
  return path
    .replaceAll("\\", "/")
    .replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
}

async function runScript(
  options: {
    target?: string;
    health?: string;
    helperExit?: string;
    executeHelper?: boolean;
    imageExit?: string;
    configOutput?: string;
    dryRun?: boolean;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "aperture-update-"));
  fixtures.push(dir);
  const bin = join(dir, "bin");
  const base = join(dir, "docker");
  const trace = join(dir, "trace");
  await mkdir(bin);
  await mkdir(base);
  await writeFile(join(base, "docker-compose.prod.yml"), "services: {}\n");
  await writeFile(join(base, "compose.verify.yml"), "services: {}\n");
  const script = join(dir, "update.sh");
  await writeFile(
    script,
    source.replace('BASE_DIR="/app/docker"', `BASE_DIR="${shellPath(base)}"`),
  );
  const commands: Record<string, string> = {
    docker: `#!/bin/sh
printf 'IMAGE_TAG=%s docker %s\\n' "$IMAGE_TAG" "$*" >> "$MOCK_TRACE"
case "$1" in
  ps) exit 0 ;;
  inspect) printf 'old-api-image:v1.2.15\\n' ;;
  image)
    if [ "$2" = "inspect" ]; then
      [ "\${MOCK_IMAGE_EXIT:-0}" = "0" ] || exit "$MOCK_IMAGE_EXIT"
      [ "$5" = "ghcr.io/apertureprism/apertureprism-ai-review/api:$IMAGE_TAG" ] || exit 1
      printf 'sha256:target-api-image\\n'
    fi ;;
  compose)
    case " $* " in
      *' config --format json '*)
        if [ -n "\${MOCK_CONFIG_OUTPUT:-}" ]; then
          printf '%s' "$MOCK_CONFIG_OUTPUT"
        else
          printf '{"services":{"postgres":{"image":"pgvector/pgvector:pg16"},"redis":{"image":"redis:7-alpine"},"api":{"image":"ghcr.io/apertureprism/apertureprism-ai-review/api:%s"}}}\\n' "$IMAGE_TAG"
        fi ;;
      *' config --images api '*) printf 'pgvector/pgvector:pg16\\nredis:7-alpine\\nghcr.io/apertureprism/apertureprism-ai-review/api:%s\\n' "$IMAGE_TAG" ;;
    esac ;;
  run)
    [ "\${MOCK_HELPER_EXIT:-0}" = "0" ] || exit "$MOCK_HELPER_EXIT"
    if [ "\${MOCK_EXECUTE_HELPER:-0}" = "1" ]; then
      while [ "$#" -gt 0 ]; do
        if [ "$1" = "-c" ]; then
          shift
          helper=$(printf '%s' "$1" | sed "s@/app/docker/.env.production@$TEST_ENV@g")
          sh -c "$helper"
          exit $?
        fi
        shift
      done
    fi ;;

esac
exit 0
`,
    curl: `#!/bin/sh
printf '%s' "\${MOCK_HEALTH:-200}"
`,
    sleep: "#!/bin/sh\nexit 0\n",
    df: "#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 10000 1 9999 1%% /\\n'\n",
    hostname: "#!/bin/sh\nprintf 'fixture-api-container\\n'\n",
  };
  await Promise.all(
    Object.entries(commands).map(async ([name, content]) => {
      const path = join(bin, name);
      await writeFile(path, content);
      await chmod(path, 0o755);
    }),
  );
  let stdout = "";
  let stderr = "";
  let code = 0;
  try {
    const result = await execute(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        'export PATH="$TEST_BIN:$PATH"; exec sh "$TEST_SCRIPT" --target "$TEST_TARGET" "$@"',
        "update-test",
        ...(options.dryRun ? ["--dry-run"] : []),
      ],
      {
        env: {
          ...process.env,
          TEST_BIN: shellPath(bin),
          TEST_SCRIPT: shellPath(script),
          TEST_TARGET: options.target ?? "v1.2.17",
          TEST_ENV: shellPath(join(base, "helper.env")),
          MOCK_EXECUTE_HELPER: options.executeHelper ? "1" : "0",
          MOCK_TRACE: shellPath(trace),
          MOCK_HEALTH: options.health ?? "200",
          MOCK_HELPER_EXIT: options.helperExit ?? "0",
          MOCK_IMAGE_EXIT: options.imageExit ?? "0",
          MOCK_CONFIG_OUTPUT: options.configOutput ?? "",
          IMAGE_TAG: "v1.2.15",
          UPDATE_VERSION: "v1.2.15",
          AP_VERIFY: "1",
          GITHUB_APP_KEY_MOUNT: "/host/fixture-github.pem",
        },
        timeout: 20_000,
        maxBuffer: 256_000,
      },
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const failure = error as Error & {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    if (typeof failure.code !== "number") throw error;
    code = failure.code;
    stdout = failure.stdout ?? "";
    stderr = failure.stderr ?? "";
  }
  return {
    code,
    stdout,
    stderr,
    trace: await readFile(trace, "utf8").catch(() => ""),
    envFile: await readFile(join(base, ".env.production"), "utf8").catch(
      () => "",
    ),
    helperEnv: await readFile(join(base, "helper.env"), "utf8").catch(() => ""),
  };
}

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe(
  "online update shell orchestration (mock Docker only)",
  { timeout: 30_000 },
  () => {
    it("exports the selected target for pull, migration and recreation despite old container env", async () => {
      const result = await runScript();
      expect(result.code).toBe(0);
      const composeCalls = result.trace
        .split("\n")
        .filter((line) => line.includes(" docker compose "));
      expect(composeCalls.length).toBeGreaterThanOrEqual(3);
      for (const call of composeCalls)
        expect(call).toMatch(/^IMAGE_TAG=v1\.2\.17 /);
      expect(result.envFile).toContain("IMAGE_TAG=v1.2.17\n");
      expect(result.trace).toContain("compose.verify.yml");
    });

    it("runs the detached helper from the pulled target image ID, not the old API image", async () => {
      const result = await runScript();
      expect(result.code).toBe(0);
      const helper = result.trace
        .split("\n")
        .find((line) => line.includes(" docker run "));
      expect(helper).toContain("sha256:target-api-image");
      expect(helper).not.toContain("old-api-image");
      expect(helper).toContain("--force-recreate --no-deps api");
      expect(helper).toContain(
        "/host/fixture-github.pem:/opt/apertureprism/github-app.pem:ro",
      );
      expect(helper).toContain("--env APRISM_UPDATE_ENV_B64");
      expect(helper).not.toContain(
        Buffer.from(result.envFile).toString("base64"),
      );
    });

    it("executes the generated helper shell with the target environment and forced API recreation", async () => {
      const result = await runScript({ executeHelper: true });
      expect(result.code).toBe(0);
      expect(result.helperEnv).toBe(result.envFile);
      const apiRecreation = result.trace
        .split("\n")
        .find(
          (line) =>
            line.includes(" docker compose ") &&
            line.endsWith(" up -d --force-recreate --no-deps api"),
        );
      expect(apiRecreation).toMatch(/^IMAGE_TAG=v1\.2\.17 docker compose /);
    });

    it("does not mark restart scheduling failure as a successful script", async () => {
      const result = await runScript({ helperExit: "1" });
      expect(result.code).not.toBe(0);
      expect(result.stdout).toContain("api restart scheduling failed");
      expect(result.stdout).not.toContain('"stage":"done"');
    });

    it("fails closed when the target helper image cannot be resolved", async () => {
      const result = await runScript({ imageExit: "1" });
      expect(result.code).not.toBe(0);
      expect(result.trace).not.toContain(" docker run ");
    });

    it.each(["not-json", '{"services":{"redis":{"image":"redis:7-alpine"}}}'])(
      "does not launch a helper from malformed or missing API config (%j)",
      async (configOutput) => {
        const result = await runScript({ configOutput });
        expect(result.code).not.toBe(0);
        expect(result.trace).not.toContain(" docker run ");
      },
    );

    it("exports the old target during rollback rather than leaving the new target in the environment", async () => {
      const result = await runScript({ health: "503" });
      expect(result.code).not.toBe(0);
      const recreations = result.trace
        .split("\n")
        .filter((line) => line.includes(" up -d "));
      expect(recreations).toHaveLength(2);
      expect(recreations[0]).toMatch(/^IMAGE_TAG=v1\.2\.17 /);
      expect(recreations[1]).toMatch(/^IMAGE_TAG=v1\.2\.15 /);
      expect(result.envFile).toContain("IMAGE_TAG=v1.2.15\n");
      expect(result.trace).not.toContain(" docker run ");
    });

    it("dry-run performs no Docker actions and does not overwrite the generated environment", async () => {
      const result = await runScript({ dryRun: true });
      expect(result.code).toBe(0);
      expect(result.trace).toBe("");
      expect(result.envFile).toBe("");
    });

    it.each(["v1.2.17;false", "v1.2.17\nlatest", "v1.2.17\n"])(
      "rejects malformed direct script targets (%j)",
      async (target) => {
        const result = await runScript({ target });
        expect(result.code).not.toBe(0);
        expect(result.trace).toBe("");
        expect(result.envFile).toBe("");
      },
    );
  },
);
