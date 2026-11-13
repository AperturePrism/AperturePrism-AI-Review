/**
 * 审查工作台唯一调用入口。先做一次仓库授权，再以只读快照或原子事务执行业务。
 * @example
 * const workbench = createWorkbench({dataDirectory:'/var/lib/apertureprism/workbench'});
 * await workbench.execute(actor, {action:'findings.list', input:{repository:'owner/repo'}});
 */
import { Records } from "./records.js";
import { syncReview } from "./review.js";
import { verifyAudit, listAudit, type CommandContext } from "./audit.js";
import {
  activatePolicyVersion,
  comparePolicyVersions,
  createPolicy,
  policyTemplates,
  savePolicyVersion,
  togglePolicy,
} from "./policy.js";
import {
  activateBaseline,
  archiveBaseline,
  compareBaseline,
  createBaseline,
} from "./baseline.js";
import {
  assignFinding,
  bulkTransitionFindings,
  createFinding,
  importFindings,
  listFindings,
  transitionFinding,
} from "./finding.js";
import {
  createSuppression,
  previewSuppression,
  renewSuppression,
  toggleSuppression,
} from "./suppression.js";
import {
  changeBatchState,
  claimBatchItem,
  completeBatchItem,
  createBatch,
  heartbeatBatchItem,
  linkBatchItem,
  previewBatch,
  retryBatchItems,
} from "./batch.js";
import {
  createFeedback,
  feedbackSummary,
  resolveFeedback,
} from "./feedback.js";
import {
  budgetAvailability,
  createBudget,
  expireReservations,
  releaseBudget,
  reserveBudget,
  settleBudget,
  toggleBudget,
  updateBudgetLimits,
} from "./budget.js";
import {
  compareEvaluations,
  createEvaluation,
  evaluationResult,
} from "./evaluation.js";
import { evaluateGate } from "./gate.js";
import { renderReport, reportFormats } from "./report.js";
import { summarizeWorkbench } from "./summary.js";
import { workbenchTrends } from "./trends.js";
import { exportArchive, previewArchive, restoreArchive } from "./archive.js";
import {
  findRecord,
  integer,
  object,
  optionalText,
  repositoryName,
  text,
  WorkbenchError,
} from "./utils/input.js";
import type {
  Actor,
  Workbench,
  WorkbenchCollection,
  WorkbenchCommand,
  WorkbenchOptions,
  WorkbenchSnapshot,
} from "./types.js";
import { WORKBENCH_COLLECTIONS } from "./types.js";

export * from "./types.js";
export { WorkbenchError } from "./utils/input.js";
export { findingFingerprint } from "./finding.js";
export { estimateCostMicros } from "./budget.js";

const collections = WORKBENCH_COLLECTIONS;
const readActions = new Set([
  "summary",
  "gate.evaluate",
  "reports.render",
  "reports.formats",
  "policies.templates",
  "policies.compare",
  "baselines.compare",
  "suppressions.preview",
  "batches.preview",
  "feedback.summary",
  "budgets.availability",
  "evaluations.result",
  "evaluations.compare",
  "audit.verify",
  "trends",
  "archive.export",
  "archive.preview",
  ...collections.flatMap((collection) => [
    `${collection}.list`,
    `${collection}.get`,
  ]),
]);

function listCollection(
  context: CommandContext,
  collection: WorkbenchCollection,
  input: Record<string, unknown>,
): unknown {
  if (collection === "findings") return listFindings(context, input);
  if (collection === "audit") return listAudit(context, input);
  const limit = integer(input.limit, "limit", 1, 1000, 100);
  const offset = integer(input.offset, "offset", 0, 1_000_000, 0);
  const query = optionalText(input.query, "query", 300).toLowerCase();
  const rows = context.data[collection]
    .filter((record) => record.repository === context.repository)
    .filter(
      (record) =>
        !query || JSON.stringify(record).toLowerCase().includes(query),
    )
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id),
    );
  return { items: rows.slice(offset, offset + limit), total: rows.length };
}

function getCollection(
  context: CommandContext,
  collection: WorkbenchCollection,
  input: Record<string, unknown>,
): unknown {
  return findRecord(
    context.data[collection] as { id: string; repository: string }[],
    context.repository,
    input.id,
  );
}

