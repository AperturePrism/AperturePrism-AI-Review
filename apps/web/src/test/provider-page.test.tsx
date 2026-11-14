import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// api 模块会在导入时读取环境与 localStorage，这里只关心页面结构。
vi.mock("../lib/api", () => ({
  bumpCache: vi.fn(),
  fetchProviders: vi.fn(async () => ({ policies: [], accounts: [] })),
  fetchModels: vi.fn(async () => []),
  fetchSettings: vi.fn(async () => ({ items: [] })),
  clearSetting: vi.fn(async () => {}),
  saveSetting: vi.fn(async () => {}),
  deleteProvider: vi.fn(async () => ({ status: "ok" })),
  saveProvider: vi.fn(async () => ({
    status: "ok",
    provider: "p",
    accountName: "p-main",
    model: "m",
    policiesUpdated: 1,
  })),
}));

import { ToastProvider } from "../components/Toast";

const { ProviderPage } = await import("../pages/ProviderPage");
const api = await import("../lib/api");
const fetchProviders = vi.mocked(api.fetchProviders);
const fetchModels = vi.mocked(api.fetchModels);
const saveProvider = vi.mocked(api.saveProvider);

// 显式等待交互引发的 React 状态更新，兼容独立 Web 工作区的测试依赖。
const user = {
  click: (element: Element) =>
    act(async () => {
      await userEvent.click(element);
    }),
  clear: (element: Element) =>
    act(async () => {
      await userEvent.clear(element);
    }),
  type: (element: Element, value: string) =>
    act(async () => {
      await userEvent.type(element, value);
    }),
};

function renderPage() {
  return render(
    <ToastProvider>
      <ProviderPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchProviders.mockResolvedValue({ policies: [], accounts: [] });
  fetchModels.mockResolvedValue([]);
  saveProvider.mockResolvedValue({
    status: "ok",
    provider: "p",
    accountName: "p-main",
    model: "m",
    policiesUpdated: 1,
  });
});

/**
 * 回归防护：模型配置此前只能在安装向导里做一次，装完后本页是纯只读，
 * 用户点进「模型路由」找不到任何配置入口（issue #2）。
 */
describe("模型路由页必须提供配置入口", () => {
  it("展示「添加模型」按钮", async () => {
    renderPage();
    expect(
      await screen.findByRole("button", { name: /添加模型/ }),
    ).toBeTruthy();
  });

  it("空策略时的提示指向该入口，而不是让用户无从下手", async () => {
    renderPage();
    expect(await screen.findByText(/添加模型/)).toBeTruthy();
  });
});

