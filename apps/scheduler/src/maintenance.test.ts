import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMaintenance,
  maintenanceHealth,
  waitForMaintenance,
  type MaintenanceEvent,
} from "./maintenance.js";

afterEach(() => vi.useRealTimers());

describe("independent maintenance jobs", () => {
  it("runs due jobs immediately and schedules the next period from completion", async () => {
    let now = 1_000;
    const run = vi.fn(async () => {
      now = 1_500;
      return 2;
    });
    const maintenance = createMaintenance({
      now: () => now,
      jobs: [{ name: "leases", intervalMs: 10_000, run }],
    });
    await maintenance.tick();
    await maintenance.drain();
    expect(run).toHaveBeenCalledOnce();
    expect(maintenance.snapshot()[0]).toMatchObject({
      runs: 1,
      successes: 1,
      failures: 0,
      lastDurationMs: 500,
      nextRunAt: 11_500,
    });
    now = 11_499;
    await maintenance.tick();
    expect(run).toHaveBeenCalledOnce();
    now = 11_500;
    await maintenance.tick();
    await maintenance.drain();
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("prevents overlapping slow jobs while letting independent maintenance finish", async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    let now = 1_000;
    const leases = vi.fn(async () => 1);
    const events: MaintenanceEvent[] = [];
    const maintenance = createMaintenance({
      now: () => now,
      onEvent: (event) => events.push(event),
      jobs: [
        { name: "memory", intervalMs: 10_000, run: () => slow },
        { name: "leases", intervalMs: 10_000, run: leases },
      ],
    });
    await maintenance.tick();
    await vi.waitFor(() =>
      expect(
        maintenance.snapshot().find((state) => state.name === "leases")
          ?.running,
      ).toBe(false),
    );
    now = 20_000;
    await maintenance.tick();
    expect(
      maintenance.snapshot().find((state) => state.name === "memory"),
    ).toMatchObject({ running: true, runs: 1, overlapsPrevented: 1 });
    expect(leases).toHaveBeenCalledTimes(2);
    release();
    await maintenance.drain();
    expect(events).toContainEqual(
      expect.objectContaining({ type: "overlap_prevented", name: "memory" }),
    );
  });
  it("records job failures without rejecting tick or blocking other jobs", async () => {
    const good = vi.fn(async () => 1);
    const maintenance = createMaintenance({
      jobs: [
        {
          name: "broken",
          intervalMs: 1,
          run: async () => {
            throw new TypeError("contains sensitive upstream body");
          },
        },
        { name: "good", intervalMs: 1, run: good },
      ],
    });
    await maintenance.tick();
    await maintenance.drain();
    expect(good).toHaveBeenCalledOnce();
    expect(maintenance.snapshot()[0]).toMatchObject({
      failures: 1,
      running: false,
      lastError: "TypeError",
    });
    expect(JSON.stringify(maintenance.snapshot())).not.toContain("sensitive");
    expect(maintenanceHealth(maintenance.snapshot())).toMatchObject({
      healthy: false,
      failing: ["broken"],
    });
  });
  it("clears a previous failure after the job recovers", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(1);
    const maintenance = createMaintenance({
      jobs: [{ name: "job", intervalMs: 100, run }],
    });
    await maintenance.run("job");
    await maintenance.drain();
    await maintenance.run("job");
    await maintenance.drain();
    expect(maintenance.snapshot()[0]).toMatchObject({
      failures: 1,
      successes: 1,
      lastError: null,
    });
  });
  it("does not let a broken observer strand job state", async () => {
    const maintenance = createMaintenance({
      onEvent: () => {
        throw new Error("observer failed");
      },
      jobs: [{ name: "job", intervalMs: 1, run: async () => 1 }],
    });
    await maintenance.tick();
    await maintenance.drain();
    expect(maintenance.snapshot()[0]).toMatchObject({
      running: false,
      successes: 1,
    });
  });
  it("waits for cancellation-aware jobs before stop resolves", async () => {
    let ended = false;
    const maintenance = createMaintenance({
      jobs: [
        {
          name: "job",
          intervalMs: 10,
          run: async (signal) => {
            await waitForMaintenance(100_000, signal);
            ended = true;
          },
        },
      ],
    });
    await maintenance.tick();
    await maintenance.stop();
    expect(ended).toBe(true);
    expect(maintenance.signal.aborted).toBe(true);
    expect(await maintenance.run("job")).toBe(false);
  });
  it("supports a delayed first run", async () => {
    let now = 1_000;
    const run = vi.fn(async () => 1);
    const maintenance = createMaintenance({
      now: () => now,
      jobs: [{ name: "job", intervalMs: 100, immediately: false, run }],
    });
    await maintenance.tick();
    expect(run).not.toHaveBeenCalled();
    now = 1_100;
    await maintenance.tick();
    await maintenance.drain();
    expect(run).toHaveBeenCalledOnce();
  });
  it("copies snapshots rather than exposing mutable state", async () => {
    const maintenance = createMaintenance({
      jobs: [{ name: "job", intervalMs: 100, run: async () => 1 }],
    });
    maintenance.snapshot()[0]!.runs = 99;
    expect(maintenance.snapshot()[0]?.runs).toBe(0);
    await expect(maintenance.run("unknown")).rejects.toThrow("unknown");
  });
  it("rejects duplicate job names and invalid periods", () => {
    expect(() =>
      createMaintenance({
        jobs: [{ name: "job", intervalMs: 0, run: async () => 1 }],
      }),
    ).toThrow();
    const job = { name: "job", intervalMs: 10, run: async () => 1 };
    expect(() => createMaintenance({ jobs: [job, job] })).toThrow();
  });
});

describe("cancelable maintenance waits", () => {
  it("completes on time and removes its signal listener", async () => {
    vi.useFakeTimers();
    const signal = new AbortController().signal;
    const remove = vi.spyOn(signal, "removeEventListener");
    const promise = waitForMaintenance(100, signal);
    await vi.advanceTimersByTimeAsync(100);
    await promise;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
  it("does not create a timer after cancellation", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    await waitForMaintenance(100_000, controller.signal);
    expect(vi.getTimerCount()).toBe(0);
  });
});