function executeMutation(
  context: CommandContext,
  action: string,
  input: Record<string, unknown>,
): unknown {
  switch (action) {
    case "policies.create":
      return createPolicy(context, input);
    case "policies.version":
      return savePolicyVersion(context, input);
    case "policies.activate":
      return activatePolicyVersion(context, input);
    case "policies.toggle":
      return togglePolicy(context, input);
    case "baselines.create":
      return createBaseline(context, input);
    case "baselines.activate":
      return activateBaseline(context, input);
    case "baselines.archive":
      return archiveBaseline(context, input);
    case "findings.create":
      return createFinding(context, input);
    case "findings.import":
      return importFindings(context, input);
    case "findings.transition":
      return transitionFinding(context, input);
    case "findings.bulk_transition":
      return bulkTransitionFindings(context, input);
    case "findings.assign":
      return assignFinding(context, input);
    case "suppressions.create":
      return createSuppression(context, input);
    case "suppressions.toggle":
      return toggleSuppression(context, input);
    case "suppressions.renew":
      return renewSuppression(context, input);
    case "batches.create":
      return createBatch(context, input);
    case "batches.start":
      return changeBatchState(context, input, "start");
    case "batches.pause":
      return changeBatchState(context, input, "pause");
    case "batches.resume":
      return changeBatchState(context, input, "resume");
    case "batches.cancel":
      return changeBatchState(context, input, "cancel");
    case "batches.retry":
      return retryBatchItems(context, input);
    case "batches.claim":
      return claimBatchItem(context, input);
    case "batches.heartbeat":
      return heartbeatBatchItem(context, input);
    case "batches.link":
      return linkBatchItem(context, input);
    case "batches.complete":
      return completeBatchItem(context, input);
    case "feedback.create":
      return createFeedback(context, input);
    case "feedback.resolve":
      return resolveFeedback(context, input);
    case "budgets.create":
      return createBudget(context, input);
    case "budgets.toggle":
      return toggleBudget(context, input);
    case "budgets.limits":
      return updateBudgetLimits(context, input);
    case "budgets.reserve":
      return reserveBudget(context, input);
    case "budgets.settle":
      return settleBudget(context, input);
    case "budgets.release":
      return releaseBudget(context, input);
    case "budgets.expire":
      return expireReservations(context);
    case "evaluations.create":
      return createEvaluation(context, input);
    case "review.sync":
      return syncReview(context, input);
    case "archive.restore":
      return restoreArchive(context, input);
    default:
      throw new WorkbenchError(
        "unknown_action",
        `工作台操作 ${action} 不存在`,
        404,
      );
  }
}

async function executeRead(
  context: CommandContext,
  action: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  for (const collection of collections) {
    if (action === `${collection}.list`)
      return listCollection(context, collection, input);
    if (action === `${collection}.get`)
      return getCollection(context, collection, input);
  }
  switch (action) {
    case "summary":
      return summarizeWorkbench(context);
    case "trends":
      return workbenchTrends(context, input);
    case "archive.export":
      return exportArchive(context);
    case "archive.preview":
      return previewArchive(context, input);
    case "gate.evaluate":
      return evaluateGate(context, input);
    case "reports.render":
      return renderReport(context, input);
    case "reports.formats":
      return { formats: await reportFormats() };
    case "policies.templates":
      return { items: policyTemplates() };
    case "policies.compare":
      return comparePolicyVersions(context, input);
    case "baselines.compare":
      return compareBaseline(context, input);
    case "suppressions.preview":
      return previewSuppression(context, input);
    case "batches.preview":
      return previewBatch(context, input);
    case "feedback.summary":
      return feedbackSummary(context, input);
    case "budgets.availability":
      return budgetAvailability(context, input);
    case "evaluations.result":
      return evaluationResult(context, input);
    case "evaluations.compare":
      return compareEvaluations(context, input);
    case "audit.verify":
      return verifyAudit(context);
    default:
      throw new WorkbenchError(
        "unknown_action",
        `工作台操作 ${action} 不存在`,
        404,
      );
  }
}

/**
 * 工厂只检查配置和路径；首次成功写入时才建数据目录。
 * canAccessRepository 来自宿主现有权限，不能从 HTTP 请求里传入。
 */
export function createWorkbench(options: WorkbenchOptions): Workbench {
  const records = new Records(options);
  const now = options.now ?? (() => new Date());
  return {
    async execute(actor: Actor, command: WorkbenchCommand): Promise<unknown> {
      const userId = text(actor.userId, "userId", 200); // 身份只来自宿主会话，不读取正文里的actor。
      const action = text(command.action, "action", 100); // 一个明确动作对应一个业务方法。
      const input = object(command.input); // 外部输入在唯一入口整理为JSON对象。
      const repository = repositoryName(input.repository); // 规范大小写后再走仓库授权。
      const write = !readActions.has(action); // 新增动作默认需要写权限，避免漏分权限。
      if (
        !actor.isAdmin &&
        !(await actor.canAccessRepository(repository, write))
      ) {
        throw new WorkbenchError("not_found", "仓库不存在或无权访问", 404);
      }
      const current = now(); // 整次调用共享时钟，租约与抑制不会跨临界点得出矛盾结果。
      if (!Number.isFinite(current.getTime()))
        throw new WorkbenchError("invalid_clock", "工作台时钟无效", 500);
      const build = (data: WorkbenchSnapshot): CommandContext => ({
        data,
        repository,
        actor: { ...actor, userId },
        now: current.toISOString(),
      });
      if (!write)
        return structuredClone(
          await executeRead(build(await records.read()), action, input),
        );
      return records.change((data) =>
        executeMutation(build(data), action, input),
      );
    },
  };
}
