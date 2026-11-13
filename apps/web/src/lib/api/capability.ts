/**
 * 专家团队与 Agent 能力。
 * 本文件保留原有请求路径与返回契约；认证和 GET 缓存由 http.ts 统一提供。
 * @example import { fetchCapabilities } from './api/capability';
 */
import { authHeaders, notifyUnauthorized } from "../auth";
import { getJson } from "./http";

export type CapabilitySkill = {
  id: string;
  name: string;
  appliesTo: "issue" | "pr";
  description: string;
};

export type CapabilityExpert = {
  id: string;
  name: string;
  appliesTo: "issue" | "pr";
};

export type Capabilities = {
  skills: CapabilitySkill[];
  experts: CapabilityExpert[];
  enabled: boolean;
};

/** Agent capabilities catalog: skills + expert team + enablement flag. */
export async function fetchCapabilities(): Promise<Capabilities> {
  return (await getJson("/capabilities")) as Capabilities;
}

/** Toggles the expert-team pipeline (admin only). */
export async function setExpertTeamEnabled(enabled: boolean): Promise<void> {
  const response = await fetch("/capabilities", {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ enabled }),
  });
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (response.status === 403) throw new Error("需要管理员权限（403）");
  if (!response.ok) throw new Error(`capabilities ${response.status}`);
}
