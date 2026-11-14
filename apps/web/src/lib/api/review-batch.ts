/** 手动多选审查使用持久工作台批次，启动重试始终沿用已创建的批次。 */
import {
  normalizeRepository,
  workbench,
  WorkbenchError,
  type Batch,
} from "../workbench";

export const MAX_MANUAL_REVIEW_BATCH_ITEMS = 100;
export type ManualReviewType = "issue" | "pr";

export async function createManualReviewBatch(input: {
  repository: string;
  type: ManualReviewType;
  numbers: readonly number[];
  concurrency: number;
}): Promise<Batch> {
  const repository = normalizeRepository(input.repository);
  const numbers = [...new Set(input.numbers)];
  if (
    !numbers.length ||
    numbers.length > MAX_MANUAL_REVIEW_BATCH_ITEMS ||
    numbers.some((number) => !Number.isSafeInteger(number) || number <= 0)
  )
    throw new Error(
      `请选择 1 至 ${MAX_MANUAL_REVIEW_BATCH_ITEMS} 个有效审查对象`,
    );
  if (
    !Number.isInteger(input.concurrency) ||
    input.concurrency < 1 ||
    input.concurrency > 100
  )
    throw new Error("批次并发数需为 1 至 100 的整数");
  if (input.type !== "issue" && input.type !== "pr")
    throw new Error("审查对象类型无效");
  return workbench.create("batches", repository, {
    name: `手动 ${input.type === "issue" ? "Issue" : "PR"} 批量审查 · ${new Date().toLocaleString("zh-CN")}`,
    concurrency: input.concurrency,
    note: `从已安装仓库选择 ${numbers.length} 个 ${input.type === "issue" ? "Issue" : "PR"}，审查执行时的当前版本。`,
    items: numbers.map((number) => ({
      id: `${input.type}-${number}`,
      subject: `${input.type}#${number}`,
      reference: "current",
      dependencies: [],
    })),
  });
}

/** 启动响应丢失后先读取现状；已排队的批次不再次发出 start，更不重新创建。 */
export async function startManualReviewBatch(
  repository: string,
  batchId: string,
): Promise<Batch> {
  const current = await workbench.get("batches", batchId, repository);
  if (current.status === "canceled")
    throw new WorkbenchError(
      409,
      "batch_canceled",
      "批次已取消，请到批量审查页查看",
    );
  if (current.status !== "draft") return current;
  try {
    return await workbench.action<Batch>(
      "batches",
      batchId,
      "start",
      repository,
      { expectedRevision: current.revision },
    );
  } catch (error) {
    // 并发启动或 HTTP 响应丢失都可能已成功入队，必须以服务端状态为准。
    const latest = await workbench
      .get("batches", batchId, repository)
      .catch(() => null);
    if (
      latest &&
      ["queued", "running", "paused", "completed"].includes(latest.status)
    )
      return latest;
    throw error;
  }
}
