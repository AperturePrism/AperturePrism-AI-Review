/**
 * 启动连接：配置、数据库、Redis 与日志。
 * 调用示例：database.db.select().from(repositories)。
 * HTTP 路径保持兼容；跨文件依赖在下方显式列出。
 */
import { loadConfig } from "../../../packages/config/src/index.js";
import {
  createDatabaseClient,
  createRedisClient,
} from "../../../packages/database/src/index.js";
import { createLogger } from "../../../packages/observability/src/index.js";

export const config = loadConfig(process.env);

export const logger = createLogger(config.logLevel);

export const database = createDatabaseClient(config.databaseUrl);

export const redis = createRedisClient(config.redisUrl);
