/**
 * 审查工作台 HTTP 入口：受主 API 统一登录和只读权限约束。
 * 调用：GET /api/workbench/summary；主体接口和仓库授权由工作台协议定义。
 */
import { handleWorkbench } from "../workbench.js";
import { json } from "../utils/http.js";
import type { HttpRoute } from "../utils/routes.js";

export const routes = [
  {
    path: "/api/workbench",
    prefix: true,
    handle: async (request, response, id) => {
      if (!(await handleWorkbench(request, response, id)))
        json(response, 404, { status: "error", reason: "not found" }, id);
    },
  },
] satisfies readonly HttpRoute[];
