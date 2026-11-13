/**
 * 自动化运行：先持久领取动作，再在锁外执行，最后以租约所有者确认结果。
 * 调用：await resumeRun(records, actor, repository, runId, options)。
 * 崩溃后未确认的动作使用相同 idempotencyKey 重试；已完成步骤永不重新执行。
 */
import { randomUUID } from "node:crypto";
import { AutomationRecords, writeAutomationAudit } from "./records.js";
import type {
  ActionContext,
  AutomationActor,
  AutomationOptions,
  AutomationRun,
  AutomationSnapshot,
  Json,
  RunStep,
} from "./types.js";
import { AutomationError, bool, jsonValue, text } from "./utils/input.js";

export function findRun(
  data: AutomationSnapshot,
  repository: string,
  id: string,
): AutomationRun {
  const run = data.runs.find(
    (candidate) => candidate.repository === repository && candidate.id === id,
  );
  if (!run)
    throw new AutomationError("not_found", "automation run not found", 404);
  return run;
}
function finishStep(
  run: AutomationRun,
  step: RunStep,
  output: Json,
  now: string,
): void {
  step.state = "completed";
  step.output = output;
  step.completedAt = now;
  step.error = null;
  run.state = run.steps.every((item) => item.state === "completed")
    ? "completed"
    : "queued";
  run.updatedAt = now;
  run.leaseOwner = null;
  run.leaseUntil = null;
  run.nextAttemptAt = null;
}
function nativeAction(
  data: AutomationSnapshot,
  run: AutomationRun,
  step: RunStep,
  actor: AutomationActor,
  now: string,
): boolean {
  if (step.kind === "audit.record") {
    const message = text(
      step.input.message,
      "audit.message",
      2000,
      "automation rule matched",
    );
    writeAutomationAudit(
      data,
      run.repository,
      actor.userId,
      "automation.action.audit",
      run.id,
      { message, ruleId: run.ruleId, eventId: run.eventId },
      now,
    );
    finishStep(run, step, { recorded: true }, now);
    return true;
  }
  if (step.kind === "approval.request") {
    const approval = {
      id: randomUUID(),
      repository: run.repository,
      runId: run.id,
      stepId: step.id,
      title: text(
        step.input.title,
        "approval.title",
        300,
        `Review ${run.ruleName}`,
      ),
      reason: text(
        step.input.reason,
        "approval.reason",
        2000,
        "Human approval is required before continuing",
      ),
      state: "pending" as const,
      requestedBy: actor.userId,
      decidedBy: null,
      decidedAt: null,
      note: "",
      requireDifferentActor: bool(
        step.input.requireDifferentActor,
        "requireDifferentActor",
        true,
      ),
      createdAt: now,
    };
    data.approvals.push(approval);
    step.state = "waiting";
    step.output = { approvalId: approval.id };
    run.state = "waiting";
    run.leaseOwner = null;
    run.leaseUntil = null;
    writeAutomationAudit(
      data,
      run.repository,
      actor.userId,
      "approval.requested",
      approval.id,
      { runId: run.id },
      now,
    );
    return true;
  }
  return false;
}

