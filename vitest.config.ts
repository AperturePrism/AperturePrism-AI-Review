import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 集成文件共用一个测试库，按文件串行；文件内的锁竞争测试仍真实并发。
    fileParallelism: !process.env.APERTUREPRISM_INTEGRATION_DATABASE_URL,
    // apps/web is an independent workspace: its react deps live under
    // apps/web/node_modules and are not hoisted to the root, so the root
    // `vitest run` cannot resolve react/jsx-dev-runtime for web tests.
    // Those run from apps/web via the CI "Web UI tests" step instead.
    include: [
      "packages/**/*.{test,spec}.ts",
      "apps/api/**/*.{test,spec}.ts",
      "apps/analysis-worker/**/*.{test,spec}.ts",
      "apps/index-worker/**/*.{test,spec}.ts",
      "apps/scheduler/**/*.{test,spec}.ts",
      "apps/qq-bot/**/*.{test,spec}.ts",
    ],
  },
});
