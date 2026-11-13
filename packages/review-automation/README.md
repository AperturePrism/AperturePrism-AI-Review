# Review automation

Review automation turns a review event into an explainable, bounded action plan. It owns rules, event receipts, execution steps, approvals, report artifacts and audit records. Its factory does not create directories or contact a model provider.

```ts
const automation = createAutomation({
  dataDirectory: "/var/lib/apertureprism/automation",
  workbench,
});
await automation.execute(actor, {
  action: "events.dispatch",
  input: { repository: "owner/repo", event },
});
```

`actor` comes from the host's authenticated identity and repository grants. Reads request view access; rule changes and execution request manage access. A read-only actor can preview a rule using POST, but cannot change or execute it. `summary.viewer` exposes the host's actual `userId`, `isAdmin` and `canWrite` decision for UI controls.

## Conditions and windows

A rule groups conditions with `all`, `any` or `not`. Leaf conditions use a fixed field and operator:

```json
{
  "name": "High risk review",
  "condition": {
    "all": [
      { "field": "type", "op": "eq", "value": "review.completed" },
      { "field": "subject.labels", "op": "contains", "value": "security" },
      { "field": "findings.new", "op": "gte", "value": 1 },
      { "field": "risk", "op": "in", "value": ["high", "critical"] }
    ]
  },
  "actions": [
    { "kind": "approval.request", "input": { "title": "Review high risk findings" } },
    { "kind": "report.create", "input": { "format": "markdown" } }
  ]
}
```

Allowed fields include repository, event type, PR/Issue identity and labels, gate, risk, finding counts, and bounded `data.*` paths. Operators are `eq`, `neq`, `in`, `contains`, `gt`, `gte`, `lt`, `lte`, `exists` and `glob`. Conditions never execute source code or user regular expressions. `glob` supports only `*` and `?`, with finite dynamic programming. A condition has at most 200 nodes and 12 nesting levels.

Optional windows use `{days:[1,2,3,4,5],start:"09:00",end:"17:00",utcOffsetMinutes:480}`. Weekdays use Sunday = 0; starts are inclusive and ends exclusive. Overnight tails belong to the weekday on which the window started. Equal start/end means all day on the selected weekdays. Preview and event dispatch use the same condition/window functions and return a tree explaining every decision.

An action input can reference one whole event value with `{"$event":"data.findingId"}`. The reference is a bounded own-property path; expressions, function calls and string interpolation are unsupported.

## Execution and recovery

Event IDs are unique within a repository. The same ID and normalized content return the existing runs; different content returns 409. Rule matching and creation of all run records commit atomically under a process-safe file lock. Completed action steps retain their receipts across restarts.

Each action is persisted as running before it executes. A stable `idempotencyKey` accompanies retries after a transient failure or an expired lease. Custom actions must honor that key and `AbortSignal`: a process can stop after an external side effect but before its receipt is saved, so delivery is at least once. Built-in report generation is read-only until its local artifact is committed. Finding transitions first check the current state to recognize an already-applied result.

A rule limits action count, action cost units, action attempts and execution time. Retries use a bounded exponential delay. `runs.recover` reclaims queued, due and expired-lease executions; `runs.resume` handles one run. `runs.retry` is an explicit operator action for failed runs. It preserves completed steps, stable keys and accumulated cost/time; insufficient remaining total budget returns 409. Canceling a run prevents new steps and fences late completion receipts. An already-running external action may still finish its external work and must follow the injected action's cancellation contract.

A trace prevents the same rule from triggering recursively and stops chains after eight generations. At most 20 runs may be created for one event. Rate limits apply per rule and declared time window.

## Built-in actions

| Action | Behavior |
| --- | --- |
| `audit.record` | Atomically record a local audit event. |
| `approval.request` | Pause before later steps; an administrator must explicitly approve or reject. By default the requester cannot approve their own run. |
| `report.create` | Render a report through the explicitly supplied workbench and save a downloadable local artifact. |
| `finding.transition` | Change a workbench finding after checking its current status and repository permission. |

The workbench actions are only installed when a workbench is explicitly supplied. No email, chat message or repository publication is sent by default. Custom actions are registered by the embedding program, rather than by uploading or evaluating scripts.

## HTTP and CLI

The host mounts `GET /api/automation?action=summary&repository=owner/repo` and `POST /api/automation` with `{action,input}`. Successful responses are `{status:"ok",data}`; errors include `code` and `reason`. GET only accepts read actions. Preview can use POST to carry a condition tree and event while keeping read-only authorization.

Useful commands include `rules.create/update/toggle/delete/list/get/preview/export/import`, `events.dispatch/list/get`, `runs.list/get/resume/recover/retry/cancel`, `approvals.list/decide`, `artifacts.list/get`, `audit.list` and `summary`.

```bash
npm run build -w @apertureprism/review-automation
node scripts/review-automation.mjs --repository owner/repo --action summary
node scripts/review-automation.mjs --repository owner/repo --action rules.create --input rule.json
node scripts/review-automation.mjs --repository owner/repo --action rules.export --output rules.jsonl
```

Rule JSONL imports are fully validated before any rule is saved. `rules.import` accepts `{content:"..."}`. Local CLI runs with the data directory owner's authority and writes new output files without overwriting existing files.

Persistence uses Linux/WSL `util-linux flock`, file and directory `fsync`, and atomic replacement. Set `AUTOMATION_DATA_DIRECTORY` to an absolute directory outside the source tree; the API and CLI default to `~/.apertureprism/automation`. The host uses `WORKBENCH_DATA_DIRECTORY` for the same workbench data as review workers. Snapshot size is bounded and corrupt/version-mismatched files are rejected rather than silently replaced.
