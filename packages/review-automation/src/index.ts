/**
 * 自动化唯一调用入口：先检查仓库权限，再读取或原子修改规则与执行记录。
 * @example
 * const automation = createAutomation({dataDirectory:'/var/lib/apertureprism/automation',workbench});
 * await automation.execute(actor,{action:'events.dispatch',input:{repository:'owner/repo',event}});
 */
import { createHash, randomUUID } from "node:crypto";
import { AutomationRecords, writeAutomationAudit } from "./records.js";
import { explainRule, parseRule, resolveActionInput } from "./rule.js";
import { findRun, resumeRun } from "./run.js";
import type {
  Automation,
  AutomationActor,
  AutomationOptions,
  AutomationRule,
  AutomationRun,
  AutomationSnapshot,
  ConditionExplanation,
  StoredEvent,
} from "./types.js";
import {
  AutomationError,
  bool,
  canonical,
  integer,
  jsonValue,
  object,
  repositoryName,
  reviewEvent,
  text,
} from "./utils/input.js";

export * from "./types.js";
export { AutomationError } from "./utils/input.js";
export {
  parseCondition,
  evaluateCondition,
  evaluateWindow,
  matchGlob,
} from "./condition.js";

const READS = new Set([
  "summary",
  "rules.list",
  "rules.get",
  "rules.preview",
  "rules.export",
  "runs.list",
  "runs.get",
  "approvals.list",
  "artifacts.list",
  "artifacts.get",
  "audit.list",
  "events.list",
  "events.get",
]);
/** HTTP 和宿主从同一份业务动作表判断只读能力。 */
export function isAutomationReadAction(action: string): boolean {
  return READS.has(action);
}

const RESERVED_ACTIONS = new Set([
  "audit.record",
  "approval.request",
  "report.create",
  "finding.transition",
]);

function selectRule(
  data: AutomationSnapshot,
  repository: string,
  id: unknown,
): AutomationRule {
  const ruleId = text(id, "id");
  const rule = data.rules.find(
    (candidate) =>
      candidate.repository === repository && candidate.id === ruleId,
  );
  if (!rule)
    throw new AutomationError("not_found", "automation rule not found", 404);
  return rule;
}
function publicRows<T extends { repository: string }>(
  rows: readonly T[],
  repository: string,
  input: Record<string, unknown>,
): { items: readonly T[]; total: number } {
  const own = rows.filter((row) => row.repository === repository);
  const limit = integer(input.limit, "limit", 1, 1000, 100);
  const offset = integer(input.offset, "offset", 0, 1_000_000, 0);
  return { items: own.slice(offset, offset + limit), total: own.length };
}
function createRun(
  rule: AutomationRule,
  event: StoredEvent,
  explanation: ConditionExplanation,
  actor: string,
  now: string,
): AutomationRun {
  const id = randomUUID();
  return {
    id,
    repository: rule.repository,
    ruleId: rule.id,
    ruleVersion: rule.version,
    ruleName: rule.name,
    eventId: event.id,
    event: event.event,
    state: "queued",
    explanation,
    steps: rule.actions.map((action, index) => ({
      id: randomUUID(),
      kind: action.kind,
      input: resolveActionInput(action.input, event.event),
      costUnits: action.costUnits,
      maxAttempts: action.maxAttempts,
      attempts: 0,
      state: "pending",
      idempotencyKey: `automation:${id}:${index}`,
      startedAt: null,
      completedAt: null,
      error: null,
      output: null,
    })),
    budget: { ...rule.budget },
    costUsed: 0,
    durationMs: 0,
    nextAttemptAt: null,
    leaseOwner: null,
    leaseUntil: null,
    createdAt: now,
    updatedAt: now,
    createdBy: actor,
  };
}

