/**
 * 审查工作台：把 worker 的真实审查结果同步成发现，并计算仓库质量门禁。
 * 用法：await syncReviewToWorkbench(workbench, {repository, reference, pullNumber, review})。
 * 工作台是补充记录；主流程决定失败如何处理，本文不吞掉持久化错误。
 */
import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../../packages/database/src/client.js";
import type {
  Automation,
  ReviewEvent,
} from "../../../packages/review-automation/src/types.js";
import type { GateResult } from "../../../packages/review-workbench/src/types.js";
import type { LeasedTask } from "../../../packages/domain/src/index.js";
import { findingFingerprint } from "../../../packages/pr-review/src/baseline.js";
import type { PrReviewContract } from "../../../packages/pr-review/src/types.js";

/** 只声明调用所需的两个字段，测试不需要导入数据库或启动进程。 */
export type ReviewWorkbench = {
  execute: (
    actor: {
      userId: string;
      isAdmin: boolean;
      canAccessRepository: (repository: string, write: boolean) => boolean;
    },
    command: { action: string; input: Record<string, unknown> },
  ) => Promise<unknown>;
};

export type ReviewSyncInput = {
  repository: string;
  reference: string;
  pullNumber: number;
  review: PrReviewContract;
  workerId: string;
  deliveryKey?: string;
  resolveMissing?: boolean;
  sourceSequence?: string;
  occurredAt?: string;
};

/**
 * 复用审查基线的规则、路径、证据指纹；行号和模型措辞变化不会制造新发现。
 * source 绑定 PR，避免这次 PR 的「不再出现」误关闭另一次 PR 的发现。
 */
export async function syncReviewToWorkbench(
  workbench: ReviewWorkbench,
  input: ReviewSyncInput,
): Promise<unknown> {
  const repository = input.repository.toLowerCase();
  const source = `pr#${input.pullNumber}`;
  const findings = input.review.findings.map((finding) => ({
    ruleId: finding.rule,
    title: finding.message,
    description: `${finding.impact}\n\n建议：${finding.suggestion}\n\n证据：${finding.evidence}`,
    path: finding.file,
    line: Math.max(1, finding.afterLine),
    severity: finding.severity,
    confidence: finding.confidence,
    source,
    reference: input.reference,
    fingerprint: createHash("sha256")
      .update(JSON.stringify([repository, source, findingFingerprint(finding)]))
      .digest("hex"),
  }));
  return workbench.execute(
    {
      userId: `worker:${input.workerId}`,
      isAdmin: false,
      canAccessRepository: (candidate) =>
        candidate.toLowerCase() === repository, // 权限只覆盖当前已授权任务的仓库。
    },
    {
      action: "review.sync",
      input: {
        repository,
        source,
        reference: input.reference,
        findings,
        resolveMissing: input.resolveMissing ?? false,
        ...(input.deliveryKey ? { deliveryKey: input.deliveryKey } : {}),
        ...(input.sourceSequence
          ? { sourceSequence: input.sourceSequence }
          : {}),
      },
    },
  );
}

/**
 * 用数据库保存的任务创建顺序和尝试开始顺序排列同一 PR 的交付。
 * 保留微秒精度，不能用模型完成时间，否则慢旧版本会盖掉快新版本。
 */
export async function reviewSourceSequence(
  sql: DatabaseClient["sql"],
  task: LeasedTask,
): Promise<string> {
  const [row] = await sql<{ created: string; started: string }[]>`
    select (extract(epoch from t.created_at)*1000000)::bigint::text as created,
      (extract(epoch from a.started_at)*1000000)::bigint::text as started
    from analysis_tasks t join task_attempts a on a.task_id=t.id
    where t.id=${task.id}::uuid and t.lease_owner=${task.leaseOwner}
      and t.status='publishing' and t.lease_expires_at>now()
      and t.attempt_count=${task.attemptNumber} and a.attempt_number=t.attempt_count
      and a.worker_id=t.lease_owner and a.finished_at is null
      and (${task.attemptId ?? null}::uuid is null or a.id=${task.attemptId ?? null}::uuid)
    limit 1`;
  if (!row)
    throw new DOMException(
      "Task no longer holds the publishing lease",
      "AbortError",
    );
  return (BigInt(row.created) * 10n ** 20n + BigInt(row.started)).toString();
}

