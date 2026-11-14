/**
 * 审查工作台 HTTP 边界；所有字段类型来自后端契约，不在网页复制一份。
 * @example const list = await workbench.list('findings', 'owner/repo', signal);
 */
import { authHeaders, notifyUnauthorized } from "./auth";
import type {
  ArchivePreview,
  WorkbenchTrends,
  AuditRecord,
  Baseline,
  Batch,
  Budget,
  Evaluation,
  EvaluationResult,
  Feedback,
  Finding,
  GateResult,
  Policy,
  ReportFormat,
  Suppression,
  WorkbenchCollection,
  WorkbenchSummary,
} from "../../../../packages/review-workbench/src/types";
export type * from "../../../../packages/review-workbench/src/types";

export type WorkbenchRecords = {
  policies: Policy;
  baselines: Baseline;
  findings: Finding;
  suppressions: Suppression;
  batches: Batch;
  feedback: Feedback;
  budgets: Budget;
  evaluations: Evaluation;
  audit: AuditRecord;
};
export type WorkbenchList<T> = { items: T[]; total: number };
export class WorkbenchError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkbenchError";
  }
}

/** 规范仓库名称；斜杠只分隔 owner/name，不允许将路径当作仓库传入。 */
export function normalizeRepository(value: string): string {
  const repository = value.trim();
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    repository.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new WorkbenchError(
      400,
      "invalid_repository",
      "仓库请填写 owner/name，例如 AperturePrism/AperturePrism-AI-Review",
    );
  }
  return repository;
}

function endpoint(
  path: string,
  repository: string,
  extra?: Record<string, string>,
): string {
  const query = new URLSearchParams({
    repository: normalizeRepository(repository),
    ...extra,
  });
  return `/api/workbench${path}?${query}`;
}

/** 错误信息在唯一 HTTP 边界解释，表单只显示可操作的服务端原因。 */
async function checkedFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...authHeaders(),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (response.status === 401) notifyUnauthorized();
  if (response.ok) return response;
  let code = `http_${response.status}`;
  let message = `工作台请求失败（${response.status}）`;
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string };
    };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
  } catch {
    // 反向代理可能返回 HTML；保留 HTTP 状态，不能再把解析异常盖到真正原因上。
  }
  throw new WorkbenchError(response.status, code, message);
}

async function read<T>(
  path: string,
  repository: string,
  signal?: AbortSignal,
  extra?: Record<string, string>,
): Promise<T> {
  const response = await checkedFetch(endpoint(path, repository, extra), {
    signal,
  });
  return response.json() as Promise<T>;
}

async function write<T>(
  path: string,
  repository: string,
  input: Record<string, unknown>,
): Promise<T> {
  const response = await checkedFetch(endpoint(path, repository), {
    method: "POST",
    body: JSON.stringify({
      ...input,
      repository: normalizeRepository(repository),
    }),
  });
  return response.json() as Promise<T>;
}