/** 规则匹配与事件键占用在一个事务内完成，多实例同时收到交付也只创建一份运行。 */
function dispatchEvent(
  data: AutomationSnapshot,
  repository: string,
  input: Record<string, unknown>,
  actor: string,
  now: string,
): { event: StoredEvent; replayed: boolean } {
  const event = reviewEvent(input.event, repository);
  const hash = createHash("sha256")
    .update(canonical(jsonValue(event)))
    .digest("hex");
  const previous = data.events.find(
    (record) => record.repository === repository && record.id === event.id,
  );
  if (previous) {
    if (previous.hash !== hash)
      throw new AutomationError(
        "idempotency_conflict",
        "event id was already used for different content",
        409,
      );
    return { event: previous, replayed: true };
  }
  const record: StoredEvent = {
    repository,
    id: event.id,
    hash,
    event,
    runIds: [],
    skipped: [],
    receivedAt: now,
  };
  for (const rule of data.rules.filter(
    (candidate) => candidate.repository === repository,
  )) {
    const explanation = explainRule(rule, event, new Date(now));
    let reason = explanation.passed ? "" : "condition_or_window";
    if (
      (event.trace?.depth ?? 0) >= 8 ||
      event.trace?.ruleIds.includes(rule.id)
    )
      reason = "loop_prevented";
    const recent = data.runs.filter(
      (run) =>
        run.repository === repository &&
        run.ruleId === rule.id &&
        new Date(run.createdAt).getTime() >
          new Date(now).getTime() - rule.rate.windowSeconds * 1000,
    ).length;
    if (!reason && recent >= rule.rate.limit) reason = "rule_rate_limited";
    if (!reason && record.runIds.length >= 20) reason = "event_run_budget";
    if (reason) {
      record.skipped.push({ ruleId: rule.id, reason, explanation });
      continue;
    }
    try {
      const run = createRun(rule, record, explanation, actor, now);
      data.runs.push(run);
      record.runIds.push(run.id);
    } catch (error) {
      if (!(error instanceof AutomationError)) throw error;
      record.skipped.push({ ruleId: rule.id, reason: error.code, explanation });
    }
  }
  data.events.push(record);
  writeAutomationAudit(
    data,
    repository,
    actor,
    "event.dispatched",
    event.id,
    { runs: record.runIds.length, skipped: record.skipped.length },
    now,
  );
  return { event: record, replayed: false };
}

