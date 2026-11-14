/**
 * 管理员操作审计。
 * 本文件保留原有请求路径与返回契约；认证和 GET 缓存由 http.ts 统一提供。
 * @example import { fetchAuditLog } from './api/audit';
 */
import { getJson } from "./http";

export type AuditEntry = {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  detail: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
};

/** Lists the security audit trail, newest first (admin only). */
export async function fetchAuditLog(
  offset = 0,
  limit = 50,
): Promise<AuditEntry[]> {
  const result = (await getJson(`/audit?offset=${offset}&limit=${limit}`)) as {
    items: AuditEntry[];
  };
  return result.items;
}
