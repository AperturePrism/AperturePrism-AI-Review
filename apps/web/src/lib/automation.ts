/** 自动化 HTTP 唯一边界；规则、运行、审批的字段直接取后端共享契约。 */
import { authHeaders, notifyUnauthorized } from "./auth";
import { normalizeRepository } from "./workbench";
import type {
  ActionPlan,
  AutomationSummary,
  AutomationArtifact,
  AutomationAudit,
  AutomationRule,
  AutomationRun,
  Approval,
  ConditionExplanation,
  StoredEvent,
} from "../../../../packages/review-automation/src/types";
export type * from "../../../../packages/review-automation/src/types";
export type AutomationViewer = AutomationSummary["viewer"];
export type AutomationPageContext = {
  repository: string;
  viewer: AutomationViewer;
  supportedActions: string[];
  onChanged: () => void;
};
export type AutomationPreview = {
  matched: boolean;
  explanation: ConditionExplanation;
  actions: ActionPlan[];
  writes: false;
};
export type AutomationRows = {
  rules: AutomationRule;
  runs: AutomationRun;
  approvals: Approval;
  events: StoredEvent;
  artifacts: Omit<AutomationArtifact, "content">;
  audit: AutomationAudit;
};
export type AutomationList<T> = { items: T[]; total: number };
export class AutomationRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AutomationRequestError";
  }
}
async function request<T>(
  action: string,
  repository: string,
  input: Record<string, unknown>,
  write: boolean,
  signal?: AbortSignal,
): Promise<T> {
  const scope = normalizeRepository(repository).toLowerCase();
  const query = new URLSearchParams({ action, repository: scope });
  if (!write)
    for (const [key, value] of Object.entries(input))
      if (value !== undefined) query.set(key, String(value));
  const response = await fetch(
    write ? "/api/automation" : `/api/automation?${query}`,
    {
      method: write ? "POST" : "GET",
      credentials: "same-origin",
      signal,
      headers: {
        accept: "application/json",
        ...authHeaders(),
        ...(write ? { "content-type": "application/json" } : {}),
      },
      ...(write
        ? {
            body: JSON.stringify({
              action,
              input: { ...input, repository: scope },
            }),
          }
        : {}),
    },
  );
  if (response.status === 401) notifyUnauthorized();
  let body: { status?: string; data?: T; code?: string; reason?: string };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new AutomationRequestError(
      response.status,
      `http_${response.status}`,
      `自动化接口未返回有效 JSON（${response.status}）`,
    );
  }
  if (!response.ok || body.status !== "ok")
    throw new AutomationRequestError(
      response.status,
      body.code ?? `http_${response.status}`,
      body.reason ?? `自动化请求失败（${response.status}）`,
    );
  return body.data as T;
}
export const automation = {
  summary: (repository: string, signal?: AbortSignal) =>
    request<AutomationSummary>("summary", repository, {}, false, signal),
  list: <K extends keyof AutomationRows>(
    collection: K,
    repository: string,
    input: { limit?: number; offset?: number; state?: string } = {},
    signal?: AbortSignal,
  ) =>
    request<AutomationList<AutomationRows[K]>>(
      `${collection}.list`,
      repository,
      input,
      false,
      signal,
    ),
  getRun: (repository: string, id: string, signal?: AbortSignal) =>
    request<AutomationRun>("runs.get", repository, { id }, false, signal),
  getEvent: (repository: string, id: string, signal?: AbortSignal) =>
    request<StoredEvent>("events.get", repository, { id }, false, signal),
  createRule: (repository: string, rule: Record<string, unknown>) =>
    request<AutomationRule>("rules.create", repository, rule, true),
  updateRule: (
    repository: string,
    id: string,
    version: number,
    rule: Record<string, unknown>,
  ) =>
    request<AutomationRule>(
      "rules.update",
      repository,
      { ...rule, id, version },
      true,
    ),
  toggleRule: (repository: string, id: string, enabled: boolean) =>
    request<AutomationRule>("rules.toggle", repository, { id, enabled }, true),
  deleteRule: (repository: string, id: string) =>
    request<{ deleted: boolean }>("rules.delete", repository, { id }, true),
  preview: (repository: string, input: Record<string, unknown>) =>
    request<AutomationPreview>("rules.preview", repository, input, true),
  dispatch: (repository: string, event: Record<string, unknown>) =>
    request<{
      replayed: boolean;
      eventId: string;
      runs: AutomationRun[];
      skipped: StoredEvent["skipped"];
    }>("events.dispatch", repository, { event }, true),
  runAction: (
    repository: string,
    id: string,
    action: "resume" | "retry" | "cancel",
  ) => request<AutomationRun>(`runs.${action}`, repository, { id }, true),
  decide: (repository: string, id: string, approved: boolean, note: string) =>
    request<Approval>(
      "approvals.decide",
      repository,
      { id, approved, note },
      true,
    ),
  artifact: (repository: string, id: string) =>
    request<AutomationArtifact>("artifacts.get", repository, { id }, false),
  exportRules: (repository: string) =>
    request<{ format: string; content: string }>(
      "rules.export",
      repository,
      {},
      false,
    ),
  importRules: (repository: string, content: string) =>
    request<{ imported: number; items: AutomationRule[] }>(
      "rules.import",
      repository,
      { content },
      true,
    ),
};
/** 报告以文本文件下载；不执行或直接渲染服务端报告里的 HTML。 */
export function saveAutomationFile(
  content: string,
  name: string,
  mediaType = "text/plain",
): void {
  const url = URL.createObjectURL(new Blob([content], { type: mediaType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function parseAutomationObject(
  content: string,
  label: string,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error(`${label}不是有效 JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label}必须是 JSON 对象`);
  return value as Record<string, unknown>;
}