/** 真实审查事件只带计数和版本，不复制源码、原始证据或密钥。 */
export function reviewAutomationEvent(
  input: ReviewSyncInput,
  result: unknown,
): ReviewEvent | null {
  const delivery = result as {
    ignored?: boolean;
    gate?: Pick<GateResult, "decision">;
  };
  if (delivery?.ignored) return null;
  const counts = {
    total: input.review.findings.length,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const finding of input.review.findings) counts[finding.severity] += 1;
  return {
    id: `review:${input.deliveryKey ?? `${input.repository}:pr#${input.pullNumber}:${input.reference}`}`,
    type: "review.completed",
    repository: input.repository.toLowerCase(),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    subject: { kind: "pr", number: input.pullNumber },
    findings: counts,
    ...(delivery?.gate ? { gate: delivery.gate.decision } : {}),
    data: {
      reference: input.reference,
      deliveryKey: input.deliveryKey ?? "",
      sourceSequence: input.sourceSequence ?? "",
    },
  };
}

const reviewSyncTopic = "review.workbench";

/** 同一任务重试仍然写同一条 outbox，进程重启后能够继续同步。 */
export async function queueReviewWorkbenchSync(
  sql: DatabaseClient["sql"],
  taskId: string,
  input: ReviewSyncInput,
): Promise<void> {
  const digest = createHash("sha256")
    .update(`${reviewSyncTopic}:${input.deliveryKey ?? taskId}`)
    .digest("hex");
  const eventId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  const payload = {
    ...input,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  };
  await sql`insert into outbox_events (id,topic,aggregate_id,payload)
    values (${eventId}::uuid,${reviewSyncTopic},${taskId}::uuid,${JSON.stringify(payload)}::jsonb)
    on conflict (id) do nothing`;
}

export type WorkbenchReplayResult = { delivered: number; deferred: number };

/**
 * 领取一条后在事务内同步并确认，多个 worker 使用 SKIP LOCKED 分工。
 * 磁盘故障时推迟重试；数据库确认丢失时允许重送，接收端按 revision 幂等。
 */
export async function replayReviewWorkbenchSync(
  sql: DatabaseClient["sql"],
  workbench: ReviewWorkbench,
  options: {
    limit?: number;
    retryDelayMs?: number;
    signal?: AbortSignal;
    automation?: Automation;
    onError?: (error: unknown) => void;
  } = {},
): Promise<WorkbenchReplayResult> {
  const limit = options.limit ?? 10;
  const retryDelayMs = options.retryDelayMs ?? 30_000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError("Replay limit must be between 1 and 100");
  if (
    !Number.isInteger(retryDelayMs) ||
    retryDelayMs < 1 ||
    retryDelayMs > 86_400_000
  )
    throw new RangeError("Replay delay must be between 1 and 86400000 ms");
  const result: WorkbenchReplayResult = { delivered: 0, deferred: 0 };
  for (
    let attempt = 0;
    attempt < limit && !options.signal?.aborted;
    attempt += 1
  ) {
    const outcome = await sql.begin(async (transaction) => {
      const rows = await transaction<
        { id: string; payload: ReviewSyncInput }[]
      >`
        select id::text,payload from outbox_events
        where topic=${reviewSyncTopic} and published_at is null and available_at<=now()
        order by created_at,id limit 1 for update skip locked`;
      const row = rows[0];
      if (!row) return "empty" as const;
      try {
        const synced = await syncReviewToWorkbench(workbench, row.payload);
        const event = reviewAutomationEvent(row.payload, synced);
        if (options.automation && event) {
          await options.automation.execute(
            {
              userId: `worker:${row.payload.workerId}`,
              isAdmin: false,
              canAccessRepository: (repository) =>
                repository.toLowerCase() ===
                row.payload.repository.toLowerCase(),
            },
            {
              action: "events.dispatch",
              input: { repository: event.repository, event },
            },
          );
        }
      } catch (error) {
        await transaction`update outbox_events set available_at=now()+(${retryDelayMs} * interval '1 millisecond') where id=${row.id}::uuid`;
        options.onError?.(error);
        return "deferred" as const;
      }
      await transaction`update outbox_events set published_at=now() where id=${row.id}::uuid`;
      return "delivered" as const;
    });
    if (outcome === "empty") break;
    result[outcome] += 1;
  }
  return result;
}
