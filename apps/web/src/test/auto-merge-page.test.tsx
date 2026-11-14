import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoMergePanel } from "../components/AutoMergePanel";
import { ToastProvider } from "../components/Toast";
import { ReposPage } from "../pages/ReposPage";
import { bumpCache } from "../lib/api/http";
import type { AutoMergeItem, AutoMergeSettings } from "../lib/api/auto-merge";
import type { Repository, RepositorySettingItem } from "../lib/api/repository";

const repo: Repository = {
  id: "repo-1",
  owner: "acme",
  name: "widget",
  fullName: "acme/widget",
  taskCount: 1,
  resultCount: 1,
  createdAt: "2026-11-13T00:00:00Z",
};
const fetchMock = vi.fn<typeof fetch>();
let canManage: boolean;
let historyFailure: boolean;
let saveFailure: boolean;
let settingsItems: RepositorySettingItem[];
let historyItems: AutoMergeItem[];
let saved: AutoMergeSettings[];

function setting(
  key: string,
  value: string,
  overridden = true,
  globalValue = "",
): RepositorySettingItem {
  return {
    key,
    value,
    overridden,
    globalValue,
    defaultValue: "",
    label: key,
    hint: "",
    kind: "string",
    secret: false,
  };
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function mountPanel() {
  return render(<AutoMergePanel repo={repo} onClose={vi.fn()} />);
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("apertureprism.token", "test-session");
  bumpCache();
  canManage = true;
  historyFailure = false;
  saveFailure = false;
  saved = [];
  historyItems = [];
  settingsItems = [
    setting("pr_auto_merge_enabled", "false"),
    setting("pr_auto_merge_method", "squash"),
    setting("pr_auto_merge_required_checks", "[]"),
  ];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/repositories")
      return json({ items: [repo], githubConfigured: true });
    if (url === "/repositories/repo-1/settings")
      return json({ repository: repo, items: settingsItems });
    if (url === "/repositories/repo-1/auto-merge?limit=20")
      return historyFailure
        ? json({ reason: "storage_unavailable" }, 503)
        : json({ items: historyItems, canManage });
    if (
      url === "/repositories/repo-1/auto-merge/settings" &&
      init?.method === "PUT"
    ) {
      if (saveFailure)
        return json(
          {
            reason: "repository_manage_required",
            message: "需要本仓库管理权限",
          },
          403,
        );
      const value = JSON.parse(String(init.body)) as AutoMergeSettings;
      saved.push(value);
      return json({ status: "ok", settings: value });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("检查通过自动合并：页面到真实 API 绑定", () => {
  it("从已安装仓库打开配置，默认关闭且不沿用全局开启值", async () => {
    settingsItems = [setting("pr_auto_merge_enabled", "", false, "true")];
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <ReposPage />
      </ToastProvider>,
    );
    await user.click(
      await screen.findByRole("button", { name: "检查通过自动合并" }),
    );
    expect(
      await screen.findByRole("heading", { name: "检查通过自动合并" }),
    ).toBeInTheDocument();
    const enabled = await screen.findByRole("checkbox", {
      name: "在本仓库开启检查通过自动合并",
    });
    expect(enabled).not.toBeChecked();
    expect(screen.getByRole("combobox", { name: "合并方式" })).toHaveValue(
      "squash",
    );
    expect(screen.getByText("尚无自动合并记录")).toBeInTheDocument();
    expect(saved).toEqual([]);
  });

  it("一次原子保存开关、合并方式与准确检查名，保留名称中的逗号", async () => {
    const user = userEvent.setup();
    mountPanel();
    const enabled = await screen.findByRole("checkbox", {
      name: "在本仓库开启检查通过自动合并",
    });
    await user.click(enabled);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "合并方式" }),
      "rebase",
    );
    await user.type(
      screen.getByRole("textbox", { name: "必须通过的检查名称" }),
      "build\nCI (node, linux)\nbuild",
    );
    await user.click(screen.getByRole("button", { name: "保存自动合并配置" }));
    await screen.findByRole("status");
    expect(saved).toEqual([
      {
        enabled: true,
        method: "rebase",
        requiredChecks: ["build", "CI (node, linux)"],
      },
    ]);
    const writes = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === "PUT",
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[1]?.headers).toEqual(
      expect.objectContaining({ authorization: "Bearer test-session" }),
    );
    expect(
      screen.getByRole("textbox", { name: "必须通过的检查名称" }),
    ).toHaveValue("build\nCI (node, linux)");
    expect(await screen.findByText(/已开启本仓库自动合并/)).toBeInTheDocument();
  });

  it("读取 JSON 数组配置时不会把含逗号的检查名称拆开", async () => {
    settingsItems = [
      setting("pr_auto_merge_enabled", "true"),
      setting("pr_auto_merge_method", "merge"),
      setting(
        "pr_auto_merge_required_checks",
        '["CI (node, linux)","unit tests"]',
      ),
    ];
    mountPanel();
    expect(
      await screen.findByRole("checkbox", {
        name: "在本仓库开启检查通过自动合并",
      }),
    ).toBeChecked();
    expect(
      screen.getByRole("textbox", { name: "必须通过的检查名称" }),
    ).toHaveValue("CI (node, linux)\nunit tests");
  });

  it("只有查看权限时可读全部执行状态，但没有保存操作", async () => {
    canManage = false;
    historyItems = (
      ["pending", "waiting", "blocked", "merged", "canceled"] as const
    ).map((status, index) => ({
      id: `merge-${index}`,
      taskId: `task-${index}`,
      pullNumber: index + 10,
      headSha: "a".repeat(40),
      method: "squash",
      status,
      reason: "checks_pending",
      message: status === "merged" ? "GitHub 已合并" : "等待 GitHub 检查完成",
      mergeCommitSha: status === "merged" ? "b".repeat(40) : null,
      attempts: 1,
      nextAttemptAt: "2026-11-13T02:00:00Z",
      createdAt: "2026-11-13T01:00:00Z",
      updatedAt: "2026-11-13T02:00:00Z",
      completedAt: null,
    }));
    mountPanel();
    expect(
      await screen.findByRole("checkbox", {
        name: "在本仓库开启检查通过自动合并",
      }),
    ).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "合并方式" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "保存自动合并配置" }),
    ).not.toBeInTheDocument();
    for (const label of [
      "等待调度",
      "等待检查",
      "暂不能合并",
      "已合并",
      "已取消",
    ])
      expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "#13" })).toHaveAttribute(
      "href",
      "https://github.com/acme/widget/pull/13",
    );
    expect(
      screen.getByRole("link", { name: /合并提交 bbbbbbbbbbbb/ }),
    ).toHaveAttribute(
      "href",
      `https://github.com/acme/widget/commit/${"b".repeat(40)}`,
    );
    expect(saved).toEqual([]);
  });

  it("记录读取失败明确显示错误，不能伪装空态或允许配置保存", async () => {
    historyFailure = true;
    mountPanel();
    expect(await screen.findByText(/无法读取执行记录/)).toBeInTheDocument();
    expect(screen.queryByText("尚无自动合并记录")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "保存自动合并配置" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    historyFailure = false;
    await userEvent.click(
      within(
        screen.getByText(/无法读取执行记录/).closest(".state") ?? document.body,
      ).getByRole("button", { name: /重试/ }),
    );
    expect(
      await screen.findByRole("button", { name: "保存自动合并配置" }),
    ).toBeEnabled();
  });

  it("写权限被收回时保留错误原因，不显示成功", async () => {
    saveFailure = true;
    const user = userEvent.setup();
    mountPanel();
    await user.click(await screen.findByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "保存自动合并配置" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "需要本仓库管理权限",
    );
    expect(screen.queryByText(/已开启本仓库自动合并/)).not.toBeInTheDocument();
    expect(saved).toEqual([]);
  });

  it("过长检查名在提交前阻止，关闭面板不会写入未保存配置", async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    render(<AutoMergePanel repo={repo} onClose={close} />);
    const input = await screen.findByRole("textbox", {
      name: "必须通过的检查名称",
    });
    await user.type(input, "x".repeat(201));
    await user.click(screen.getByRole("button", { name: "保存自动合并配置" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("200");
    await user.click(screen.getByRole("button", { name: "收起" }));
    expect(close).toHaveBeenCalledOnce();
    expect(saved).toEqual([]);
  });

  it("刷新记录不会覆盖未保存的配置草稿", async () => {
    const user = userEvent.setup();
    mountPanel();
    await user.click(await screen.findByRole("checkbox"));
    await user.type(
      screen.getByRole("textbox", { name: "必须通过的检查名称" }),
      "new checks",
    );
    await user.click(screen.getByRole("button", { name: "刷新记录" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "刷新记录" })).toBeEnabled(),
    );
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(
      screen.getByRole("textbox", { name: "必须通过的检查名称" }),
    ).toHaveValue("new checks");
  });
});
