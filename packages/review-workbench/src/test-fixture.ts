/** 测试使用真正的临时数据目录；不会触碰开发者的工作台。 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { createWorkbench } from "./index.js";
import type { Actor, WorkbenchOptions } from "./types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

export const reviewer: Actor = {
  userId: "reviewer",
  isAdmin: false,
  canAccessRepository: (repository) => repository === "acme/app",
};
export const observer: Actor = {
  userId: "observer",
  isAdmin: false,
  canAccessRepository: (repository, write) =>
    repository === "acme/app" && !write,
};
export const administrator: Actor = {
  userId: "admin",
  isAdmin: true,
  canAccessRepository: () => false,
};

export async function makeHarness(options: Partial<WorkbenchOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "aperture-workbench-"));
  directories.push(directory);
  let time = new Date("2026-11-13T00:00:00.000Z");
  const workbench = createWorkbench({
    dataDirectory: directory,
    now: () => new Date(time),
    ...options,
  });
  const call = <T = unknown>(
    action: string,
    input: Record<string, unknown> = {},
    actor = reviewer,
  ): Promise<T> =>
    workbench.execute(actor, {
      action,
      input: { repository: "acme/app", ...input },
    }) as Promise<T>;
  return {
    directory,
    workbench,
    call,
    setTime: (value: string) => {
      time = new Date(value);
    },
  };
}

export const sampleFinding = {
  ruleId: "missing-authorization",
  title: "管理接口缺少仓库授权",
  description: "调用者可以修改其它仓库设置",
  path: "src/api.ts",
  line: 42,
  severity: "high",
  confidence: 0.95,
};

export const budgetPeriod = {
  periodStart: "2026-11-01T00:00:00Z",
  periodEnd: "2026-12-01T00:00:00Z",
};
export const budgetLimits = {
  amountMicros: 1_000_000,
  inputTokens: 100_000,
  outputTokens: 50_000,
  requests: 100,
};
