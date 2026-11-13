/**
 * 在线更新入口：查询状态、管理员查看历史与发起更新。
 * 调用示例：GET /update/status；POST /update/apply。
 */
import {
  handleUpdateStatus,
  handleUpdateHistory,
  handleUpdateApply,
} from "../update.js";
import { audit } from "../identity.js";
import { database } from "../runtime.js";
import type { HttpRoute } from "../utils/routes.js";

export const routes = [
  {
    path: "/update/status",
    methods: ["GET"],
    handle: (_request, response, id) => handleUpdateStatus(response, id),
  },
  {
    path: "/update/history",
    methods: ["GET"],
    admin: true,
    handle: (_request, response, id) =>
      handleUpdateHistory(response, id, database.db),
  },
  {
    path: "/update/apply",
    methods: ["POST"],
    admin: true,
    handle: (request, response, id) =>
      handleUpdateApply(request, response, id, true, database.db, (detail) =>
        audit(request, "update.apply", undefined, detail),
      ),
  },
] satisfies readonly HttpRoute[];
