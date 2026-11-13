import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({
  cancelTasks: vi.fn(async () => ({ status: "ok", canceled: 1, skipped: 0 })),
  fetchTaskCheckRun: vi.fn(async () => ({ present: false })),
  fetchTaskDetail: vi.fn(async () => null),
  rerunTasks: vi.fn(async () => ({ status: "ok", rerun: 1, skipped: 0 })),
}));

import { ToastProvider } from "../components/Toast";
import type { CheckRunStatus, TaskCheckRunResult, TaskDetail } from "../lib/api";
const { TaskDetailPage } = await import("../pages/TaskDetailPage");
const api = await import("../lib/api");

const fetchTaskDetail = vi.mocked(api.fetchTaskDetail);
const fetchTaskCheckRun = vi.mocked(api.fetchTaskCheckRun);
const cancelTasks = vi.mocked(api.cancelTasks);

function detail(status: string): TaskDetail {
  return {
    id: "task-1",
    taskType: "issue_analysis",
    repositoryId: "repo-1",
    subjectNumber: 7,
    subjectRevision: "rev",
    policyVersion: "issue-analysis-v1",
    status,
    priority: 0,
    attemptCount: 1,
    maxAttempts: 3,
    lastErrorCategory: null,
    createdAt: "2026-08-21T10:00:00Z",
    updatedAt: "2026-08-21T10:00:00Z",
    payload: { repositoryFullName: "acme/widget", subjectNumber: 7 },
    timeline: [],
    attempts: [],
    publications: [],
  };
}

function checkRunDetail(status: string, id = "task-1"): TaskDetail {
  return {
    ...detail(status),
    id,
    taskType: "pr_review",
    publications: [{
      channel: "check_run",
      externalObjectId: "101",
      createdAt: "2026-08-21T10:00:00Z",
    }],
  };
}

