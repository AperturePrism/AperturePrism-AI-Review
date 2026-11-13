#!/usr/bin/env node
/**
 * 从实际 app/dist 发现插件，避免源码测试全绿而 Docker 缺少动态模块。
 * 用法：npm run build && node scripts/check-runtime-modules.mjs。
 * 不启动数据库、HTTP 服务或模型调用，可从任意工作目录运行。
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function verify(app) {
  const base = resolve(root, "apps", app, "dist", "packages");
  const load = (file) => import(pathToFileURL(resolve(base, file)).href);
  const checks = await load("pr-review/src/checks.js");
  const review = await load("pr-review/src/report.js");
  const workbench = await load("review-workbench/src/report.js");
  const found = await checks.discoverReviewChecks();
  if (found.size === 0)
    throw new Error(`${app}: no review checks were packaged`);
  const reviewFormats = (await review.listReviewReportFormats()).map(
    (format) => format.name,
  );
  const workbenchFormats = await workbench.reportFormats();
  for (const format of ["json", "sarif"]) {
    if (!reviewFormats.includes(format) || !workbenchFormats.includes(format)) {
      throw new Error(`${app}: required report format ${format} is missing`);
    }
  }
  console.log(
    `${app}: ${found.size} checks, ${reviewFormats.length} review formats, ${workbenchFormats.length} workbench formats`,
  );
}

try {
  await verify("api");
  await verify("analysis-worker");
} catch (error) {
  console.error(
    "Compiled runtime module verification failed. Build the workspaces first.",
  );
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
