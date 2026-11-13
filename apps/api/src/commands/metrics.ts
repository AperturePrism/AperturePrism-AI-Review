/**
 * 运行指标：队列统计、Prometheus 指标和告警发送。
 * 调用示例：handleSummary(request, response, requestId)。
 * HTTP 路径保持兼容；跨文件依赖在下方显式列出。
 */
import { count, inArray, and, eq } from "drizzle-orm";
import {
  analysisTasks,
  subjectResults,
} from "../../../../packages/database/src/index.js";
import { visibleRepoScope } from "../identity.js";
import type { HttpRoute } from "../utils/routes.js";
import { metrics } from "../../../../packages/observability/src/index.js";
import {
  type AlertRuleId,
  type AlertRecord,
  type AlertTransition,
  evaluateAlerts,
  diffAlertTransitions,
} from "../alerts.js";
import { alertWebhookUrl, alertThresholds } from "../preferences.js";
import { database, logger } from "../runtime.js";
import { json } from "../utils/http.js";
import { type ServerResponse, type IncomingMessage } from "node:http";

/** Aggregated counts for the WebUI overview KPIs (status/type/result totals). */
export async function handleSummary(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const scope = await visibleRepoScope(request);
  const taskScope =
    scope && scope.ids !== null
      ? inArray(analysisTasks.repositoryId, [...scope.ids])
      : undefined;
  const resultScope =
    scope && scope.fullNames !== null
      ? inArray(subjectResults.repositoryFullName, [...scope.fullNames])
      : undefined;
  const [byStatus, byType, resultCounts] = await Promise.all([
    database.db
      .select({ status: analysisTasks.status, count: count() })
      .from(analysisTasks)
      .where(taskScope)
      .groupBy(analysisTasks.status),
    database.db
      .select({ task_type: analysisTasks.taskType, count: count() })
      .from(analysisTasks)
      .where(taskScope)
      .groupBy(analysisTasks.taskType),
    database.db
      .select({ subject_type: subjectResults.subjectType, count: count() })
      .from(subjectResults)
      .where(and(eq(subjectResults.published, true), resultScope))
      .groupBy(subjectResults.subjectType),
  ]);
  const total = byStatus.reduce((sum, row) => sum + Number(row.count), 0);
  json(
    response,
    200,
    {
      tasks: {
        total,
        byStatus: Object.fromEntries(
          byStatus.map((row) => [row.status, Number(row.count)]),
        ),
        byType: Object.fromEntries(
          byType.map((row) => [row.task_type, Number(row.count)]),
        ),
      },
      results: {
        issue: Number(
          resultCounts.find((row) => row.subject_type === "issue")?.count ?? 0,
        ),
        pr: Number(
          resultCounts.find((row) => row.subject_type === "pr")?.count ?? 0,
        ),
      },
    },
    requestId,
  );
}

/**
 * 任务可靠性量规（供 /metrics 与告警评估共用）：队列积压、在途、失败、滞留。
 */
async function collectTaskReliabilityGauges(): Promise<{
  queueDepth: number;
  inflight: number;
  failed: number;
  stale: number;
}> {
  const [queue, inflight, failed, stale] = await Promise.all([
    database.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM analysis_tasks WHERE status IN ('queued', 'retry_wait')`,
    database.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM analysis_tasks WHERE status IN ('leased', 'running', 'publishing')`,
    database.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM analysis_tasks WHERE status = 'failed'`,
    // 滞留任务：声称在跑但心跳超过 10 分钟未更新（疑似 worker 已死但租约未释放）。
    database.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM analysis_tasks
      WHERE status IN ('leased', 'running', 'publishing')
        AND (heartbeat_at IS NULL OR heartbeat_at < now() - interval '10 minutes')`,
  ]);
  return {
    queueDepth: queue[0]?.c ?? 0,
    inflight: inflight[0]?.c ?? 0,
    failed: failed[0]?.c ?? 0,
    stale: stale[0]?.c ?? 0,
  };
}

/** 进程内告警状态（规则 → 最新记录）。 */
const alertRecords = new Map<AlertRuleId, AlertRecord>();

/**
 * 将告警状态迁移事件 POST 到配置的 webhook（如飞书/钉钉/自定义端点）。
 * 仅在配置了 alert_webhook_url 时发送；失败仅记日志，不影响告警主流程。
 * 每次迁移只发一条（triggered/resolved），持续状态不重复。
 */
async function notifyAlertTransitions(
  transitions: readonly AlertTransition[],
): Promise<void> {
  if (transitions.length === 0) return;
  const url = alertWebhookUrl();
  if (!url) return;
  const payload = {
    type: "alert",
    sentAt: new Date().toISOString(),
    events: transitions.map((t) => ({
      kind: t.kind,
      rule: t.record.id,
      severity: t.record.severity,
      message: t.record.message,
      value: t.record.value,
      firstAt: t.record.firstAt,
      lastAt: t.record.lastAt,
      status: t.record.status,
    })),
  };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      logger.warn(
        { url, status: response.status },
        "alert webhook non-2xx response",
      );
    }
  } catch (error) {
    logger.warn({ err: error, url }, "alert webhook send failed");
  }
}

/** 评估一次告警（由定时器与 /alerts 请求共同触发），并在状态迁移时推送 webhook。 */
export async function refreshAlerts(): Promise<void> {
  try {
    const prev = new Map(alertRecords);
    const { queueDepth, failed, stale } = await collectTaskReliabilityGauges();
    const next = evaluateAlerts(
      alertRecords,
      {
        queueDepth,
        failed,
        stale,
      },
      new Date(),
      alertThresholds(),
    );
    const transitions = diffAlertTransitions(prev, next);
    alertRecords.clear();
    for (const record of next) alertRecords.set(record.id, record);
    if (transitions.length > 0) {
      // 不 await：通知失败不阻塞告警刷新。
      void notifyAlertTransitions(transitions);
    }
  } catch (error) {
    logger.warn({ err: error }, "alert evaluation failed");
  }
}

/**
 * GET /metrics — 进程内指标快照 + 库内实时量规（队列深度 / 在途任务 / 仓库数）。
 * 管理员可见；给「运维」页与未来 Prometheus 抓取共用同一份快照。
 */
export async function handleMetrics(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const snapshot = metrics.snapshot();
  try {
    const { queueDepth, inflight, failed, stale } =
      await collectTaskReliabilityGauges();
    const repos = await database.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM repositories`;
    snapshot.gauges["queue.depth"] = queueDepth;
    snapshot.gauges["tasks.inflight"] = inflight;
    snapshot.gauges["repositories.count"] = repos[0]?.c ?? 0;
    snapshot.gauges["tasks.failed"] = failed;
    snapshot.gauges["tasks.stale"] = stale;
  } catch (error) {
    logger.warn({ err: error }, "metrics live gauges failed");
  }
  json(response, 200, snapshot, requestId);
}

/**
 * GET /alerts — 当前告警状态（active 在前，resolved 历史在后）。管理员可见。
 */
export async function handleAlerts(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  await refreshAlerts();
  json(response, 200, { items: [...alertRecords.values()] }, requestId);
}

// HTTP 入口与业务放在同一处：新增同类入口只修改本文件。
export const routes = [
  {
    path: "/summary",
    methods: ["GET"],
    handle: handleSummary,
  },
  {
    path: "/metrics",
    methods: ["GET"],
    admin: true,
    handle: (_request, response, id) => handleMetrics(response, id),
  },
  {
    path: "/alerts",
    methods: ["GET"],
    admin: true,
    handle: (_request, response, id) => handleAlerts(response, id),
  },
] satisfies readonly HttpRoute[];
