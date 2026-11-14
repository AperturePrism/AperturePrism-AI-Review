/**
 * 实时事件入口：GET /events；SSE 连接生命周期由 ../events.ts 统一拥有。
 * 调用示例：new EventSource('/events')。
 */
import { handleSse } from "../events.js";
import type { HttpRoute } from "../utils/routes.js";

export const routes = [
  {
    path: "/events",
    methods: ["GET"],
    handle: (request, response) => handleSse(request, response),
  },
] satisfies readonly HttpRoute[];
