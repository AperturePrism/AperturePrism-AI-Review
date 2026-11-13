import type { Automation } from "../../../packages/review-automation/src/types.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../../packages/database/src/client.js";
import {
  queueReviewWorkbenchSync,
  replayReviewWorkbenchSync,
  type ReviewWorkbench,
  type ReviewSyncInput,
} from "./workbench.js";

const url = process.env.APERTUREPRISM_INTEGRATION_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration("durable review workbench delivery", () => {
  let database: DatabaseClient;
  const taskIds: string[] = [];
  const input: ReviewSyncInput = {
    repository: "delivery-test/repository",
    reference: randomUUID(),
    pullNumber: 17,
    workerId: "delivery-test",
    review: {
      contractVersion: "pr-review/v1",
      summary: "A complete review",
      changedFileCount: 1,
      additions: 2,
      deletions: 1,
      overallTone: "comment",
      findings: [],
    },
  };

  beforeAll(() => {
    database = createDatabaseClient(url!);
  });
  afterAll(async () => {
    if (!database) return;
    for (const id of taskIds)
      await database.sql`delete from outbox_events where aggregate_id=${id}::uuid`;
    await database.close();
  });

  it("creates one durable message for repeated enqueue of the same attempt", async () => {
    const id = randomUUID();
    taskIds.push(id);
    await queueReviewWorkbenchSync(database.sql, id, {
      ...input,
      deliveryKey: `${id}:1`,
    });
    await queueReviewWorkbenchSync(database.sql, id, {
      ...input,
      deliveryKey: `${id}:1`,
    });
    const rows =
      await database.sql`select id from outbox_events where aggregate_id=${id}::uuid`;
    expect(rows).toHaveLength(1);
    const execute = vi.fn<ReviewWorkbench["execute"]>().mockResolvedValue({});
    const result = await replayReviewWorkbenchSync(database.sql, { execute });
    expect(result.delivered).toBe(1);
    expect(execute.mock.calls[0]![1].input.deliveryKey).toBe(`${id}:1`);
    const after = await replayReviewWorkbenchSync(database.sql, { execute });
    expect(after.delivered).toBe(0);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("leaves disk failures unacknowledged and retries after the delay", async () => {
    const id = randomUUID();
    taskIds.push(id);
    await queueReviewWorkbenchSync(database.sql, id, {
      ...input,
      deliveryKey: `${id}:1`,
    });
    const onError = vi.fn();
    const failure = await replayReviewWorkbenchSync(
      database.sql,
      {
        execute: async () => {
          throw new Error("disk unavailable");
        },
      },
      { retryDelayMs: 60_000, onError },
    );
    expect(failure).toEqual({ delivered: 0, deferred: 1 });
    expect(onError).toHaveBeenCalledTimes(1);
    const [message] =
      await database.sql`select published_at,available_at>now() as deferred from outbox_events where aggregate_id=${id}::uuid`;
    expect(message?.published_at).toBeNull();
    expect(message?.deferred).toBe(true);
    await database.sql`update outbox_events set available_at=now() where aggregate_id=${id}::uuid`;
    const recovered = await replayReviewWorkbenchSync(database.sql, {
      execute: async () => ({}),
    });
    expect(recovered.delivered).toBe(1);
  });

  it("keeps deliberate new attempts separate from redelivery", async () => {
    const id = randomUUID();
    taskIds.push(id);
    await queueReviewWorkbenchSync(database.sql, id, {
      ...input,
      deliveryKey: `${id}:1`,
    });
    await queueReviewWorkbenchSync(database.sql, id, {
      ...input,
      deliveryKey: `${id}:2`,
    });
    const rows =
      await database.sql`select id from outbox_events where aggregate_id=${id}::uuid`;
    expect(rows).toHaveLength(2);
    const execute = vi.fn<ReviewWorkbench["execute"]>().mockResolvedValue({});
    expect(
      (await replayReviewWorkbenchSync(database.sql, { execute })).delivered,
    ).toBe(2);
  });

  it("performs no writes after the shutdown signal was canceled", async () => {
    const execute = vi.fn<ReviewWorkbench["execute"]>();
    const result = await replayReviewWorkbenchSync(
      database.sql,
      { execute },
      { signal: AbortSignal.abort() },
    );
    expect(result).toEqual({ delivered: 0, deferred: 0 });
    expect(execute).not.toHaveBeenCalled();
  });
  it("replays a stable automation event after an action delivery failure", async () => {
    const id = randomUUID();
    taskIds.push(id);
    await queueReviewWorkbenchSync(database.sql, id, {
      ...input,
      deliveryKey: `${id}:attempt`,
    });
    const dispatch = vi
      .fn<Automation["execute"]>()
      .mockRejectedValueOnce(new Error("automation disk unavailable"))
      .mockResolvedValue({ runs: [] });
    const workbench: ReviewWorkbench = {
      execute: async () => ({ gate: { decision: "pass" } }),
    };
    expect(
      (
        await replayReviewWorkbenchSync(database.sql, workbench, {
          automation: { execute: dispatch },
        })
      ).deferred,
    ).toBe(1);
    await database.sql`update outbox_events set available_at=now() where aggregate_id=${id}::uuid`;
    expect(
      (
        await replayReviewWorkbenchSync(database.sql, workbench, {
          automation: { execute: dispatch },
        })
      ).delivered,
    ).toBe(1);
    expect(dispatch.mock.calls[0]![1]).toEqual(dispatch.mock.calls[1]![1]);
    expect(dispatch.mock.calls[0]![0].isAdmin).toBe(false);
    expect(
      await dispatch.mock.calls[0]![0].canAccessRepository(
        "different/repo",
        true,
      ),
    ).toBe(false);
  });

  it("acknowledges an ignored obsolete review without running automation", async () => {
    const id = randomUUID();
    taskIds.push(id);
    await queueReviewWorkbenchSync(database.sql, id, {
      ...input,
      deliveryKey: `${id}:old`,
    });
    const dispatch = vi.fn<Automation["execute"]>();
    const result = await replayReviewWorkbenchSync(
      database.sql,
      { execute: async () => ({ ignored: true }) },
      { automation: { execute: dispatch } },
    );
    expect(result.delivered).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
