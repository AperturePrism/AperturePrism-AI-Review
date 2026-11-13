import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({
  applyUpdate: vi.fn(),
  fetchUpdateProgress: vi.fn(),
  fetchUpdateStatus: vi.fn(),
}));
vi.mock("../components/Toast", () => ({ useToast: () => toast }));

import { UpdatePanel } from "../components/UpdatePanel";
import * as api from "../lib/api";
import type { UpdateHistoryEntry, UpdateProgress, UpdateStatus } from "../lib/api";

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
const applyUpdate = vi.mocked(api.applyUpdate);
const fetchProgress = vi.mocked(api.fetchUpdateProgress);
const fetchStatus = vi.mocked(api.fetchUpdateStatus);
const previous = "1.2.15";
const target = "v1.2.17";
const now = new Date("2026-11-13T10:00:00Z");

function status(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    current: { version: previous, composeProject: "test" },
    latest: { version: target, tags: [target], digest: "sha256:new", source: "ghcr.io", stale: false },
    updateAvailable: true,
    updateChannel: "latest",
    inProgress: false,
    ...overrides,
  };
}

function entry(state: UpdateHistoryEntry["status"] = "pending", id = "attempt-new"): UpdateHistoryEntry {
  return { at: now.toISOString(), from: previous, to: target, ok: state !== "failed", id, status: state };
}

function progress(items: UpdateHistoryEntry[] = [], currentVersion = previous, inProgress = false): UpdateProgress {
  return { items, currentVersion, inProgress };
}

function stream(events: string[], disconnect = false): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < events.length) controller.enqueue(new TextEncoder().encode(events[index++]));
      else if (disconnect) controller.error(new Error("socket closed"));
      else controller.close();
    },
  });
}

