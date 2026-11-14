/**
 * 机器人进程入口：状态、启动与停止只允许管理员操作。
 * 调用示例：GET /bot/status；POST /bot/start。
 */
import { handleBotStatus, handleBotStart, handleBotStop } from "../botctl.js";
import type { HttpRoute } from "../utils/routes.js";

export const routes = [
  {
    path: "/bot/status",
    methods: ["GET"],
    admin: true,
    handle: (_request, response, id) => handleBotStatus(response, id),
  },
  {
    path: "/bot/start",
    methods: ["POST"],
    admin: true,
    handle: (_request, response, id) => handleBotStart(response, id),
  },
  {
    path: "/bot/stop",
    methods: ["POST"],
    admin: true,
    handle: (_request, response, id) => handleBotStop(response, id),
  },
] satisfies readonly HttpRoute[];
