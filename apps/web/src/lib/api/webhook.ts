/**
 * GitHub Webhook 自检。
 * 本文件保留原有请求路径与返回契约；认证和 GET 缓存由 http.ts 统一提供。
 * @example import { runWebhookSelfTest } from './api/webhook';
 */
import { authHeaders, notifyUnauthorized } from "../auth";

/** Webhook 自检结果：GitHub 侧配置 + 最近投递统计 + 中文诊断。 */
export type WebhookSelfTestResult = {
  status: string;
  webhookUrl: string;
  urlLooksRight: boolean;
  contentType: string;
  recentDeliveries: {
    event: string;
    statusCode: number | null;
    deliveredAt: string;
  }[];
  diagnosis: string;
};

/**
 * POST /webhook-selftest — 触发 App webhook 测试投递并回查结果（管理员）。
 * 路径配错 / 签名不一致 / 入口不通三类故障在这里一次闭环。
 */
export async function runWebhookSelfTest(): Promise<WebhookSelfTestResult> {
  const response = await fetch("/webhook-selftest", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
  });
  const text = await response.text();
  let parsed: Partial<WebhookSelfTestResult> & {
    reason?: string;
    detail?: string;
  } = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // keep default
  }
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error("unauthorized");
  }
  if (!response.ok) {
    throw new Error(
      parsed.detail || parsed.reason || `selftest ${response.status}`,
    );
  }
  return parsed as WebhookSelfTestResult;
}