/** 工作台动作只使用显式传入的接口，默认不会建立网络连接或外发消息。 */
async function executeAction(
  context: ActionContext,
  options: AutomationOptions,
  kind: string,
): Promise<Json> {
  const custom = options.actions?.[kind];
  if (custom) return jsonValue(await custom(context), 256 * 1024);
  if (!options.workbench)
    throw new AutomationError(
      "unsupported_action",
      `action ${kind} requires a workbench`,
    );
  if (kind === "report.create") {
    const format = text(context.input.format, "report.format", 50, "markdown");
    const result = await options.workbench.execute(context.actor, {
      action: "reports.render",
      input: { ...context.input, repository: context.repository, format },
    });
    const output = jsonValue(result, 2 * 1024 * 1024);
    if (
      !output ||
      typeof output !== "object" ||
      Array.isArray(output) ||
      typeof output.content !== "string"
    )
      throw new AutomationError(
        "invalid_report",
        "workbench did not return report content",
        500,
      );
    return output;
  }
  if (kind === "finding.transition") {
    const id = text(context.input.findingId, "findingId");
    const status = text(context.input.status, "status", 40);
    if (
      ![
        "open",
        "acknowledged",
        "fixed",
        "false_positive",
        "accepted_risk",
      ].includes(status)
    )
      throw new AutomationError("invalid_input", "unsupported finding status");
    const existing = (await options.workbench.execute(context.actor, {
      action: "findings.get",
      input: { repository: context.repository, id },
    })) as { status?: string };
    if (existing.status === status) return { id, status, alreadyApplied: true };
    const result = await options.workbench.execute(context.actor, {
      action: "findings.transition",
      input: {
        repository: context.repository,
        id,
        status,
        reason: text(
          context.input.reason,
          "reason",
          2000,
          `automation ${context.runId}`,
        ),
      },
    });
    return jsonValue(result, 256 * 1024);
  }
  throw new AutomationError(
    "unsupported_action",
    `action ${kind} is not installed`,
  );
}

/** 动作限时到期后发出取消信号；自定义动作必须遵守 signal 与幂等键契约。 */
async function withDeadline(
  context: Omit<ActionContext, "signal">,
  options: AutomationOptions,
  kind: string,
  duration: number,
): Promise<Json> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      executeAction({ ...context, signal: controller.signal }, options, kind),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new AutomationError(
              "action_timeout",
              "automation action exceeded its execution budget",
              504,
              true,
            ),
          );
        }, duration);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 恢复一个运行，持续执行到完成、人工审批、重试等待或预算耗尽。 */
