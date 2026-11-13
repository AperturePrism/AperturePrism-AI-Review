import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAutomation, AutomationError } from "./index.js";
import { AutomationRecords } from "./records.js";
import type {
  ActionContext,
  Approval,
  Automation,
  AutomationActor,
  AutomationOptions,
  AutomationRule,
  AutomationRun,
  ReviewEvent,
} from "./types.js";

const directories: string[] = [];
const repository = "owner/repo";
const actor: AutomationActor = {
  userId: "review-worker",
  isAdmin: true,
  canAccessRepository: () => true,
};
const human: AutomationActor = { ...actor, userId: "human-reviewer" };
const event: ReviewEvent = {
  id: "review:task-1:sha-1",
  type: "review.completed",
  repository,
  occurredAt: "2026-11-13T10:00:00.000Z",
  subject: { kind: "pr", number: 4, labels: ["security"] },
  gate: "fail",
  risk: "high",
  findings: { total: 3, new: 2, high: 1 },
  data: { findingId: "finding-1" },
};
async function fixture(extra: Partial<AutomationOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "aperture-automation-"));
  directories.push(directory);
  let date = new Date(event.occurredAt);
  const options: AutomationOptions = {
    dataDirectory: directory,
    now: () => new Date(date),
    ...extra,
  };
  const automation = createAutomation(options);
  return {
    automation,
    options,
    directory,
    advance: (ms: number) => {
      date = new Date(date.getTime() + ms);
    },
  };
}
async function command<T = unknown>(
  automation: Automation,
  action: string,
  input: Record<string, unknown> = {},
  as = actor,
): Promise<T> {
  return automation.execute(as, {
    action,
    input: { ...input, repository },
  }) as Promise<T>;
}
async function rule(
  automation: Automation,
  changes: Record<string, unknown> = {},
): Promise<AutomationRule> {
  return command(automation, "rules.create", {
    name: "Failed gate",
    condition: { field: "gate", op: "eq", value: "fail" },
    actions: [{ kind: "audit.record", input: { message: "Gate failed" } }],
    ...changes,
  });
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("rules and explainable trials", () => {
  it("creates a complete rule and previews it without writing a run", async () => {
    const { automation } = await fixture();
    const created = await rule(automation);
    const preview = await command<{
      matched: boolean;
      writes: boolean;
      explanation: unknown;
    }>(automation, "rules.preview", { id: created.id, event });
    expect(preview.matched).toBe(true);
    expect(preview.writes).toBe(false);
    expect(preview.explanation).toBeDefined();
    expect(await command(automation, "runs.list")).toMatchObject({ total: 0 });
  });
  it("rejects an unavailable action while creating a rule", async () => {
    const { automation } = await fixture();
    await expect(
      rule(automation, { actions: [{ kind: "send.email", input: {} }] }),
    ).rejects.toMatchObject({ code: "unsupported_action" });
    expect(await command(automation, "rules.list")).toMatchObject({ total: 0 });
  });
  it("checks a version lease before replacing a rule", async () => {
    const { automation } = await fixture();
    const created = await rule(automation);
    await command(automation, "rules.toggle", {
      id: created.id,
      enabled: false,
    });
    await expect(
      command(automation, "rules.update", {
        id: created.id,
        version: created.version,
        name: "stale",
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });
  });
  it("imports and exports JSONL with atomic rejection of a bad record", async () => {
    const first = await fixture();
    await rule(first.automation);
    const exported = await command<{ content: string }>(
      first.automation,
      "rules.export",
    );
    const second = await fixture();
    await expect(
      command(second.automation, "rules.import", {
        content: exported.content + "bad-json\n",
      }),
    ).rejects.toMatchObject({ code: "invalid_import" });
    expect(await command(second.automation, "rules.list")).toMatchObject({
      total: 0,
    });
    expect(
      await command(second.automation, "rules.import", {
        content: exported.content,
      }),
    ).toMatchObject({ imported: 1 });
  });
  it("does not import a different repository's rules into this one", async () => {
    const { automation } = await fixture();
    const created = await rule(automation);
    await expect(
      command(automation, "rules.import", {
        content: JSON.stringify({
          format: "apertureprism-automation-rule",
          version: 1,
          repository: "other/repo",
          rule: created,
        }),
      }),
    ).rejects.toMatchObject({ code: "invalid_import" });
  });
  it("resolves only explicit event references in an action plan", async () => {
    const { automation } = await fixture();
    const created = await rule(automation, {
      actions: [
        { kind: "audit.record", input: { message: { $event: "repository" } } },
      ],
    });
    expect(
      await command(automation, "rules.preview", { id: created.id, event }),
    ).toMatchObject({ actions: [{ input: { message: repository } }] });
  });
  it("enforces action count and cost budgets while saving a rule", async () => {
    const { automation } = await fixture();
    await expect(
      rule(automation, {
        budget: { maxCostUnits: 1 },
        actions: [{ kind: "audit.record", costUnits: 2 }],
      }),
    ).rejects.toMatchObject({ code: "rule_budget_exceeded" });
  });
});

describe("event idempotency, loops and rate limits", () => {
  it("persists one event, one run and one audit action across duplicate delivery", async () => {
    const { automation } = await fixture();
    await rule(automation);
    const first = await command<{ replayed: boolean; runs: AutomationRun[] }>(
      automation,
      "events.dispatch",
      { event },
    );
    const second = await command<{ replayed: boolean; runs: AutomationRun[] }>(
      automation,
      "events.dispatch",
      { event },
    );
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.runs[0]?.id).toBe(first.runs[0]?.id);
    expect(second.runs[0]?.state).toBe("completed");
    const audit = await command<{ items: { action: string }[] }>(
      automation,
      "audit.list",
    );
    expect(
      audit.items.filter((entry) => entry.action === "automation.action.audit"),
    ).toHaveLength(1);
  });
  it("rejects different content under the same event identity", async () => {
    const { automation } = await fixture();
    await rule(automation);
    await command(automation, "events.dispatch", { event });
    await expect(
      command(automation, "events.dispatch", {
        event: { ...event, gate: "pass" },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  it("keeps idempotency after reopening the data with another factory", async () => {
    const { automation, options } = await fixture();
    await rule(automation);
    await command(automation, "events.dispatch", { event });
    const reopened = createAutomation(options);
    expect(await command(reopened, "events.dispatch", { event })).toMatchObject(
      { replayed: true, runs: [{ state: "completed" }] },
    );
  });
  it("handles simultaneous delivery through two process-safe storage owners", async () => {
    const { automation, options } = await fixture();
    await rule(automation);
    const other = createAutomation(options);
    await Promise.all([
      command(automation, "events.dispatch", { event }),
      command(other, "events.dispatch", { event }),
    ]);
    expect(await command(automation, "runs.list")).toMatchObject({ total: 1 });
    const audit = await command<{ items: { action: string }[] }>(
      automation,
      "audit.list",
    );
    expect(
      audit.items.filter((entry) => entry.action === "automation.action.audit"),
    ).toHaveLength(1);
  });
  it("does not run a rule already present in the event trace", async () => {
    const { automation } = await fixture();
    const created = await rule(automation);
    expect(
      await command(automation, "events.dispatch", {
        event: { ...event, trace: { depth: 1, ruleIds: [created.id] } },
      }),
    ).toMatchObject({ runs: [], skipped: [{ reason: "loop_prevented" }] });
  });
  it("does not allow more than eight generations of chained automation", async () => {
    const { automation } = await fixture();
    await rule(automation);
    expect(
      await command(automation, "events.dispatch", {
        event: { ...event, trace: { depth: 8, ruleIds: [] } },
      }),
    ).toMatchObject({ runs: [], skipped: [{ reason: "loop_prevented" }] });
  });
  it("resets a rule's rate budget after its declared time window", async () => {
    const { automation, advance } = await fixture();
    await rule(automation, { rate: { limit: 1, windowSeconds: 10 } });
    await command(automation, "events.dispatch", { event });
    expect(
      await command(automation, "events.dispatch", {
        event: { ...event, id: "second" },
      }),
    ).toMatchObject({ runs: [], skipped: [{ reason: "rule_rate_limited" }] });
    advance(10_001);
    expect(
      await command(automation, "events.dispatch", {
        event: { ...event, id: "third" },
      }),
    ).toMatchObject({ runs: [{ state: "completed" }] });
  });
  it("records a missing event reference as an explainable skip", async () => {
    const { automation } = await fixture();
    await rule(automation, {
      actions: [
        { kind: "audit.record", input: { message: { $event: "data.absent" } } },
      ],
    });
    expect(
      await command(automation, "events.dispatch", { event }),
    ).toMatchObject({ runs: [], skipped: [{ reason: "missing_reference" }] });
  });
});

describe("durable retries and approvals", () => {
  it("retries an unconfirmed action with the same idempotency key", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporarily offline"))
      .mockResolvedValue({ done: true });
    const { automation, advance } = await fixture({
      actions: { "local.test": execute },
    });
    await rule(automation, { actions: [{ kind: "local.test", input: {} }] });
    const first = await command<{ runs: AutomationRun[] }>(
      automation,
      "events.dispatch",
      { event },
    );
    expect(first.runs[0]?.state).toBe("retry_wait");
    expect(first.runs[0]?.steps[0]?.error).toBe("action_failed");
    advance(251);
    const second = await command<AutomationRun>(automation, "runs.resume", {
      id: first.runs[0]!.id,
    });
    expect(second.state).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[0].idempotencyKey).toBe(
      execute.mock.calls[1]?.[0].idempotencyKey,
    );
    await command(automation, "runs.resume", { id: second.id });
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("stops retrying a permanent input failure", async () => {
    const execute = vi.fn(async () => {
      throw new AutomationError("invalid_target", "bad target");
    });
    const { automation } = await fixture({
      actions: { "local.fail": execute },
    });
    await rule(automation, { actions: [{ kind: "local.fail" }] });
    expect(
      await command(automation, "events.dispatch", { event }),
    ).toMatchObject({
      runs: [
        { state: "failed", steps: [{ attempts: 1, error: "invalid_target" }] },
      ],
    });
  });
  it("respects action-attempt budgets after a process restart", async () => {
    const execute = vi.fn(async () => {
      throw new Error("retry later");
    });
    const { automation, options, advance } = await fixture({
      actions: { "local.fail": execute },
    });
    await rule(automation, {
      actions: [{ kind: "local.fail", maxAttempts: 1 }],
    });
    const result = await command<{ runs: AutomationRun[] }>(
      automation,
      "events.dispatch",
      { event },
    );
    advance(1000);
    expect(
      await command(createAutomation(options), "runs.resume", {
        id: result.runs[0]!.id,
      }),
    ).toMatchObject({ state: "failed" });
    expect(execute).toHaveBeenCalledOnce();
  });
  it("can recover due retries without knowing each run id", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(null);
    const { automation, advance } = await fixture({
      actions: { "local.test": execute },
    });
    await rule(automation, { actions: [{ kind: "local.test" }] });
    await command(automation, "events.dispatch", { event });
    expect(await command(automation, "runs.recover")).toMatchObject({
      recovered: 0,
    });
    advance(251);
    expect(await command(automation, "runs.recover")).toMatchObject({
      recovered: 1,
      runs: [{ state: "completed" }],
    });
  });
  it("pauses for a different human and continues only after explicit approval", async () => {
    const { automation } = await fixture();
    await rule(automation, {
      actions: [
        { kind: "approval.request" },
        { kind: "audit.record", input: { message: "approved" } },
      ],
    });
    const result = await command<{ runs: AutomationRun[] }>(
      automation,
      "events.dispatch",
      { event },
    );
    expect(result.runs[0]?.state).toBe("waiting");
    const approvals = await command<{ items: Approval[] }>(
      automation,
      "approvals.list",
    );
    const approval = approvals.items[0]!;
    await expect(
      command(automation, "approvals.decide", {
        id: approval.id,
        approved: true,
      }),
    ).rejects.toMatchObject({ code: "different_approver_required" });
    await command(
      automation,
      "approvals.decide",
      { id: approval.id, approved: true },
      human,
    );
    expect(
      await command(
        automation,
        "runs.resume",
        { id: result.runs[0]!.id },
        human,
      ),
    ).toMatchObject({ state: "completed" });
  });
  it("requires an explicit decision and administrator role", async () => {
    const { automation } = await fixture();
    await rule(automation, { actions: [{ kind: "approval.request" }] });
    await command(automation, "events.dispatch", { event });
    const { items } = await command<{ items: Approval[] }>(
      automation,
      "approvals.list",
    );
    await expect(
      command(automation, "approvals.decide", { id: items[0]!.id }, human),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      command(
        automation,
        "approvals.decide",
        { id: items[0]!.id, approved: true },
        { ...human, isAdmin: false },
      ),
    ).rejects.toMatchObject({ code: "admin_required" });
  });
  it("fences a canceled run against a late action completion", async () => {
    let release: ((value: null) => void) | undefined;
    let entered: (() => void) | undefined;
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const execute = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          release = resolve;
          entered!();
        }),
    );
    const { automation } = await fixture({
      actions: { "local.slow": execute },
    });
    await rule(automation, { actions: [{ kind: "local.slow" }] });
    const dispatched = command(automation, "events.dispatch", { event });
    await entry;
    const { items } = await command<{ items: AutomationRun[] }>(
      automation,
      "runs.list",
    );
    await command(automation, "runs.cancel", { id: items[0]!.id });
    release!(null);
    await dispatched;
    expect(
      await command(automation, "runs.get", { id: items[0]!.id }),
    ).toMatchObject({ state: "canceled" });
  });
  it("reclaims an expired execution lease with its original step key", async () => {
    const execute = vi.fn(async (_context: ActionContext) => ({
      recovered: true,
    }));
    const { automation, options } = await fixture({
      actions: { "local.test": execute },
    });
    const created = await rule(automation, {
      actions: [{ kind: "approval.request" }, { kind: "local.test" }],
    });
    const result = await command<{ runs: AutomationRun[] }>(
      automation,
      "events.dispatch",
      { event },
    );
    const records = new AutomationRecords(options);
    const originalKey = await records.change((data) => {
      const run = data.runs.find(
        (candidate) => candidate.ruleId === created.id,
      )!;
      run.steps[0]!.state = "completed";
      run.steps[1]!.state = "running";
      run.steps[1]!.attempts = 1;
      run.state = "running";
      run.leaseOwner = "crashed-worker";
      run.leaseUntil = "2026-11-13T09:59:00.000Z";
      return run.steps[1]!.idempotencyKey;
    });
    expect(
      await command(automation, "runs.resume", { id: result.runs[0]!.id }),
    ).toMatchObject({ state: "completed" });
    expect(execute.mock.calls[0]?.[0].idempotencyKey).toBe(originalKey);
  });
});

describe("workbench actions and repository isolation", () => {
  it("creates an actual persisted report artifact through an injected workbench port", async () => {
    const execute = vi.fn(async () => ({
      format: "markdown",
      content: "# Review\n",
      mediaType: "text/markdown",
    }));
    const { automation } = await fixture({ workbench: { execute } });
    await rule(automation, {
      actions: [
        {
          kind: "report.create",
          input: { format: "markdown", repository: "other/repo" },
        },
      ],
    });
    expect(
      await command(automation, "events.dispatch", { event }),
    ).toMatchObject({ runs: [{ state: "completed" }] });
    expect(execute).toHaveBeenCalledWith(expect.anything(), {
      action: "reports.render",
      input: { format: "markdown", repository },
    });
    const artifacts = await command<{ items: { id: string }[] }>(
      automation,
      "artifacts.list",
    );
    expect(
      await command(automation, "artifacts.get", {
        id: artifacts.items[0]!.id,
      }),
    ).toMatchObject({ content: "# Review\n" });
  });
  it("does not reapply a finding state already set by a previous uncertain execution", async () => {
    const execute = vi.fn(async () => ({ status: "fixed" }));
    const { automation } = await fixture({ workbench: { execute } });
    await rule(automation, {
      actions: [
        {
          kind: "finding.transition",
          input: { findingId: "finding-1", status: "fixed" },
        },
      ],
    });
    expect(
      await command(automation, "events.dispatch", { event }),
    ).toMatchObject({
      runs: [
        { state: "completed", steps: [{ output: { alreadyApplied: true } }] },
      ],
    });
    expect(execute).toHaveBeenCalledOnce();
  });
  it("denies an unauthorized repository before even creating its data directory", async () => {
    const directory = join(
      await mkdtemp(join(tmpdir(), "aperture-automation-deny-")),
      "uncreated",
    );
    directories.push(join(directory, ".."));
    const automation = createAutomation({ dataDirectory: directory });
    await expect(
      command(
        automation,
        "summary",
        {},
        { ...actor, isAdmin: false, canAccessRepository: () => false },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("separately requests view and manage permission", async () => {
    const canAccessRepository = vi.fn(
      async (_repository: string, write: boolean) => !write,
    );
    const { automation } = await fixture();
    const viewer = { ...actor, isAdmin: false, canAccessRepository };
    await command(automation, "summary", {}, viewer);
    await expect(
      command(automation, "rules.create", {}, viewer),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(canAccessRepository).toHaveBeenNthCalledWith(1, repository, false);
    expect(canAccessRepository.mock.calls.at(-1)).toEqual([repository, true]);
  });
  it("keeps a foreign repository's record id outside a readable collection", async () => {
    const { automation } = await fixture();
    const created = await rule(automation);
    await expect(
      automation.execute(actor, {
        action: "rules.get",
        input: { repository: "other/repo", id: created.id },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
  it("stores readable, versioned execution records with no partial JSON", async () => {
    const { automation, directory } = await fixture();
    await rule(automation);
    await command(automation, "events.dispatch", { event });
    const content = JSON.parse(
      await readFile(join(directory, "automation.json"), "utf8"),
    ) as { version: number; runs: AutomationRun[] };
    expect(content.version).toBe(1);
    expect(content.runs[0]?.steps[0]?.state).toBe("completed");
    expect((await stat(join(directory, "automation.json"))).mode & 0o777).toBe(
      0o600,
    );
  });
});

describe("explicit retry retains execution accounting", () => {
  it("retries only the failed step and preserves completed action receipts", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(
        new AutomationError("unavailable", "temporarily unavailable"),
      )
      .mockResolvedValue({ done: true });
    const { automation } = await fixture({
      actions: { "local.test": execute },
    });
    await rule(automation, {
      actions: [
        { kind: "audit.record", input: { message: "once" } },
        { kind: "local.test", maxAttempts: 1 },
      ],
    });
    const dispatched = await command<{ runs: AutomationRun[] }>(
      automation,
      "events.dispatch",
      { event },
    );
    const before = dispatched.runs[0]!;
    expect(before.state).toBe("failed");
    const retried = await command<AutomationRun>(automation, "runs.retry", {
      id: before.id,
    });
    expect(retried.state).toBe("completed");
    expect(retried.costUsed).toBeGreaterThan(before.costUsed);
    expect(retried.steps[1]?.idempotencyKey).toBe(
      before.steps[1]?.idempotencyKey,
    );
    const audit = await command<{ items: { action: string }[] }>(
      automation,
      "audit.list",
    );
    expect(
      audit.items.filter((entry) => entry.action === "automation.action.audit"),
    ).toHaveLength(1);
  });
  it("does not reset the total execution budget to make room for a retry", async () => {
    const execute = vi.fn(async () => {
      throw new Error("offline");
    });
    const { automation } = await fixture({
      actions: { "local.test": execute },
    });
    await rule(automation, {
      actions: [{ kind: "local.test", maxAttempts: 1 }],
      budget: { maxCostUnits: 1 },
    });
    const result = await command<{ runs: AutomationRun[] }>(
      automation,
      "events.dispatch",
      { event },
    );
    await expect(
      command(automation, "runs.retry", { id: result.runs[0]!.id }),
    ).rejects.toMatchObject({ code: "execution_budget_exhausted" });
    expect(execute).toHaveBeenCalledOnce();
  });
  it("records invalid native-action input as a failed execution, not a stuck lease", async () => {
    const { automation } = await fixture();
    await rule(automation, {
      actions: [{ kind: "audit.record", input: { message: 123 } }],
    });
    expect(
      await command(automation, "events.dispatch", { event }),
    ).toMatchObject({
      runs: [
        {
          state: "failed",
          leaseOwner: null,
          steps: [{ error: "invalid_input" }],
        },
      ],
    });
  });
});