describe("编辑模型的已保存密钥（issue #114）", () => {
  beforeEach(() => {
    fetchProviders.mockResolvedValue({
      policies: [],
      accounts: [
        {
          provider: "p",
          name: "p-main",
          baseUrl: "https://api.example.com/v1",
        },
        {
          provider: "other",
          name: "other-main",
          baseUrl: "https://other.example.com/v1",
        },
      ],
    });
  });

  async function openEditor() {
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: "编辑 p/p-main" }),
    );
    return within(screen.getByRole("region", { name: "编辑模型" }));
  }

  it("默认显示只读掩码与已保存说明，不获取或显示原密钥", async () => {
    const form = await openEditor();
    const savedKey = form.getByLabelText("API Key（已保存）");

    expect(savedKey).toHaveAttribute("type", "password");
    expect(savedKey).toHaveAttribute("readonly");
    expect(savedKey).toHaveValue("••••••••••••••••");
    expect(savedKey).toHaveAccessibleDescription(
      /已保存 API Key，将保留原密钥.*原密钥不会回传/,
    );
    expect(form.queryByRole("button", { name: "显示新密钥" })).toBeNull();
    expect(form.getByRole("button", { name: "替换密钥" })).toBeEnabled();
    expect(fetchModels).not.toHaveBeenCalled();
    expect(saveProvider).not.toHaveBeenCalled();
  });

  it("未替换时提交空串保留原密钥，不会把掩码作为新密钥保存", async () => {
    const form = await openEditor();
    await user.type(form.getByPlaceholderText(/模型名/), "updated-model");
    const baseUrl = form.getByPlaceholderText(/Base URL/);
    await user.clear(baseUrl);
    await user.type(baseUrl, "https://updated.example.com/v1");
    await user.click(form.getByRole("button", { name: "保存修改" }));

    expect(saveProvider).toHaveBeenCalledTimes(1);
    expect(saveProvider).toHaveBeenCalledWith({
      provider: "p",
      accountName: "p-main",
      baseUrl: "https://updated.example.com/v1",
      model: "updated-model",
      apiKey: "",
    });
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "编辑模型" })).toBeNull(),
    );
    await user.click(screen.getByRole("button", { name: "编辑 p/p-main" }));
    expect(screen.getByLabelText("API Key（已保存）")).toHaveValue(
      "••••••••••••••••",
    );
  });

  it("主动替换后只显示本次输入的新密钥，默认隐藏且可切换显示", async () => {
    const form = await openEditor();
    await user.click(form.getByRole("button", { name: "替换密钥" }));
    const newKey = form.getByLabelText("新 API Key");
    expect(newKey).toHaveValue("");
    expect(newKey).toHaveAttribute("type", "password");
    expect(form.getByRole("button", { name: "显示新密钥" })).toBeDisabled();

    await user.type(newKey, "sk-new-test-only");
    await user.click(form.getByRole("button", { name: "显示新密钥" }));
    expect(newKey).toHaveAttribute("type", "text");
    expect(form.getByRole("button", { name: "隐藏新密钥" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(form.getByRole("button", { name: "隐藏新密钥" }));
    expect(newKey).toHaveAttribute("type", "password");
    await user.type(form.getByPlaceholderText(/模型名/), "m");
    await user.click(form.getByRole("button", { name: "保存修改" }));

    expect(saveProvider).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-new-test-only" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "编辑模型" })).toBeNull(),
    );
    expect(screen.queryByDisplayValue("sk-new-test-only")).toBeNull();
  });

  it("选择保留原密钥会丢弃新密钥并恢复只读掩码", async () => {
    const form = await openEditor();
    await user.click(form.getByRole("button", { name: "替换密钥" }));
    await user.type(form.getByLabelText("新 API Key"), "sk-discard-test-only");
    await user.click(form.getByRole("button", { name: "显示新密钥" }));
    await user.click(form.getByRole("button", { name: "保留原密钥" }));

    expect(form.getByLabelText("API Key（已保存）")).toHaveValue(
      "••••••••••••••••",
    );
    expect(form.queryByDisplayValue("sk-discard-test-only")).toBeNull();
    await user.type(form.getByPlaceholderText(/模型名/), "m");
    await user.click(form.getByRole("button", { name: "保存修改" }));
    expect(saveProvider).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "" }),
    );
  });

  it.each(["", "   "])(
    "替换框留空或仅有空格时仍保留原密钥（%j）",
    async (blank) => {
      const form = await openEditor();
      await user.click(form.getByRole("button", { name: "替换密钥" }));
      if (blank) await user.type(form.getByLabelText("新 API Key"), blank);
      await user.type(form.getByPlaceholderText(/模型名/), "m");
      await user.click(form.getByRole("button", { name: "保存修改" }));

      expect(saveProvider).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "" }),
      );
    },
  );

  it("取消后再次编辑同一账户会恢复原表单并清除新密钥和显示状态", async () => {
    const form = await openEditor();
    await user.click(form.getByRole("button", { name: "替换密钥" }));
    await user.type(form.getByLabelText("新 API Key"), "sk-cancel-test-only");
    await user.click(form.getByRole("button", { name: "显示新密钥" }));
    await user.clear(form.getByPlaceholderText(/Base URL/));
    await user.click(form.getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("region", { name: "编辑模型" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "添加模型" })).toHaveLength(1);
    expect(screen.queryByDisplayValue("sk-cancel-test-only")).toBeNull();
    await user.click(screen.getByRole("button", { name: "编辑 p/p-main" }));
    expect(screen.getByPlaceholderText(/Base URL/)).toHaveValue(
      "https://api.example.com/v1",
    );
    await user.click(screen.getByRole("button", { name: "替换密钥" }));
    expect(screen.getByLabelText("新 API Key")).toHaveValue("");
    expect(screen.getByLabelText("新 API Key")).toHaveAttribute(
      "type",
      "password",
    );
    expect(saveProvider).not.toHaveBeenCalled();
  });

  it("切换账户不会带入上一账户的新密钥或显示状态", async () => {
    const form = await openEditor();
    await user.click(form.getByRole("button", { name: "替换密钥" }));
    await user.type(form.getByLabelText("新 API Key"), "sk-other-test-only");
    await user.click(form.getByRole("button", { name: "显示新密钥" }));
    await user.click(
      screen.getByRole("button", { name: "编辑 other/other-main" }),
    );

    expect(screen.getByPlaceholderText(/Base URL/)).toHaveValue(
      "https://other.example.com/v1",
    );
    expect(screen.getByLabelText("API Key（已保存）")).toHaveValue(
      "••••••••••••••••",
    );
    expect(screen.queryByDisplayValue("sk-other-test-only")).toBeNull();
    await user.click(screen.getByRole("button", { name: "替换密钥" }));
    expect(screen.getByLabelText("新 API Key")).toHaveValue("");
    expect(screen.getByLabelText("新 API Key")).toHaveAttribute(
      "type",
      "password",
    );
  });

  it("保存失败保留新密钥供重试，但恢复隐藏且不会误标为已保存", async () => {
    saveProvider.mockRejectedValueOnce(new Error("save unavailable"));
    const form = await openEditor();
    await user.click(form.getByRole("button", { name: "替换密钥" }));
    await user.type(form.getByLabelText("新 API Key"), "sk-retry-test-only");
    await user.click(form.getByRole("button", { name: "显示新密钥" }));
    await user.type(form.getByPlaceholderText(/模型名/), "m");
    await user.click(form.getByRole("button", { name: "保存修改" }));

    expect(await screen.findByText(/保存失败/)).toBeTruthy();
    expect(form.getByLabelText("新 API Key")).toHaveValue("sk-retry-test-only");
    expect(form.getByLabelText("新 API Key")).toHaveAttribute(
      "type",
      "password",
    );
    expect(form.queryByLabelText("API Key（已保存）")).toBeNull();
    expect(form.getByRole("button", { name: "保存修改" })).toBeEnabled();
  });

  it("通过已保存账号获取模型，掩码和旧密钥不会发送给浏览器或上游", async () => {
    fetchModels.mockResolvedValue(["saved-model"]);
    const form = await openEditor();
    await user.click(form.getByRole("button", { name: "获取模型列表" }));

    expect(fetchModels).toHaveBeenCalledWith("https://api.example.com/v1", "", {
      provider: "p",
      accountName: "p-main",
    });
    expect(
      await form.findByRole("option", { name: "saved-model" }),
    ).toBeTruthy();
    expect(form.getByRole("combobox")).toHaveValue("saved-model");
    expect(form.getByLabelText("API Key（已保存）")).toHaveValue(
      "••••••••••••••••",
    );
  });

  it.each(["", "   "])(
    "替换框为空时不会悄悄使用旧密钥获取模型（%j）",
    async (blank) => {
      const form = await openEditor();
      await user.click(form.getByRole("button", { name: "替换密钥" }));
      if (blank) await user.type(form.getByLabelText("新 API Key"), blank);
      await user.click(form.getByRole("button", { name: "获取模型列表" }));
      expect(fetchModels).not.toHaveBeenCalled();
      expect(
        await screen.findByText(/请填写新 API Key.*保留原密钥/),
      ).toBeTruthy();
      await user.click(form.getByRole("button", { name: "保留原密钥" }));
      await user.click(form.getByRole("button", { name: "获取模型列表" }));
      expect(fetchModels).toHaveBeenCalledWith(
        "https://api.example.com/v1",
        "",
        {
          provider: "p",
          accountName: "p-main",
        },
      );
    },
  );

  it("旧凭据不能探测未保存的新地址，提示先保存或输入新密钥", async () => {
    const form = await openEditor();
    await user.clear(form.getByPlaceholderText(/Base URL/));
    await user.type(
      form.getByPlaceholderText(/Base URL/),
      "https://changed.example.com/v1",
    );
    const probe = form.getByRole("button", { name: "获取模型列表" });
    expect(probe).toBeDisabled();
    expect(
      form.getByText(/Base URL 已修改.*先.*保存/),
    ).toBeTruthy();
    await user.click(probe);
    expect(fetchModels).not.toHaveBeenCalled();
    expect(form.getByLabelText("API Key（已保存）")).toHaveValue(
      "••••••••••••••••",
    );
    expect(saveProvider).not.toHaveBeenCalled();
  });

  it("新地址配上新密钥后可以直接获取模型列表", async () => {
    fetchModels.mockResolvedValueOnce(["model-a"]);
    const form = await openEditor();
    await user.clear(form.getByPlaceholderText(/Base URL/));
    await user.type(
      form.getByPlaceholderText(/Base URL/),
      "https://changed.example.com/v1",
    );
    await user.click(form.getByRole("button", { name: "替换密钥" }));
    await user.type(form.getByLabelText("新 API Key"), "sk-new-address-only");
    await user.click(form.getByRole("button", { name: "获取模型列表" }));
    expect(fetchModels).toHaveBeenCalledWith(
      "https://changed.example.com/v1",
      "sk-new-address-only",
    );
  });

  it("输入的新密钥可用于获取模型列表，不会使用已保存掩码", async () => {
    fetchModels.mockResolvedValueOnce(["model-a", "model-b"]);
    const form = await openEditor();
    await user.click(form.getByRole("button", { name: "替换密钥" }));
    await user.type(form.getByLabelText("新 API Key"), "sk-probe-test-only");
    await user.click(form.getByRole("button", { name: "获取模型列表" }));

    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect(fetchModels).toHaveBeenCalledWith(
      "https://api.example.com/v1",
      "sk-probe-test-only",
    );
    expect(await form.findByRole("option", { name: "model-a" })).toBeTruthy();
    expect(form.getByRole("combobox")).toHaveValue("model-a");
  });

  it("新增模型仍要求输入密钥，不会显示已保存状态", async () => {
    renderPage();
    await user.click(screen.getByRole("button", { name: "添加模型" }));
    const form = within(screen.getByRole("region", { name: "添加模型" }));
    expect(form.getByLabelText("API Key")).toHaveValue("");
    expect(form.getByLabelText("API Key")).toHaveAttribute("type", "password");
    expect(form.queryByRole("button", { name: "替换密钥" })).toBeNull();
    await user.type(form.getByPlaceholderText(/Provider 标识/), "new");
    await user.type(
      form.getByPlaceholderText(/Base URL/),
      "https://new.example.com/v1",
    );
    await user.type(form.getByPlaceholderText(/模型名/), "m");
    await user.click(form.getByRole("button", { name: "保存并接入" }));

    expect(await screen.findByText("新增时 API Key 为必填")).toBeTruthy();
    expect(saveProvider).not.toHaveBeenCalled();
    await user.type(form.getByLabelText("API Key"), "sk-create-test-only");
    await user.click(form.getByRole("button", { name: "保存并接入" }));
    expect(saveProvider).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-create-test-only" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "添加模型" })).toBeNull(),
    );
    await user.click(screen.getByRole("button", { name: "添加模型" }));
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    expect(screen.getByLabelText("API Key")).toHaveAttribute(
      "type",
      "password",
    );
  });
});