export async function resumeRun(
  records: AutomationRecords,
  actor: AutomationActor,
  repository: string,
  runId: string,
  options: AutomationOptions,
): Promise<AutomationRun> {
  const now = options.now ?? (() => new Date());
  const owner = randomUUID();
  for (let round = 0; round < 20; round += 1) {
    const current = now();
    const claim = await records.change((data) => {
      const run = findRun(data, repository, runId);
      if (["completed", "failed", "canceled", "waiting"].includes(run.state))
        return { run, step: null, native: false };
      if (
        run.state === "running" &&
        run.leaseUntil &&
        run.leaseUntil > current.toISOString()
      )
        return { run, step: null, native: false };
      if (
        run.state === "retry_wait" &&
        run.nextAttemptAt &&
        run.nextAttemptAt > current.toISOString()
      )
        return { run, step: null, native: false };
      const step = run.steps.find((entry) => entry.state !== "completed");
      if (!step) {
        run.state = "completed";
        return { run, step: null, native: false };
      }
      if (
        step.attempts >= step.maxAttempts ||
        run.costUsed + step.costUnits > run.budget.maxCostUnits ||
        run.durationMs >= run.budget.maxDurationMs
      ) {
        run.state = "failed";
        step.state = "failed";
        step.error = "execution_budget_exhausted";
        run.leaseOwner = null;
        run.leaseUntil = null;
        run.updatedAt = current.toISOString();
        writeAutomationAudit(
          data,
          repository,
          actor.userId,
          "run.budget_exhausted",
          run.id,
          { stepId: step.id },
          current.toISOString(),
        );
        return { run, step: null, native: false };
      }
      step.state = "running";
      step.attempts += 1;
      step.startedAt = current.toISOString();
      step.error = null;
      run.state = "running";
      run.leaseOwner = owner;
      run.leaseUntil = new Date(
        current.getTime() + run.budget.maxDurationMs - run.durationMs + 5000,
      ).toISOString();
      run.costUsed += step.costUnits;
      run.updatedAt = current.toISOString();
      let native = false;
      try {
        native = nativeAction(data, run, step, actor, current.toISOString());
      } catch (error) {
        step.state = "failed";
        step.error =
          error instanceof AutomationError ? error.code : "action_failed";
        run.state = "failed";
        run.leaseOwner = null;
        run.leaseUntil = null;
        writeAutomationAudit(
          data,
          repository,
          actor.userId,
          "run.step_failed",
          run.id,
          {
            stepId: step.id,
            kind: step.kind,
            code: step.error,
            retryable: false,
          },
          current.toISOString(),
        );
        return { run, step: null, native: false };
      }
      return { run, step, native };
    });
    if (!claim.step) return claim.run;
    if (claim.native) {
      if (claim.run.state === "waiting") return claim.run;
      continue;
    }
    const started = now().getTime();
    let output: Json = null;
    let failure: { error: unknown } | null = null;
    try {
      output = await withDeadline(
        {
          repository,
          actor,
          event: {
            ...claim.run.event,
            trace: {
              depth: (claim.run.event.trace?.depth ?? 0) + 1,
              ruleIds: [
                ...(claim.run.event.trace?.ruleIds ?? []),
                claim.run.ruleId,
              ],
            },
          },
          runId,
          stepId: claim.step.id,
          idempotencyKey: claim.step.idempotencyKey,
          input: claim.step.input,
        },
        options,
        claim.step.kind,
        Math.max(1, claim.run.budget.maxDurationMs - claim.run.durationMs),
      );
    } catch (error) {
      failure = { error };
    }
    const finished = now();
    const committed = await records.change((data) => {
      const run = findRun(data, repository, runId);
      const step = run.steps.find((entry) => entry.id === claim.step!.id)!;
      if (
        run.leaseOwner !== owner ||
        run.state !== "running" ||
        step.state !== "running"
      )
        return run;
      run.durationMs += Math.max(0, finished.getTime() - started);
      if (!failure) {
        if (step.kind === "report.create") {
          const report = output as {
            format?: Json;
            content?: Json;
            mediaType?: Json;
            mimeType?: Json;
          };
          if (typeof report.content !== "string")
            throw new AutomationError(
              "invalid_report",
              "workbench did not return report content",
              500,
            );
          const artifact = {
            id: randomUUID(),
            repository,
            runId,
            stepId: step.id,
            format:
              typeof report.format === "string" ? report.format : "markdown",
            content: report.content,
            mediaType:
              typeof report.mediaType === "string"
                ? report.mediaType
                : typeof report.mimeType === "string"
                  ? report.mimeType
                  : "text/plain",
            createdAt: finished.toISOString(),
          };
          data.artifacts.push(artifact);
          output = { artifactId: artifact.id, format: artifact.format };
        }
        finishStep(run, step, output, finished.toISOString());
        writeAutomationAudit(
          data,
          repository,
          actor.userId,
          "run.step_completed",
          run.id,
          { stepId: step.id, kind: step.kind },
          finished.toISOString(),
        );
      } else {
        const retryable =
          failure.error instanceof AutomationError
            ? failure.error.retryable
            : true;
        step.state = "failed";
        step.error =
          failure.error instanceof AutomationError
            ? failure.error.code
            : "action_failed";
        run.state =
          retryable && step.attempts < step.maxAttempts
            ? "retry_wait"
            : "failed";
        run.nextAttemptAt =
          run.state === "retry_wait"
            ? new Date(
                finished.getTime() +
                  Math.min(60_000, 250 * 2 ** (step.attempts - 1)),
              ).toISOString()
            : null;
        run.leaseOwner = null;
        run.leaseUntil = null;
        run.updatedAt = finished.toISOString();
        writeAutomationAudit(
          data,
          repository,
          actor.userId,
          "run.step_failed",
          run.id,
          { stepId: step.id, kind: step.kind, code: step.error, retryable },
          finished.toISOString(),
        );
      }
      return run;
    });
    if (committed.state !== "queued") return committed;
  }
  return findRun(await records.read(), repository, runId);
}
