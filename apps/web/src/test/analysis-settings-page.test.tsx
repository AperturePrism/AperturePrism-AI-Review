import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSettingSpec } from "../../../../packages/config/src/settings-registry";
import { ToastProvider } from "../components/Toast";
import { bumpCache, type SettingItem } from "../lib/api";
import { AnalysisSettingsPage } from "../pages/AnalysisSettingsPage";
import { RepoRulesPage } from "../pages/RepoRulesPage";

const savedRules = "# Existing global policy\n- Preserve this content.\n";
const fetchMock = vi.fn<typeof fetch>();
const setting = (key: string, value: string): SettingItem => ({
  ...getSettingSpec(key)!,
  options: undefined,
  source: "database",
  value,
  defaultValue: "",
  envConfigured: false,
  hasValue: true,
  updatedAt: "2026-11-01T00:00:00Z",
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  localStorage.clear();
  window.location.hash = "#/analysis";
  bumpCache();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    const path = String(input);
    if (path === "/repo-rules/global")
      return response({
        content: savedRules,
        contentHash: "a".repeat(64),
        updatedAt: "2026-11-01T00:00:00Z",
        canManage: true,
        maxChars: 16000,
        maxBytes: 64000,
      });
    if (path === "/repo-rules")
      return response({ githubConfigured: false, items: [] });
    return response({
      items: [
        setting("review_rules_global", savedRules),
        setting("repo_rules_enabled", "true"),
        setting("issue_auto_assign", "false"),
        setting("pr_auto_review", "true"),
      ],
    });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("review rules have one editing location", () => {
  it("keeps a navigation entry in analysis settings without a duplicate rules editor", async () => {
    render(
      <ToastProvider>
        <AnalysisSettingsPage />
      </ToastProvider>,
    );
    await screen.findByRole("switch", { name: "PR 自动提交 Review" });
    expect(
      screen.queryByRole("textbox", { name: "全局审核规则" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "仓库审核规则" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "前往「审核规则」" }),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.every(
        (call) => String(call[0]) !== "/repo-rules/global",
      ),
    ).toBe(true);
  });

  it("navigates to the rules page while retaining Issue and PR settings", async () => {
    render(
      <ToastProvider>
        <AnalysisSettingsPage />
      </ToastProvider>,
    );
    await screen.findByRole("switch", { name: "PR 自动提交 Review" });
    expect(
      screen.getByRole("heading", { name: "Issue 分析" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "PR 审查" }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "前往「审核规则」" }),
    );
    expect(window.location.hash).toBe("#/repo-rules");
  });

  it("shows the existing global policy even when GitHub is not configured and no repositories exist", async () => {
    render(
      <ToastProvider>
        <RepoRulesPage />
      </ToastProvider>,
    );
    expect(
      await screen.findByRole("textbox", { name: "全局审核规则" }),
    ).toHaveValue(savedRules);
    expect(await screen.findByText("GitHub App 尚未配置")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存全局规则" })).toBeDisabled();
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "仓库审核规则" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/旧的全局规则会继续沿用/)).toBeInTheDocument();
  });
});
