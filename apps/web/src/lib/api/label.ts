/**
 * 标签规则。
 * 本文件保留原有请求路径与返回契约；认证和 GET 缓存由 http.ts 统一提供。
 * @example import { fetchLabelRules } from './api/label';
 */
import { authHeaders } from "../auth";
import { getJson } from "./http";

export type LabelRuleItem = {
  key: string;
  label: string;
  enabled: boolean;
};

export type LabelRulesResult = {
  items: LabelRuleItem[];
  prefixes: string[];
};

/** Lists configured label rules (analysis field -> GitHub label). */
export async function fetchLabelRules(): Promise<LabelRulesResult> {
  return (await getJson("/label-rules")) as LabelRulesResult;
}

/** Upserts a label rule; an empty label deletes the rule. */
export async function saveLabelRule(rule: LabelRuleItem): Promise<void> {
  const response = await fetch("/label-rules", {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(rule),
  });
  if (!response.ok) throw new Error(`save label rule ${response.status}`);
}

/** Deletes a label rule by its key. */
export async function deleteLabelRule(key: string): Promise<void> {
  const response = await fetch(`/label-rules/${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!response.ok && response.status !== 404)
    throw new Error(`delete label rule ${response.status}`);
}
