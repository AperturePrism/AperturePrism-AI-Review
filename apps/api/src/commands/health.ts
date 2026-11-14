/**
 * 健康检查：存活探针不依赖数据库；就绪探针并行检查 PostgreSQL 与 Redis。
 * 调用示例：GET /health/live 或 GET /health/ready。
 */
import {
  checkDatabase,
  checkRedis,
} from "../../../../packages/database/src/index.js";
import { config, database, redis } from "../runtime.js";
import { json } from "../utils/http.js";
import type { HttpRoute } from "../utils/routes.js";

export const routes = [
  {
    path: "/health/live",
    methods: ["GET"],
    handle: (_request, response, id) => {
      json(response, 200, { status: "ok", service: "apertureprism-api" }, id);
    },
  },
  {
    path: "/health/ready",
    methods: ["GET"],
    handle: async (_request, response, id) => {
      const [databaseHealth, redisHealth] = await Promise.all([
        checkDatabase(database.sql, config.healthCheckTimeoutMs),
        checkRedis(redis, config.healthCheckTimeoutMs),
      ]);
      const ready =
        databaseHealth.status === "ok" && redisHealth.status === "ok";
      json(
        response,
        ready ? 200 : 503,
        {
          status: ready ? "ok" : "error",
          dependencies: { database: databaseHealth, redis: redisHealth },
        },
        id,
      );
    },
  },
] satisfies readonly HttpRoute[];