export const workbench = {
  trends: (repository: string, days: number, signal?: AbortSignal) =>
    read<WorkbenchTrends>("/trends", repository, signal, {
      days: String(days),
    }),
  archive: async (repository: string): Promise<Blob> => {
    const response = await checkedFetch(endpoint("/archive", repository));
    return response.blob();
  },
  previewArchive: (repository: string, archive: unknown) =>
    write<ArchivePreview>("/archive/preview", repository, { archive }),
  restoreArchive: (
    repository: string,
    archive: unknown,
    confirmChecksum: string,
  ) =>
    write<unknown>("/archive/restore", repository, {
      archive,
      confirmChecksum,
    }),
  summary: (repository: string, signal?: AbortSignal) =>
    read<WorkbenchSummary>("/summary", repository, signal),
  gate: (
    repository: string,
    signal?: AbortSignal,
    options?: {
      policyId?: string;
      baselineId?: string;
      humanApproved?: boolean;
    },
  ) =>
    read<GateResult>(
      "/gate",
      repository,
      signal,
      options
        ? {
            ...(options.policyId ? { policyId: options.policyId } : {}),
            ...(options.baselineId ? { baselineId: options.baselineId } : {}),
            ...(options.humanApproved !== undefined
              ? { humanApproved: String(options.humanApproved) }
              : {}),
          }
        : undefined,
    ),
  list: <K extends WorkbenchCollection>(
    collection: K,
    repository: string,
    signal?: AbortSignal,
    page?: { limit: number; offset: number },
  ) =>
    read<WorkbenchList<WorkbenchRecords[K]>>(
      `/${collection}`,
      repository,
      signal,
      page
        ? { limit: String(page.limit), offset: String(page.offset) }
        : undefined,
    ),
  importFindings: (repository: string, findings: Record<string, unknown>[]) =>
    write<{ items: Finding[]; imported: number }>(
      "/findings/import",
      repository,
      { findings },
    ),
  transitionFindings: (
    repository: string,
    ids: string[],
    status: string,
    reason: string,
  ) =>
    write<{ items: Finding[] }>("/findings/bulk_transition", repository, {
      ids,
      status,
      reason,
    }),
  create: <K extends Exclude<WorkbenchCollection, "audit">>(
    collection: K,
    repository: string,
    input: Record<string, unknown>,
  ) => write<WorkbenchRecords[K]>(`/${collection}`, repository, input),
  action: <T = unknown>(
    collection: WorkbenchCollection,
    id: string,
    action: string,
    repository: string,
    input: Record<string, unknown> = {},
  ) =>
    write<T>(
      `/${collection}/${encodeURIComponent(id)}/${encodeURIComponent(action)}`,
      repository,
      input,
    ),
  evaluate: (id: string, repository: string) =>
    read<EvaluationResult>(
      `/evaluations/${encodeURIComponent(id)}/result`,
      repository,
    ),
  report: async (
    repository: string,
    format: ReportFormat,
    signal?: AbortSignal,
  ): Promise<Blob> => {
    const response = await checkedFetch(
      endpoint("/reports", repository, { format }),
      { signal },
    );
    return response.blob();
  },
};

/** 下载通过认证获取的文件；短期对象 URL 用完释放，避免大报告留在内存。 */
export async function downloadReport(
  repository: string,
  format: ReportFormat,
): Promise<void> {
  const blob = await workbench.report(repository, format);
  saveBlob(
    blob,
    `${repository.replace("/", "-")}-review.${format === "markdown" ? "md" : format === "sarif" ? "sarif.json" : format}`,
  );
}

export async function downloadArchive(repository: string): Promise<void> {
  const blob = await workbench.archive(repository);
  saveBlob(blob, `${repository.replace("/", "-")}-workbench-archive.json`);
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** 导入 JSON 在浏览器边界检查形状，业务字段仍由服务端契约检查。 */
export function parseJsonArray(
  text: string,
  label: string,
): Record<string, unknown>[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label}必须是合法 JSON`);
  }
  if (
    !Array.isArray(value) ||
    value.some(
      (item) => !item || typeof item !== "object" || Array.isArray(item),
    )
  ) {
    throw new Error(`${label}必须是对象数组`);
  }
  return value as Record<string, unknown>[];
}

/** 数值表单显式排除 NaN/无穷和负数，避免 JSON.stringify 悄悄把它们变成 null。 */
export function nonnegativeNumber(
  text: string,
  label: string,
  integer = true,
): number {
  if (!text.trim()) throw new Error(`请填写${label}`);
  const value = Number(text);
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isSafeInteger(value))
  ) {
    throw new Error(`${label}必须是${integer ? "安全的非负整数" : "非负数"}`);
  }
  return value;
}

/** 美元转微美元时只接收六位以内小数，整个预算流程保持整数。 */
export function dollarsToMicros(text: string): number {
  if (!/^\d+(?:\.\d{1,6})?$/.test(text.trim()))
    throw new Error("美元金额最多保留六位小数");
  const [whole = "0", fraction = ""] = text.trim().split(".");
  const value = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));
  if (!Number.isSafeInteger(value)) throw new Error("金额超出安全整数范围");
  return value;
}

export function formatDollars(micros: number): string {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 6,
  }).format(micros / 1_000_000);
}

export function explainWorkbenchError(error: unknown): string {
  return error instanceof Error ? error.message : "工作台请求未完成，请重试";
}
