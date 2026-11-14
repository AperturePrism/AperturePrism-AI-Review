/**
 * 模型账号、候选路由与模型列表。
 * 本文件保留原有请求路径与返回契约；认证和 GET 缓存由 http.ts 统一提供。
 * @example import { fetchModels } from './api/provider';
 */
import { authHeaders } from "../auth";
import { getJson, postSetup } from "./http";

export type ModelPolicy = {
  role: string;
  version: string;
  candidates: { provider: string; model: string; accountName: string }[];
  createdAt: string;
};

export type ProviderOverview = {
  policies: ModelPolicy[];
  accounts: ProviderAccount[];
};

export type ProviderAccount = {
  provider: string;
  name: string;
  /** 仅管理员返回；非管理员看不到环境变量配置的上游地址。 */
  baseUrl?: string;
  /** 非管理员可见的可用性标记（是否已保存凭据）。 */
  available?: boolean;
};

export type ProviderSaveResult = {
  status: string;
  provider: string;
  accountName: string;
  model: string;
  policiesUpdated: number;
};

/** Pulls an OpenAI-compatible model list for a base URL + API key. */
export async function fetchModels(
  baseUrl: string,
  apiKey: string,
  savedAccount?: { provider: string; accountName: string },
): Promise<string[]> {
  const data = (await postSetup(
    "/setup/models",
    savedAccount && !apiKey
      ? {
          baseUrl,
          provider: savedAccount.provider,
          accountName: savedAccount.accountName,
        }
      : { baseUrl, apiKey },
  )) as {
    models?: string[];
  };
  return data.models ?? [];
}

/** Saves a model provider account and wires it into every role policy. */
export async function saveProvider(input: {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  accountName?: string;
}): Promise<ProviderSaveResult> {
  return (await postSetup("/setup/provider", input)) as ProviderSaveResult;
}

/** Deletes a provider account and prunes it from every role policy (issue #58). */
export async function deleteProvider(input: {
  provider: string;
  accountName: string;
}): Promise<{ status: string }> {
  const response = await fetch("/providers/delete", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(input),
  });
  const data = (await response.json().catch(() => ({}))) as {
    status?: string;
    reason?: string;
    hint?: string;
    httpStatus?: number;
    endpoint?: string;
    detail?: string;
  };
  if (!response.ok) {
    if (!data.reason) throw new Error(`request failed with ${response.status}`);
    const parts = [data.reason];
    if (data.hint) parts.push(`— ${data.hint}`);
    if (data.httpStatus) parts.push(`（上游状态 ${data.httpStatus}）`);
    throw new Error(parts.join(" "));
  }
  return data as { status: string };
}

/** Fetches model role policies + provider account names (no secrets). */
export async function fetchProviders(): Promise<ProviderOverview> {
  return (await getJson("/providers")) as ProviderOverview;
}