/** 创建规则工厂不会碰磁盘；没有授权的请求不会读取任何仓库记录。 */
export function createAutomation(options: AutomationOptions): Automation {
  const records = new AutomationRecords(options);
  const clock = options.now ?? (() => new Date());
  const supported = new Set([
    "audit.record",
    "approval.request",
    ...(options.workbench ? ["report.create", "finding.transition"] : []),
    ...Object.keys(options.actions ?? {}),
  ]);
  for (const action of Object.keys(options.actions ?? {})) {
    if (RESERVED_ACTIONS.has(action) || !/^[a-z][a-z0-9._]{0,79}$/.test(action))
      throw new AutomationError(
        "invalid_action",
        `custom action ${action} conflicts with a built-in or has an invalid name`,
      );
  }
  return {
    async execute(actor: AutomationActor, command): Promise<unknown> {
      const userId = text(actor.userId, "userId");
      const action = text(command.action, "action", 100);
      const input = object(command.input);
      const repository = repositoryName(input.repository);
      if (!READS.has(action) && actor.isReadOnly)
        throw new AutomationError(
          "read_only",
          "read-only actors cannot change automation",
          403,
        );
      if (
        !actor.isAdmin &&
        !(await actor.canAccessRepository(repository, !READS.has(action)))
      )
        throw new AutomationError(
          "not_found",
          "repository not found or access denied",
          404,
        );
      const current = clock();
      if (!Number.isFinite(current.getTime()))
        throw new AutomationError(
          "invalid_clock",
          "automation clock is invalid",
          500,
        );
      const now = current.toISOString();
      const trustedActor = { ...actor, userId };

      if (READS.has(action)) {
        const data = await records.read();
        switch (action) {
          case "summary": {
            const runs = data.runs.filter(
              (run) => run.repository === repository,
            );
            return {
              rules: data.rules.filter((rule) => rule.repository === repository)
                .length,
              enabledRules: data.rules.filter(
                (rule) => rule.repository === repository && rule.enabled,
              ).length,
              runs: runs.length,
              byState: Object.fromEntries(
                [...new Set(runs.map((run) => run.state))].map((state) => [
                  state,
                  runs.filter((run) => run.state === state).length,
                ]),
              ),
              pendingApprovals: data.approvals.filter(
                (approval) =>
                  approval.repository === repository &&
                  approval.state === "pending",
              ).length,
              supportedActions: [...supported],
              viewer: {
                userId,
                isAdmin: actor.isAdmin,
                canWrite:
                  !actor.isReadOnly &&
                  (actor.isAdmin ||
                    (await actor.canAccessRepository(repository, true))),
              },
            };
          }
          case "events.list":
            return publicRows([...data.events].reverse(), repository, input);
          case "events.get": {
            const record = data.events.find(
              (entry) =>
                entry.repository === repository &&
                entry.id === text(input.id, "id", 300),
            );
            if (!record)
              throw new AutomationError(
                "not_found",
                "automation event not found",
                404,
              );
            return record;
          }
          case "rules.list":
            return publicRows(data.rules, repository, input);
          case "rules.get":
            return selectRule(data, repository, input.id);
          case "rules.preview": {
            const rule =
              input.rule === undefined
                ? selectRule(data, repository, input.id)
                : parseRule(
                    object(input.rule),
                    repository,
                    userId,
                    now,
                    supported,
                  );
            const event = reviewEvent(input.event, repository);
            const explanation = explainRule(rule, event, current);
            return {
              matched: explanation.passed,
              explanation,
              actions: explanation.passed
                ? rule.actions.map((plan) => ({
                    ...plan,
                    input: resolveActionInput(plan.input, event),
                  }))
                : [],
              writes: false,
            };
          }
          case "rules.export":
            return {
              format: "jsonl",
              content:
                data.rules
                  .filter((rule) => rule.repository === repository)
                  .map((rule) =>
                    JSON.stringify({
                      format: "apertureprism-automation-rule",
                      version: 1,
                      repository,
                      rule,
                    }),
                  )
                  .join("\n") + "\n",
            };
          case "runs.list":
            return publicRows(
              data.runs.filter(
                (run) => !input.state || run.state === input.state,
              ),
              repository,
              input,
            );
          case "runs.get":
            return findRun(data, repository, text(input.id, "id"));
          case "approvals.list":
            return publicRows(
              data.approvals.filter(
                (approval) => !input.state || approval.state === input.state,
              ),
              repository,
              input,
            );
          case "artifacts.list":
            return publicRows(
              data.artifacts.map(
                ({ content: _content, ...artifact }) => artifact,
              ),
              repository,
              input,
            );
          case "artifacts.get": {
            const artifact = data.artifacts.find(
              (entry) =>
                entry.repository === repository &&
                entry.id === text(input.id, "id"),
            );
            if (!artifact)
              throw new AutomationError(
                "not_found",
                "automation artifact not found",
                404,
              );
            return artifact;
          }
          case "audit.list":
            return publicRows([...data.audit].reverse(), repository, input);
        }
      }

      if (action === "events.dispatch") {
        const dispatched = await records.change((data) =>
          dispatchEvent(data, repository, input, userId, now),
        );
        const runs = [];
        for (const id of dispatched.event.runIds)
          runs.push(
            await resumeRun(records, trustedActor, repository, id, options),
          );
        return {
          replayed: dispatched.replayed,
          eventId: dispatched.event.id,
          skipped: dispatched.event.skipped,
          runs,
        };
      }
      if (action === "runs.retry") {
        const id = text(input.id, "id");
        await records.change((data) => {
          const run = findRun(data, repository, id);
          if (run.state !== "failed")
            throw new AutomationError(
              "invalid_run_state",
              "only failed runs can be explicitly retried",
              409,
            );
          const step = run.steps.find((entry) => entry.state !== "completed");
          if (!step)
            throw new AutomationError(
              "invalid_run_state",
              "run has no failed or unconfirmed step",
              409,
            );
          if (
            run.costUsed + step.costUnits > run.budget.maxCostUnits ||
            run.durationMs >= run.budget.maxDurationMs
          )
            throw new AutomationError(
              "execution_budget_exhausted",
              "remaining execution budget is insufficient for another attempt",
              409,
            );
          const previousAttempts = step.attempts;
          step.state = "pending";
          step.attempts = 0;
          step.startedAt = null;
          step.completedAt = null;
          step.error = null;
          step.output = null;
          run.state = "queued";
          run.leaseOwner = null;
          run.leaseUntil = null;
          run.nextAttemptAt = null;
          run.updatedAt = now;
          writeAutomationAudit(
            data,
            repository,
            userId,
            "run.explicit_retry",
            id,
            {
              stepId: step.id,
              previousAttempts,
              costUsed: run.costUsed,
              durationMs: run.durationMs,
            },
            now,
          );
        });
        return resumeRun(records, trustedActor, repository, id, options);
      }
      if (action === "runs.resume")
        return resumeRun(
          records,
          trustedActor,
          repository,
          text(input.id, "id"),
          options,
        );
      if (action === "runs.recover") {
        const limit = integer(input.limit, "limit", 1, 100, 20);
        const data = await records.read();
        const due = data.runs
          .filter(
            (run) =>
              run.repository === repository &&
              (run.state === "queued" ||
                (run.state === "retry_wait" &&
                  run.nextAttemptAt !== null &&
                  run.nextAttemptAt <= now) ||
                (run.state === "running" &&
                  run.leaseUntil !== null &&
                  run.leaseUntil <= now)),
          )
          .slice(0, limit);
        const runs = [];
        for (const run of due)
          runs.push(
            await resumeRun(records, trustedActor, repository, run.id, options),
          );
        return { recovered: runs.length, runs };
      }

      return records.change((data) => {
        switch (action) {
          case "rules.create": {
            const rule = parseRule(input, repository, userId, now, supported);
            data.rules.push(rule);
            writeAutomationAudit(
              data,
              repository,
              userId,
              "rule.created",
              rule.id,
              { version: rule.version },
              now,
            );
            return rule;
          }
          case "rules.update": {
            const previous = selectRule(data, repository, input.id);
            if (
              input.version !== undefined &&
              input.version !== previous.version
            )
              throw new AutomationError(
                "version_conflict",
                "rule changed since it was read",
                409,
              );
            const rule = parseRule(
              { ...previous, ...input },
              repository,
              userId,
              now,
              supported,
              previous,
            );
            data.rules[data.rules.indexOf(previous)] = rule;
            writeAutomationAudit(
              data,
              repository,
              userId,
              "rule.updated",
              rule.id,
              { version: rule.version },
              now,
            );
            return rule;
          }
          case "rules.toggle": {
            const rule = selectRule(data, repository, input.id);
            rule.enabled = bool(input.enabled, "enabled", !rule.enabled);
            rule.version += 1;
            rule.updatedAt = now;
            writeAutomationAudit(
              data,
              repository,
              userId,
              "rule.toggled",
              rule.id,
              { enabled: rule.enabled },
              now,
            );
            return rule;
          }
          case "rules.delete": {
            const rule = selectRule(data, repository, input.id);
            data.rules.splice(data.rules.indexOf(rule), 1);
            writeAutomationAudit(
              data,
              repository,
              userId,
              "rule.deleted",
              rule.id,
              {},
              now,
            );
            return { deleted: true };
          }
          case "rules.import": {
            const content = text(input.content, "content", 4 * 1024 * 1024);
            const lines = content.split(/\r?\n/).filter((line) => line.trim());
            if (lines.length > 500)
              throw new AutomationError(
                "import_too_large",
                "import supports at most 500 rules",
                413,
              );
            const imported = lines.map((line) => {
              let document: Record<string, unknown>;
              try {
                document = object(JSON.parse(line));
              } catch {
                throw new AutomationError(
                  "invalid_import",
                  "rule import contains invalid JSONL",
                );
              }
              if (
                document.format !== "apertureprism-automation-rule" ||
                document.version !== 1 ||
                repositoryName(document.repository) !== repository
              )
                throw new AutomationError(
                  "invalid_import",
                  "rule import format or repository does not match",
                );
              return parseRule(
                object(document.rule, "rule"),
                repository,
                userId,
                now,
                supported,
              );
            });
            data.rules.push(...imported);
            writeAutomationAudit(
              data,
              repository,
              userId,
              "rules.imported",
              "",
              { count: imported.length },
              now,
            );
            return { imported: imported.length, items: imported };
          }
          case "runs.cancel": {
            const run = findRun(data, repository, text(input.id, "id"));
            if (["completed", "failed", "canceled"].includes(run.state))
              return run;
            run.state = "canceled";
            run.leaseOwner = null;
            run.leaseUntil = null;
            run.updatedAt = now;
            for (const approval of data.approvals)
              if (approval.runId === run.id && approval.state === "pending") {
                approval.state = "rejected";
                approval.decidedBy = userId;
                approval.decidedAt = now;
                approval.note = "run canceled";
              }
            writeAutomationAudit(
              data,
              repository,
              userId,
              "run.canceled",
              run.id,
              {},
              now,
            );
            return run;
          }
          case "approvals.decide": {
            if (!actor.isAdmin)
              throw new AutomationError(
                "admin_required",
                "approval decisions require an administrator",
                403,
              );
            const approval = data.approvals.find(
              (entry) =>
                entry.repository === repository &&
                entry.id === text(input.id, "id"),
            );
            if (!approval)
              throw new AutomationError("not_found", "approval not found", 404);
            if (typeof input.approved !== "boolean")
              throw new AutomationError(
                "invalid_input",
                "approved must be an explicit boolean",
              );
            const approved = input.approved;
            if (approval.state !== "pending") {
              if ((approval.state === "approved") !== approved)
                throw new AutomationError(
                  "approval_conflict",
                  "approval was already decided differently",
                  409,
                );
              return approval;
            }
            if (
              approval.requireDifferentActor &&
              approval.requestedBy === userId
            )
              throw new AutomationError(
                "different_approver_required",
                "the requester cannot approve their own execution",
                403,
              );
            approval.state = approved ? "approved" : "rejected";
            approval.decidedBy = userId;
            approval.decidedAt = now;
            approval.note =
              input.note === undefined ? "" : text(input.note, "note", 2000);
            const run = findRun(data, repository, approval.runId);
            const step = run.steps.find((item) => item.id === approval.stepId)!;
            step.state = approved ? "completed" : "failed";
            step.completedAt = now;
            step.output = { approvalId: approval.id, approved };
            step.error = approved ? null : "approval_rejected";
            run.state = approved ? "queued" : "failed";
            run.updatedAt = now;
            writeAutomationAudit(
              data,
              repository,
              userId,
              "approval.decided",
              approval.id,
              { approved },
              now,
            );
            return approval;
          }
          default:
            throw new AutomationError(
              "unknown_action",
              `automation action ${action} does not exist`,
              404,
            );
        }
      });
    },
  };
}
