#!/usr/bin/env node
/**
 * 在显式指定的测试 PostgreSQL 上应用迁移，再运行真实数据库集成测试。
 * 用法：APERTUREPRISM_INTEGRATION_DATABASE_URL=postgres://.../review_test npm run test:integration
 * 该库必须是可清空的测试实例；脚本不读取生产 DATABASE_URL 作为替代。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDatabase = process.env.APERTUREPRISM_INTEGRATION_DATABASE_URL;
if (!testDatabase) {
  console.error(
    "Set APERTUREPRISM_INTEGRATION_DATABASE_URL to a disposable PostgreSQL database with pgvector installed.",
  );
  process.exitCode = 1;
} else {
  const environment = { ...process.env, DATABASE_URL: testDatabase };
  const run = (program, args) =>
    new Promise((accept, reject) => {
      const child = spawn(program, args, {
        cwd: root,
        env: environment,
        stdio: "inherit",
        shell: process.platform === "win32",
      });
      child.on("error", reject);
      child.on("close", (code, signal) =>
        code === 0
          ? accept()
          : reject(
              new Error(
                `Integration command failed (${signal ?? code}): ${program}`,
              ),
            ),
      );
    });
  try {
    await run(process.platform === "win32" ? "npm.cmd" : "npm", [
      "run",
      "build",
    ]);
    await run(process.execPath, ["scripts/migrate.mjs"]);
    await run(process.execPath, ["node_modules/vitest/vitest.mjs", "run"]);
  } catch (error) {
    console.error(error.message); // 不打印包含数据库口令的命令或环境变量。
    process.exitCode = 1;
  }
}
