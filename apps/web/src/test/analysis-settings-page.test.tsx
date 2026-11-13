import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSettingSpec,
  MAX_GLOBAL_REVIEW_RULES_CHARS,
} from "../../../../packages/config/src/settings-registry";
import { ToastProvider } from "../components/Toast";
import { bumpCache, type SettingItem } from "../lib/api";
import { AnalysisSettingsPage } from "../pages/AnalysisSettingsPage";

const key = "review_rules_global";
const savedRules = "# Common policy\n  - Never log credentials.\n";
const spec = getSettingSpec(key)!;
const fetchMock = vi.fn<typeof fetch>();
let current: SettingItem;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderPage() {
  return render(
    <ToastProvider>
      <AnalysisSettingsPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  bumpCache();
  current = {
    ...spec,
    options: undefined,
    source: "database",
    value: savedRules,
    defaultValue: "",
    envConfigured: false,
    hasValue: true,
    updatedAt: "2026-11-01T00:00:00Z",
  };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url, init) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as {
        key: string;
        value: string | null;
      };
      current = {
        ...current,
        value: body.value ?? "",
        source: body.value === null ? "default" : "database",
        hasValue: body.value !== null && body.value.trim().length > 0,
      };
      return jsonResponse({ status: "ok", key: body.key });
    }
    return jsonResponse({ items: [current] });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("analysis settings global review rules", () => {
  it("shows saved rules in an accessible bounded multiline editor", async () => {
    renderPage();
    const editor = await screen.findByRole("textbox", { name: "全局审核规则" });
    expect(editor.tagName).toBe("TEXTAREA");
    expect(editor).toHaveValue(savedRules);
    expect(editor).toHaveAttribute(
      "maxlength",
      String(MAX_GLOBAL_REVIEW_RULES_CHARS),
    );
    expect(editor).toHaveAccessibleDescription(spec.hint);
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(
      screen.getByText(/仓库规则开关只控制目录与外部链接/),
    ).toBeInTheDocument();
  });

  it("saves exact multiline text through PUT /settings and keeps it editable after refresh", async () => {
    renderPage();
    const editor = await screen.findByRole("textbox", { name: "全局审核规则" });
    const updated =
      "  # Updated policy\n\n  - Keep indentation and trailing newline.\n";
    fireEvent.change(editor, { target: { value: updated } });
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "保存" }));
    });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/settings",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ key, value: updated }),
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存" })).toBeDisabled(),
    );
    expect(screen.getByRole("textbox", { name: "全局审核规则" })).toHaveValue(
      updated,
    );
    expect(current.value).toBe(updated);
  });

  it("allows saving an empty value to disable global rules", async () => {
    renderPage();
    const editor = await screen.findByRole("textbox", { name: "全局审核规则" });
    await act(async () => {
      await userEvent.clear(editor);
    });
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "保存" }));
    });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/settings",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ key, value: "" }),
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存" })).toBeDisabled(),
    );
    expect(screen.getByRole("textbox", { name: "全局审核规则" })).toHaveValue(
      "",
    );
  });

  it("clears the override and reloads the empty default", async () => {
    renderPage();
    await screen.findByRole("textbox", { name: "全局审核规则" });
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "回落默认" }));
    });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/settings",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ key, value: null }),
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "全局审核规则" })).toHaveValue(
        "",
      ),
    );
    expect(
      screen.queryByRole("button", { name: "回落默认" }),
    ).not.toBeInTheDocument();
  });

  it("retains the draft and displays a settings API validation error", async () => {
    renderPage();
    const editor = await screen.findByRole("textbox", { name: "全局审核规则" });
    fireEvent.change(editor, { target: { value: "Unsaved policy" } });
    fetchMock.mockImplementation(async (_url, init) =>
      init?.method === "PUT"
        ? jsonResponse(
            {
              reason: "invalid_setting_value",
              detail: "最多允许 16000 个字符",
            },
            400,
          )
        : jsonResponse({ items: [current] }),
    );
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "保存" }));
    });
    expect(
      await screen.findByText(/最多允许 16000 个字符/),
    ).toBeInTheDocument();
    expect(editor).toHaveValue("Unsaved policy");
    expect(current.value).toBe(savedRules);
  });
});
