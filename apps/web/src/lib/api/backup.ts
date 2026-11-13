/**
 * 配置备份导出与导入。
 * 本文件保留原有请求路径与返回契约；认证和 GET 缓存由 http.ts 统一提供。
 * @example import { fetchBackup } from './api/backup';
 */
import { authHeaders } from "../auth";
import { getJson } from "./http";

export type BackupSetting = {
  key: string;
  value: string | null;
  hasValue: boolean;
};

export type BackupPolicy = {
  role: string;
  version: string;
  candidates: unknown;
};

export type BackupSnapshot = {
  version: string;
  exportedAt: string;
  settings: BackupSetting[];
  policies: BackupPolicy[];
  providers: string[];
};

/** Exports runtime configuration (settings masked, policies, provider names). */
export async function fetchBackup(): Promise<BackupSnapshot> {
  return (await getJson("/backup")) as BackupSnapshot;
}

export type BackupImportResult = {
  status: string;
  settings: number;
  policies: number;
  skippedSecrets: string[];
  skippedProviders: string[];
};

/** Restores non-secret settings + model role policies from a snapshot. */
export async function importBackup(
  snapshot: unknown,
): Promise<BackupImportResult> {
  const response = await fetch("/backup/import", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(snapshot),
  });
  const text = await response.text();
  if (!response.ok) {
    let reason = `import backup ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { reason?: string };
      if (parsed.reason) reason = parsed.reason;
    } catch {
      // keep default
    }
    throw new Error(reason);
  }
  return JSON.parse(text) as BackupImportResult;
}