function checkRunResult(status: CheckRunStatus["status"]): TaskCheckRunResult {
  return {
    status: "ok",
    present: true,
    checkRun: {
      id: 101,
      status,
      conclusion: status === "completed" ? "success" : null,
      title: null,
      htmlUrl: null,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}

function renderPage(id = "task-1") {
  return render(
    <ToastProvider>
      <TaskDetailPage id={id} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  fetchTaskDetail.mockReset();
  fetchTaskCheckRun.mockReset();
  fetchTaskCheckRun.mockResolvedValue({ status: "ok", present: false });
  cancelTasks.mockReset();
  cancelTasks.mockResolvedValue({ status: "ok", canceled: 1, skipped: 0 });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Check Run reconciliation polling", () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it.each(["completed", "failed", "canceled"])(
    "keeps polling a %s task's pending Check Run until completion",
    async (status) => {
      fetchTaskDetail.mockResolvedValue(checkRunDetail(status));
      fetchTaskCheckRun
        .mockResolvedValueOnce(checkRunResult("in_progress"))
        .mockResolvedValue(checkRunResult("completed"));
      await act(async () => { renderPage(); });

      expect(screen.getByText("进行中…")).toBeTruthy();
      expect(fetchTaskCheckRun).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(screen.getByText("已完成 · 成功")).toBeTruthy();
      expect(fetchTaskCheckRun).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(fetchTaskCheckRun).toHaveBeenCalledTimes(2);
    },
  );

  it("does not repeat queries for an already completed terminal Check Run", async () => {
    fetchTaskDetail.mockResolvedValue(checkRunDetail("completed"));
    fetchTaskCheckRun.mockResolvedValue(checkRunResult("completed"));
    await act(async () => { renderPage(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(fetchTaskCheckRun.mock.calls).toEqual([["task-1"]]);
  });

  it("retries a degraded terminal read without overlapping slow requests", async () => {
    const pending = deferred<TaskCheckRunResult>();
    fetchTaskDetail.mockResolvedValue(checkRunDetail("completed"));
    fetchTaskCheckRun
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ status: "ok", present: false, degraded: true })
      .mockResolvedValue(checkRunResult("completed"));
    await act(async () => { renderPage(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(fetchTaskCheckRun).toHaveBeenCalledTimes(1);

    await act(async () => { pending.resolve(checkRunResult("in_progress")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByText("状态获取失败（GitHub 不可达或未配置）")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByText("已完成 · 成功")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(fetchTaskCheckRun).toHaveBeenCalledTimes(3);
  });

  it("ignores the prior task's late Check Run response after navigation", async () => {
    const oldCheck = deferred<TaskCheckRunResult>();
    fetchTaskDetail.mockResolvedValueOnce(checkRunDetail("completed"))
      .mockResolvedValue(checkRunDetail("completed", "task-2"));
    fetchTaskCheckRun.mockReturnValueOnce(oldCheck.promise)
      .mockResolvedValue(checkRunResult("completed"));
    let view!: ReturnType<typeof renderPage>;
    await act(async () => { view = renderPage(); });
    await act(async () => {
      view.rerender(<ToastProvider><TaskDetailPage id="task-2" /></ToastProvider>);
    });
    expect(screen.getByText("已完成 · 成功")).toBeTruthy();
    await act(async () => { oldCheck.resolve(checkRunResult("in_progress")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

    expect(screen.queryByText("进行中…")).toBeNull();
    expect(fetchTaskCheckRun.mock.calls).toEqual([["task-1"], ["task-2"]]);
  });

  it("ignores the prior task's late detail response after navigation", async () => {
    const oldDetail = deferred<TaskDetail>();
    fetchTaskDetail.mockReturnValueOnce(oldDetail.promise)
      .mockResolvedValue(checkRunDetail("completed", "task-2"));
    fetchTaskCheckRun.mockResolvedValue(checkRunResult("completed"));
    let view!: ReturnType<typeof renderPage>;
    await act(async () => { view = renderPage(); });
    await act(async () => {
      view.rerender(<ToastProvider><TaskDetailPage id="task-2" /></ToastProvider>);
    });
    await act(async () => { oldDetail.resolve(checkRunDetail("running")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

    expect(screen.queryByRole("button", { name: "取消任务" })).toBeNull();
    expect(fetchTaskCheckRun.mock.calls).toEqual([["task-2"]]);
  });

  it("does not restart polling when a pending request resolves after unmount", async () => {
    const pending = deferred<TaskCheckRunResult>();
    fetchTaskDetail.mockResolvedValue(checkRunDetail("completed"));
    fetchTaskCheckRun.mockReturnValue(pending.promise);
    let view!: ReturnType<typeof renderPage>;
    await act(async () => { view = renderPage(); });
    view.unmount();
    await act(async () => { pending.resolve(checkRunResult("in_progress")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(fetchTaskCheckRun).toHaveBeenCalledTimes(1);
  });
});

describe("任务详情页取消按钮", () => {
  it("运行中任务显示「取消任务」按钮，点击后调用 cancelTasks", async () => {
    fetchTaskDetail.mockResolvedValue(detail("running"));
    renderPage();
    const cancelButton = await screen.findByRole("button", { name: "取消任务" });
    await act(async () => { await userEvent.click(cancelButton); });
    expect(cancelTasks).toHaveBeenCalledWith(["task-1"]);
    expect(await screen.findByText(/已取消任务/)).toBeTruthy();
  });

  it("排队任务也可取消", async () => {
    fetchTaskDetail.mockResolvedValue(detail("queued"));
    renderPage();
    expect(
      await screen.findByRole("button", { name: "取消任务" }),
    ).toBeTruthy();
  });

  it("已完成任务既不显示取消也不显示重新入队", async () => {
    fetchTaskDetail.mockResolvedValue(detail("completed"));
    renderPage();
    await screen.findByText("任务信息");
    expect(screen.queryByRole("button", { name: "取消任务" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重新入队" })).toBeNull();
  });

  it("失败任务只显示「重新入队」，不显示取消", async () => {
    fetchTaskDetail.mockResolvedValue(detail("failed"));
    renderPage();
    await screen.findByText("任务信息");
    expect(
      await screen.findByRole("button", { name: "重新入队" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "取消任务" })).toBeNull();
  });
});
