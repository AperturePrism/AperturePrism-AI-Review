/**
 * Agent 能力：专家组与技能开关。
 * 调用示例：handleCapabilities(request, response, requestId)。
 * HTTP 路径保持兼容；跨文件依赖在下方显式列出。
 */
import { parseJsonObject } from "../utils/http.js";
import type { HttpRoute } from "../utils/routes.js";
import {
  BUILTIN_SKILLS,
  EXPERT_TEAM,
} from "../../../../packages/agent-capabilities/src/index.js";
import {
  parseBool,
  BOOLEAN_DEFAULTS,
} from "../../../../packages/config/src/index.js";
import {
  loadSettings,
  systemSettings,
} from "../../../../packages/database/src/index.js";
import { isAdminRequest, audit } from "../identity.js";
import { database, logger } from "../runtime.js";
import { json, readBody } from "../utils/http.js";
import { type IncomingMessage, type ServerResponse } from "node:http";

/** Reads the current expert-team enablement flag from `system_settings`. */
async function agentTeamEnabled(): Promise<boolean> {
  try {
    const settings = await loadSettings(database.db, ["agent_team_enabled"]);
    return parseBool(
      settings.get("agent_team_enabled"),
      BOOLEAN_DEFAULTS.agent_team_enabled ?? false,
    );
  } catch (error) {
    // 之前这里没有 catch：数据库抖一下就让整个 /capabilities 返回 500，
    // 而这只是一个开关，读不到时按「未启用」处理即可。
    logger.warn({ err: error }, "agent team flag read failed; treating as off");
    return false;
  }
}

/**
 * Agent capabilities catalog: built-in skills + expert team registry, plus the
 * global expert-team enablement switch. GET is available to any authenticated
 * user; PUT (toggle) requires admin and writes a runtime setting.
 */
export async function handleCapabilities(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  if (request.method === "PUT") {
    if (!(await isAdminRequest(request))) {
      json(
        response,
        403,
        { status: "error", reason: "admin required" },
        requestId,
      );
      return;
    }
    const body = await readBody(request);
    let parsed: { enabled?: unknown };
    try {
      parsed = parseJsonObject(body);
    } catch {
      json(
        response,
        400,
        { status: "error", reason: "invalid JSON" },
        requestId,
      );
      return;
    }
    const enabled = parsed.enabled === true;
    const value = enabled ? "true" : "false";
    await database.db
      .insert(systemSettings)
      .values({ key: "agent_team_enabled", value })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value, updatedAt: new Date() },
      });
    audit(request, "capabilities.toggle", undefined, { enabled });
    json(response, 200, { status: "ok", enabled }, requestId);
    return;
  }

  if (request.method !== "GET") {
    json(
      response,
      405,
      { status: "error", reason: "method not allowed" },
      requestId,
    );
    return;
  }

  json(
    response,
    200,
    {
      skills: BUILTIN_SKILLS.map((skill) => ({
        id: skill.id,
        name: skill.name,
        appliesTo: skill.appliesTo,
        description: skill.description,
      })),
      experts: EXPERT_TEAM.map((expert) => ({
        id: expert.id,
        name: expert.name,
        appliesTo: expert.appliesTo,
      })),
      enabled: await agentTeamEnabled(),
    },
    requestId,
  );
}

// HTTP 入口与业务放在同一处：新增同类入口只修改本文件。
export const routes = [
  { path: "/capabilities", handle: handleCapabilities },
] satisfies readonly HttpRoute[];
