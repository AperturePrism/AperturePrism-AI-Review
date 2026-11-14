import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// api 模块会在导入时读取环境与 localStorage，这里只关心页面行为，全部 mock。
vi.mock("../lib/api", () => ({
  bumpCache: vi.fn(),
  fetchRepositories: vi.fn(async () => ({ items: [], githubConfigured: true })),
  fetchRepositorySettings: vi.fn(async () => ({ items: [] })),
  fetchRepoSubjects: vi.fn(async () => []),
  saveRepositorySetting: vi.fn(async () => {}),
  syncRepositories: vi.fn(async () => ({
    status: "ok",
    installations: 0,
    synced: 0,
    errors: 0,
  })),
  triggerManualTask: vi.fn(async () => ({ taskId: "t", outcome: "created" })),
}));

import { ToastProvider } from "../components/Toast";

const { ReposPage } = await import("../pages/ReposPage");
const api = await import("../lib/api");

const fetchRepositories = vi.mocked(api.fetchRepositories);
const syncRepositories = vi.mocked(api.syncRepositories);

const REPO = {
  id: "repo-1",
  owner: "acme",
  name: "widget",
  fullName: "acme/widget",
  taskCount: 3,
  resultCount: 5,
  createdAt: "2026-08-24T00:00:00.000Z",
};

function renderPage() {
  return render(
    <ToastProvider>
      <ReposPage />
    </ToastProvider>,
  );
}

/**
 * 回归防护（#15）：点击「已安装仓库」后报错，根因之一是旧前端被浏览器缓存，
 * 且页面无法区分「GitHub App 没配」与「配了但还没有仓库」两种空态。
 * 这里锁定空态分级与同步错误的可读提示。
 */
describe("已安装仓库页（#15 收尾）", () => {
  beforeEach(() => {
    fetchRepositories.mockReset();
    syncRepositories.mockReset();
    vi.mocked(api.fetchRepoSubjects).mockReset().mockResolvedValue([]);
    fetchRepositories.mockResolvedValue({ items: [], githubConfigured: true });
    syncRepositories.mockResolvedValue({
      status: "ok",
      installations: 0,
      synced: 0,
      errors: 0,
    });
  });

  it("无 App 且无仓库 → 空态引导去「GitHub 接入」", async () => {
    fetchRepositories.mockResolvedValue({ items: [], githubConfigured: false });
    renderPage();
    expect(await screen.findByText("GitHub App 尚未配置")).toBeTruthy();
    const cta = screen.getByRole("link", { name: /前往 GitHub 接入/ });
    expect(cta.getAttribute("href")).toBe("#/github-access");
  });

  it("已配置 App 但还没有仓库 → 显示「暂无可追踪仓库」而不是引导配置", async () => {
    fetchRepositories.mockResolvedValue({ items: [], githubConfigured: true });
    renderPage();
    expect(await screen.findByText("暂无可追踪仓库")).toBeTruthy();
    expect(screen.queryByText("GitHub App 尚未配置")).toBeNull();
  });

  it("有仓库 → 渲染仓库卡片与任务/结果计数", async () => {
    fetchRepositories.mockResolvedValue({
      items: [REPO],
      githubConfigured: true,
    });
    renderPage();
    expect(await screen.findByText("widget")).toBeTruthy();
    expect(screen.getByText("· acme")).toBeTruthy();
    expect(screen.getByText("3 任务")).toBeTruthy();
    expect(screen.getByText("5 结果")).toBeTruthy();
  });

  it("多选支持全选/清空，切换类型和仓库立即清除旧选择", async () => {
    const other = { ...REPO, id: "repo-2", owner: "other", fullName: "other/widget" };
    fetchRepositories.mockResolvedValue({ items: [REPO, other], githubConfigured: true });
    vi.mocked(api.fetchRepoSubjects).mockImplementation(async (repository, type) => repository === REPO.fullName ? (type === "issue" ? [{ number: 1, title: "Issue 1" }, { number: 2, title: "Issue 2" }] : [{ number: 3, title: "PR 3" }, { number: 4, title: "PR 4" }]) : [{ number: 5, title: "另一仓库" }]);
    const user = userEvent.setup();
    renderPage();
    await user.selectOptions(await screen.findByRole("combobox", { name: "审查仓库" }), REPO.fullName);
    await screen.findByRole("checkbox", { name: "选择 Issue #1" });
    await user.click(screen.getByRole("button", { name: "选择当前列表" }));
    expect(screen.getByRole("button", { name: "审查选中的 2 项" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "清空选择" }));
    expect(screen.getByRole("button", { name: "审查选中的 0 项" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "选择 Issue #1" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "审查对象类型" }), "pr");
    expect(await screen.findByRole("checkbox", { name: "选择 PR #3" })).not.toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "选择 Issue #1" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "选择当前列表" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "审查仓库" }), other.fullName);
    expect(await screen.findByRole("checkbox", { name: "选择 PR #5" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "审查选中的 0 项" })).toBeDisabled();
  });

  it("同步失败且带原因 → toast 显示可读解释（机器码翻译）", async () => {
    fetchRepositories.mockResolvedValue({ items: [], githubConfigured: true });
    syncRepositories.mockResolvedValue({
      status: "ok",
      installations: 1,
      synced: 0,
      errors: 1,
      details: [{ installationId: "1", reason: "rate_limited" }],
    });
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: /^同步仓库$/ }),
    );
    expect(await screen.findByText(/已触发 GitHub 接口限流/)).toBeTruthy();
  });

  it("同步已在进行的 409 → toast 提示「正在同步中」而非静默 0 结果", async () => {
    fetchRepositories.mockResolvedValue({ items: [], githubConfigured: true });
    syncRepositories.mockRejectedValue(new Error("sync_in_progress"));
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: /^同步仓库$/ }),
    );
    expect(await screen.findByText(/已有一次仓库同步正在进行中/)).toBeTruthy();
  });

  it.each([
    {
      outcome: "requeued" as const,
      taskStatus: "queued",
      message: "已重新入队",
    },
    {
      outcome: "duplicate" as const,
      taskStatus: "running",
      message: "任务已在队列或执行中",
    },
    {
      outcome: "duplicate" as const,
      taskStatus: "completed",
      message: "该版本已审核完成",
    },
  ])(
    "手动重审显示 $outcome / $taskStatus 的真实结果",
    async ({ outcome, taskStatus, message }) => {
      fetchRepositories.mockResolvedValue({
        items: [REPO],
        githubConfigured: true,
      });
      vi.mocked(api.triggerManualTask).mockResolvedValueOnce({
        status: "ok",
        taskId: "task-1",
        outcome,
        taskStatus,
      });
      const user = userEvent.setup();
      renderPage();
      await screen.findByText("widget");
      const selectors = screen.getAllByRole("combobox");
      await user.selectOptions(selectors[0]!, REPO.fullName);
      await user.selectOptions(selectors[1]!, "pr");
      await user.type(screen.getByPlaceholderText("编号，如 12"), "40");
      await user.click(screen.getByRole("button", { name: "触发分析" }));
      expect(await screen.findByText(new RegExp(message))).toBeTruthy();
      expect(api.triggerManualTask).toHaveBeenCalledWith({
        type: "pr",
        repositoryFullName: REPO.fullName,
        subjectNumber: 40,
      });
    },
  );
});
