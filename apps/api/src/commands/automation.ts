/**
 * 自动化 HTTP 接入：复用主 API 登录、只读角色及工作台仓库授权。
 * 调用：GET /api/automation?repository=owner/repo；POST {action,input}。
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createAutomation } from "../../../../packages/review-automation/src/index.js";
import { createAutomationHttp } from "../../../../packages/review-automation/src/http.js";
import { getWorkbench, workbenchActor } from "../workbench.js";
import type { HttpRoute } from "../utils/routes.js";

async function createHttp() {
  const dataDirectory =
    process.env.AUTOMATION_DATA_DIRECTORY ??
    join(homedir(), ".apertureprism", "automation");
  if (!isAbsolute(dataDirectory))
    throw new Error("AUTOMATION_DATA_DIRECTORY must be absolute");
  return createAutomationHttp(
    createAutomation({ dataDirectory, workbench: await getWorkbench() }),
  );
}
let http: ReturnType<typeof createHttp> | null = null;
export const routes = [
  {
    path: "/api/automation",
    prefix: true,
    methods: ["GET", "POST"],
    handle: async (request, response, requestId) => {
      http ??= createHttp().catch((error: unknown) => {
        http = null;
        throw error;
      });
      response.setHeader("x-request-id", requestId);
      await (
        await http
      )(request, response, await workbenchActor(request));
    },
  },
] satisfies readonly HttpRoute[];
