/**
 * 启动资源：配置、数据库、工作台和进程取消信号。
 * 调用示例：import { database, shutdown } from "./runtime.js"; shutdown.abort()。
 * 仅拆分内部实现；任务与数据契约保持兼容，依赖在下方显式列出。
 */
import { randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../../packages/config/src/index.js";
import { createDatabaseClient } from "../../../packages/database/src/index.js";
import { createLogger } from "../../../packages/observability/src/index.js";
import { createAutomation } from "../../../packages/review-automation/src/index.js";
import { createWorkbench } from "../../../packages/review-workbench/src/index.js";

export const leaseDurationMs = 60_000;

export const heartbeatIntervalMs = 20_000;

export const idleDelayMs = 2_000;

export const retryDelayMs = 30_000;

/** Shared logical deadline for the main analysis call and the bounded repair.
 *  图片多模态（视觉模型）的处理耗时可超 5min；issue #102 反馈 10min 仍频繁
 *  超时，提到 15min，并可用 WebUI 设置 issue_analysis_deadline_seconds 调整。 */
export const analysisDeadlineMs = 900_000;

/**
 * 深读（读仓 + 工具循环多轮）单独预算：每轮工具循环携带已读源码的大上下文，
 * reasoning 模型单轮推理可能耗时 1-3 分钟，多轮 + 主分析在主预算内跑不完导致
 * `candidate exceeded deadline` 超时（issue #71/#73 深读现场）。给 20 分钟，
 * 可用 WebUI 设置 issue_deep_analysis_deadline_seconds 调整。
 */
export const deepAnalysisDeadlineMs = 1200_000;

export const analysisRetryPolicy = {
  maxAttemptsPerCandidate: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  // The newapi CDN gateway intermittently answers 401 under load; bounded
  // retries let a flaky response recover instead of failing the whole task.
  retryAuthentication: true,
};

export const reviewDeadlineMs = 300_000;

export const reviewRetryPolicy = analysisRetryPolicy;

export const config = loadConfig(process.env);

export const logger = createLogger(config.logLevel);

export const database = createDatabaseClient(config.databaseUrl);

// 和 API 共享显式的数据目录；默认落用户目录，升级源码不会丢掉审查基线。
export const reviewWorkbench = createWorkbench({
  dataDirectory:
    process.env.WORKBENCH_DATA_DIRECTORY ??
    join(homedir(), ".apertureprism", "workbench"),
});

export const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

export const shutdown = new AbortController();

/** 自动化只消费当前任务的审查事件；规则默认不执行外部通信。 */
export const reviewAutomation = createAutomation({
  dataDirectory:
    process.env.AUTOMATION_DATA_DIRECTORY ??
    join(homedir(), ".apertureprism", "automation"),
  workbench: reviewWorkbench,
});