const event = (name: string, data: Record<string, unknown>) =>
  `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const started = event("started", { id: "attempt-new", previous, target });
const done = event("done", { ok: true, previous, applied: target, restartPending: true });
const log = event("log", { level: "info", message: "pulling exact target" });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}

async function mount() {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<UpdatePanel />); });
  return view;
}

async function update() {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "更新到最新" })); });
}

async function advance(ms = 3_000) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.clearAllMocks();
  applyUpdate.mockReset();
  fetchProgress.mockReset();
  fetchStatus.mockReset();
  fetchStatus.mockResolvedValue(status());
  fetchProgress.mockResolvedValue(progress());
  applyUpdate.mockImplementation(async () => stream([started, log, done]));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("truthful online update confirmation", () => {
  it("pins the exact tag and requires the observed runtime, even after done and historical success", async () => {
    fetchProgress.mockResolvedValueOnce(progress()).mockResolvedValue(progress([entry("success")], previous, false));
    await mount();
    await update();
    expect(applyUpdate).toHaveBeenCalledWith(target, true, expect.any(AbortSignal));
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "确认运行版本中…" })).toBeDisabled();
    await advance(9_000);
    expect(toast.success).not.toHaveBeenCalled();
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    fetchProgress.mockResolvedValue(progress([entry("success")], "1.2.17", false));
    await advance();
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/已确认运行版本：1\.2\.17。更新成功/)).toBeInTheDocument();
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByText("[info] pulling exact target")).toBeInTheDocument();
    const requests = fetchProgress.mock.calls.length;
    await advance(30_000);
    expect(fetchProgress).toHaveBeenCalledTimes(requests);
    expect(applyUpdate).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/自动刷新/)).toBeNull();
  });

  it("disables reapply while refreshed registry metadata is still pending after runtime confirmation", async () => {
    const registry = deferred<UpdateStatus>();
    fetchStatus.mockResolvedValueOnce(status()).mockReturnValue(registry.promise);
    fetchProgress.mockResolvedValueOnce(progress()).mockResolvedValue(progress([entry("success")], "1.2.17", false));
    await mount();
    await update();
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "更新到最新" })).toBeDisabled();
    expect(screen.queryByText("发现新版本，可更新")).toBeNull();
    await act(async () => { registry.resolve(status({ current: { version: "1.2.17", composeProject: "test" }, updateAvailable: false })); });
    expect(screen.getByRole("button", { name: "更新到最新" })).toBeDisabled();
    expect(screen.getByText("已是最新版本")).toBeInTheDocument();
    expect(applyUpdate).toHaveBeenCalledTimes(1);
  });

  it.each(["eof", "disconnect", "no-body"])("does not turn %s with the old runtime into success", async (ending) => {
    applyUpdate.mockImplementation(async () => ending === "no-body" ? null : stream([started, log], ending === "disconnect"));
    fetchProgress.mockResolvedValueOnce(progress()).mockResolvedValue(progress([entry()], previous, true));
    await mount();
    await update();
    await advance(9_000);
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "确认运行版本中…" })).toBeDisabled();
    expect(applyUpdate).toHaveBeenCalledTimes(1);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    if (ending === "disconnect") expect(toast.info).toHaveBeenCalledWith(expect.stringContaining("连接已中断"));
  });

  it("retries a progress 503 during restart and confirms the subsequent new runtime", async () => {
    fetchProgress.mockResolvedValueOnce(progress()).mockRejectedValueOnce(new Error("request failed with 503"))
      .mockResolvedValue(progress([entry("success")], "1.2.17", false));
    await mount();
    await update();
    expect(screen.getByText(/服务暂时不可达/)).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    await advance();
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(applyUpdate).toHaveBeenCalledTimes(1);
  });

  it("shows an explicit persisted failure and retains the detailed logs", async () => {
    fetchProgress.mockResolvedValueOnce(progress()).mockResolvedValue(progress([{ ...entry("failed"), reason: "confirmation_timeout" }], "1.2.17", false));
    await mount();
    await update();
    expect(toast.error).toHaveBeenCalledWith("更新失败：confirmation_timeout");
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByText(/更新失败：confirmation_timeout。/)).toBeInTheDocument();
    expect(screen.getByText("[info] pulling exact target")).toBeInTheDocument();
    expect(screen.getByText(/查看详细日志/)).toBeInTheDocument();
    const requests = fetchProgress.mock.calls.length;
    await advance(9_000);
    expect(fetchProgress).toHaveBeenCalledTimes(requests);
  });

  it("shows an SSE failure without hiding logs or waiting for EOF", async () => {
    applyUpdate.mockImplementation(async () => stream([started, log, event("done", { ok: false, reason: "pull_failed" })]));
    await mount();
    await update();
    expect(toast.error).toHaveBeenCalledWith("更新失败：pull_failed");
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByText("[info] pulling exact target")).toBeInTheDocument();
    expect(fetchProgress).toHaveBeenCalledTimes(1);
  });

  it.each(["running", "pending"] as const)("recovers a persisted %s attempt without repeating apply", async (state) => {
    fetchProgress.mockResolvedValue(progress([entry(state)], previous, true));
    await mount();
    expect(screen.getByRole("button", { name: "确认运行版本中…" })).toBeDisabled();
    expect(screen.getByText(state === "running" ? "执行中" : "等待确认")).toBeInTheDocument();
    expect(applyUpdate).not.toHaveBeenCalled();
    fetchProgress.mockResolvedValue(progress([entry("success")], "1.2.17", false));
    await advance();
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(applyUpdate).not.toHaveBeenCalled();
  });

  it("ignores a matching-version success belonging to a different id", async () => {
    fetchProgress.mockResolvedValueOnce(progress()).mockResolvedValue(progress([entry("success", "attempt-old")], "1.2.17", false));
    await mount();
    await update();
    await advance(9_000);
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "确认运行版本中…" })).toBeDisabled();
  });

  it("does not bind old matching history when started was lost", async () => {
    const old = { ...entry("failed", "attempt-old"), at: "2026-11-12T00:00:00Z", reason: "old_failure" };
    applyUpdate.mockImplementation(async () => stream([log]));
    fetchProgress.mockResolvedValue(progress([old], previous, false));
    await mount();
    await update();
    await advance(9_000);
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    fetchProgress.mockResolvedValue(progress([entry("success"), old], "1.2.17", false));
    await advance();
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("does not accept an older API's ok history without progress metadata", async () => {
    fetchProgress.mockResolvedValueOnce(progress()).mockResolvedValue({ items: [{ at: now.toISOString(), from: previous, to: target, ok: true }] });
    await mount();
    await update();
    await advance(9_000);
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByText(/未提供完整的运行版本确认信息/)).toBeInTheDocument();
    expect(screen.getByText("脚本完成（未验证）")).toBeInTheDocument();
  });

  it("bounds verification, preserves logs, and resumes manually without reapplying", async () => {
    fetchProgress.mockResolvedValueOnce(progress()).mockResolvedValue(progress([entry()], previous, true));
    await mount();
    await update();
    await advance(180_000);
    expect(screen.getByText(/等待运行版本确认超时/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更新到最新" })).toBeDisabled();
    expect(screen.getByText("[info] pulling exact target")).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    const requests = fetchProgress.mock.calls.length;
    await advance(9_000);
    expect(fetchProgress).toHaveBeenCalledTimes(requests);
    fetchProgress.mockResolvedValue(progress([entry("success")], "1.2.17", false));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "手动确认更新" })); });
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(applyUpdate).toHaveBeenCalledTimes(1);
  });

  it("does not overlap slow progress reads and aborts/ignores a late result on unmount", async () => {
    const pending = deferred<UpdateProgress>();
    fetchProgress.mockResolvedValueOnce(progress()).mockReturnValue(pending.promise);
    const view = await mount();
    await update();
    await advance(9_000);
    expect(fetchProgress).toHaveBeenCalledTimes(2);
    const signal = fetchProgress.mock.calls[1]?.[0];
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => { pending.resolve(progress([entry("success")], "1.2.17", false)); });
    await advance(180_000);
    expect(toast.success).not.toHaveBeenCalled();
    expect(fetchProgress).toHaveBeenCalledTimes(2);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it("cancels an open stream and never restarts confirmation after unmount", async () => {
    const cancel = vi.fn();
    applyUpdate.mockResolvedValue(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(started + log)); },
      cancel,
    }));
    const view = await mount();
    await update();
    expect(screen.getByRole("button", { name: "更新中…" })).toBeDisabled();
    view.unmount();
    await advance(180_000);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(applyUpdate.mock.calls[0]?.[2]?.aborted).toBe(true);
    expect(fetchProgress).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("reports the actual connection establishment error without pretending to verify", async () => {
    applyUpdate.mockRejectedValue(new Error("update apply 403"));
    await mount();
    await update();
    expect(toast.error).toHaveBeenCalledWith("update apply 403");
    expect(screen.queryByRole("button", { name: "确认运行版本中…" })).toBeNull();
    expect(fetchProgress).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("registry metadata truthfulness", () => {
  it.each(["stale", "null", "unknown-runtime", "unknown-source", "no-tag", "degraded"])("does not claim latest for %s metadata", async (kind) => {
    const next = status({ updateAvailable: false });
    if (kind === "stale") { next.latest.stale = true; next.latest.source = "mirror.example"; }
    if (kind === "null") next.updateAvailable = null;
    if (kind === "unknown-runtime") { next.current.version = "unknown"; fetchProgress.mockResolvedValue(progress([], "unknown")); }
    if (kind === "unknown-source") { delete next.latest.source; delete next.latest.stale; }
    if (kind === "no-tag") next.latest.version = null;
    if (kind === "degraded") next.degraded = true;
    fetchStatus.mockResolvedValue(next);
    await mount();
    expect(screen.getByText(/最新版本未知/)).toBeInTheDocument();
    expect(screen.queryByText("已是最新版本")).toBeNull();
    expect(screen.getByRole("button", { name: "更新到最新" })).toBeDisabled();
    expect(screen.queryByTitle("已是最新版本，无需更新")).toBeNull();
  });

  it("invalidates previously good metadata when a manual registry check fails", async () => {
    fetchStatus.mockResolvedValueOnce(status({ updateAvailable: false })).mockRejectedValue(new Error("registry_unreachable"));
    await mount();
    expect(screen.getByText("已是最新版本")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "检查更新" })); });
    expect(screen.queryByText("已是最新版本")).toBeNull();
    expect(screen.getByText(/最新版本未知/)).toBeInTheDocument();
  });
});
