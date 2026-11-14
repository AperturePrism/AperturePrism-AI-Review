/** 规则编辑的 DOM → 本地 HTTP 契约回归，导入预览与保存分开验证。 */
import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { GlobalRulesEditor } from "../components/GlobalRulesEditor";
import { ToastProvider } from "../components/Toast";
import { bumpCache } from "../lib/api/http";
import { onUnauthorized } from "../lib/auth";

const nativeFetch = globalThis.fetch;
const savedRules = "# Existing policy\n  - Never log credentials.\n";
const importedRules = "# Imported policy\n\n  - Keep exact indentation.\n";
const maxChars = 16_000;
const maxBytes = 64_000;
let server: Server;
let origin = "";
let content = savedRules;
let canManage = true;
let forbidden = false;
let conflict = false;
let unavailable: "save" | "preview" | "load" | null = null;
let disconnectSave = false;
let requests: Array<{
  method: string;
  path: string;
  body?: Record<string, unknown>;
}> = [];

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const snapshot = () => ({
  content,
  contentHash: hash(content),
  updatedAt: "2026-11-01T00:00:00Z",
  canManage,
  maxChars,
  maxBytes,
});
function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
async function readBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}
beforeAll(async () => {
  server = createServer((request, response) => {
    void (async () => {
      const method = request.method ?? "GET";
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.headers.authorization !== "Bearer rules-http-session") {
        json(response, 401, { reason: "unauthorized" });
        return;
      }
      const body = method === "GET" ? undefined : await readBody(request);
      requests.push({ method, path, ...(body ? { body } : {}) });
      if (path === "/settings" && method === "GET") {
        json(response, 200, { items: [] });
        return;
      }
      if (path === "/repo-rules/global" && method === "GET") {
        if (forbidden) json(response, 403, { reason: "admin_required" });
        else if (unavailable === "load")
          json(response, 503, { reason: "storage_unavailable" });
        else json(response, 200, snapshot());
        return;
      }
      if (!canManage || forbidden) {
        json(response, 403, { reason: "admin_required" });
        return;
      }
      if (path === "/repo-rules/global" && method === "PUT") {
        if (disconnectSave) {
          response.destroy();
          return;
        }
        if (unavailable === "save") {
          json(response, 503, { reason: "storage_unavailable" });
          return;
        }
        if (conflict || body?.expectedContentHash !== hash(content)) {
          json(response, 409, {
            reason: "global_rules_conflict",
            currentContentHash: hash(content),
          });
          return;
        }
        if (
          typeof body?.content !== "string" ||
          body.content.length > maxChars ||
          Buffer.byteLength(body.content) > maxBytes
        ) {
          json(response, 400, {
            reason: "invalid_rules",
            detail: "最多允许 16000 个字符",
          });
          return;
        }
        content = body.content;
        json(response, 200, snapshot());
        return;
      }
      if (path === "/repo-rules/global/from-url" && method === "POST") {
        if (unavailable === "preview")
          json(response, 503, { reason: "remote_unavailable" });
        else
          json(response, 200, { content: importedRules, sourceUrl: body?.url });
        return;
      }
      json(response, 404, { reason: "not_found" });
    })().catch((error: unknown) => {
      json(response, 500, {
        reason: error instanceof Error ? error.message : "test_server_error",
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("HTTP test server has no TCP port");
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => {
  content = savedRules;
  canManage = true;
  forbidden = false;
  conflict = false;
  unavailable = null;
  disconnectSave = false;
  requests = [];
  localStorage.clear();
  localStorage.setItem("apertureprism.token", "rules-http-session");
  bumpCache();
  vi.stubGlobal("fetch", ((input: RequestInfo | URL, init?: RequestInit) => {
    // JSDOM 与 Undici 的信号属于不同 realm；本文件验证 HTTP 交互，不验证取消竞争。
    const transport = { ...init };
    delete transport.signal;
    return nativeFetch(new URL(String(input), origin), transport);
  }) as typeof fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  onUnauthorized(null);
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

const click = (element: Element) =>
  act(async () => {
    await userEvent.click(element);
  });
async function showEditor() {
  render(
    <ToastProvider>
      <GlobalRulesEditor />
    </ToastProvider>,
  );
  return screen.findByRole("textbox", { name: "全局审核规则" });
}
const puts = () => requests.filter((request) => request.method === "PUT");
async function upload(file: File) {
  await act(async () => {
    await userEvent.upload(screen.getByLabelText("选择全局规则文件"), file);
  });
}
async function previewUrl() {
  fireEvent.change(screen.getByRole("textbox", { name: "全局规则 URL" }), {
    target: { value: "https://rules.example/policy.md" },
  });
  await click(screen.getByRole("button", { name: "预览 URL 规则" }));
  return screen.findByRole("region", { name: "导入预览" });
}

describe("global rule editor DOM → HTTP", () => {
  it("keeps an unapplied import preview when refreshing an otherwise clean draft", async () => {
    const editor = await showEditor();
    const preview = await previewUrl();
    const reads = requests.filter(
      (request) =>
        request.method === "GET" && request.path === "/repo-rules/global",
    ).length;
    await click(screen.getByRole("button", { name: "刷新已保存规则" }));
    expect(screen.getByRole("region", { name: "导入预览" })).toBe(preview);
    expect(editor).toHaveValue(savedRules);
    expect(
      requests.filter(
        (request) =>
          request.method === "GET" && request.path === "/repo-rules/global",
      ),
    ).toHaveLength(reads);
    expect(puts()).toHaveLength(0);
    await click(screen.getByRole("button", { name: "放弃修改并重新加载" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "导入预览" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("loads the old saved policy without any GitHub configuration or repository request", async () => {
    const editor = await showEditor();
    expect(editor).toHaveValue(savedRules);
    expect(puts()).toHaveLength(0);
    expect(
      requests.every((request) =>
        ["/repo-rules/global", "/settings"].includes(request.path),
      ),
    ).toBe(true);
    expect(screen.getByRole("button", { name: "保存全局规则" })).toBeDisabled();
  });

  it("saves exact multiline text with the loaded content hash and can explicitly clear it", async () => {
    const editor = await showEditor();
    const draft = "  # New policy\n\n  - Preserve trailing newline.\n";
    fireEvent.change(editor, { target: { value: draft } });
    await click(screen.getByRole("button", { name: "保存全局规则" }));
    await waitFor(() => expect(content).toBe(draft));
    expect(puts()[0]?.body).toEqual({
      content: draft,
      expectedContentHash: hash(savedRules),
    });
    fireEvent.change(editor, { target: { value: "" } });
    await click(screen.getByRole("button", { name: "保存全局规则" }));
    await waitFor(() => expect(content).toBe(""));
    expect(puts()[1]?.body).toEqual({
      content: "",
      expectedContentHash: hash(draft),
    });
  });

  it("previews a UTF-8 file, appends it to the dirty draft, and only saves on an explicit click", async () => {
    const editor = await showEditor();
    const draft = "# Unsaved local edit\n";
    fireEvent.change(editor, { target: { value: draft } });
    await upload(
      new File([importedRules], "policy.md", { type: "text/markdown" }),
    );
    const preview = await screen.findByRole("region", {
      name: "导入预览",
    });
    expect(preview).toHaveTextContent("Imported policy");
    expect(editor).toHaveValue(draft);
    expect(puts()).toHaveLength(0);
    await click(within(preview).getByRole("button", { name: "追加到草稿" }));
    expect(String((editor as HTMLTextAreaElement).value)).toContain(draft);
    expect(String((editor as HTMLTextAreaElement).value)).toContain(
      importedRules,
    );
    expect(content).toBe(savedRules);
    await click(screen.getByRole("button", { name: "保存全局规则" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(content).toBe((editor as HTMLTextAreaElement).value);
  });

  it("requires an explicit replace choice before file content replaces the draft", async () => {
    const editor = await showEditor();
    await upload(
      new File([importedRules], "POLICY.TXT", { type: "text/plain" }),
    );
    const preview = await screen.findByRole("region", {
      name: "导入预览",
    });
    expect(editor).toHaveValue(savedRules);
    await click(within(preview).getByRole("button", { name: "替换草稿" }));
    expect(editor).toHaveValue(importedRules);
    expect(puts()).toHaveLength(0);
    expect(content).toBe(savedRules);
  });

  it("fetches URL text as preview without saving, then replaces and saves through PUT", async () => {
    const editor = await showEditor();
    const preview = await previewUrl();
    expect(
      requests.find((request) => request.path.endsWith("/from-url"))?.body,
    ).toEqual({ url: "https://rules.example/policy.md" });
    expect(editor).toHaveValue(savedRules);
    expect(content).toBe(savedRules);
    expect(puts()).toHaveLength(0);
    await click(within(preview).getByRole("button", { name: "替换草稿" }));
    expect(editor).toHaveValue(importedRules);
    await click(screen.getByRole("button", { name: "保存全局规则" }));
    await waitFor(() => expect(content).toBe(importedRules));
    expect(puts()).toHaveLength(1);
  });

  it("can append or cancel a URL import without losing an edited draft", async () => {
    const editor = await showEditor();
    fireEvent.change(editor, { target: { value: "# Local draft\n" } });
    const first = await previewUrl();
    await click(within(first).getByRole("button", { name: "取消导入" }));
    expect(editor).toHaveValue("# Local draft\n");
    const next = await previewUrl();
    await click(within(next).getByRole("button", { name: "追加到草稿" }));
    expect((editor as HTMLTextAreaElement).value).toContain("# Local draft\n");
    expect((editor as HTMLTextAreaElement).value).toContain(importedRules);
    expect(puts()).toHaveLength(0);
  });

  it("never refreshes over a dirty draft unless the discard action is chosen", async () => {
    const editor = await showEditor();
    const draft = "# Keep my unsaved change";
    fireEvent.change(editor, { target: { value: draft } });
    content = "# Saved by another administrator";
    await click(screen.getByRole("button", { name: "刷新已保存规则" }));
    expect(editor).toHaveValue(draft);
    await click(screen.getByRole("button", { name: "放弃修改并重新加载" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "全局审核规则" })).toHaveValue(
        content,
      ),
    );
    expect(puts()).toHaveLength(0);
  });

  it("preserves the draft and loaded revision when a concurrent save conflicts", async () => {
    const editor = await showEditor();
    fireEvent.change(editor, { target: { value: "# My draft" } });
    content = "# Other administrator's change";
    conflict = true;
    await click(screen.getByRole("button", { name: "保存全局规则" }));
    expect(
      await screen.findByText(/草稿已保留|其他.*修改|已被修改/),
    ).toBeInTheDocument();
    expect(editor).toHaveValue("# My draft");
    expect(content).toBe("# Other administrator's change");
    expect(puts()[0]?.body?.expectedContentHash).toBe(hash(savedRules));
  });

  it("retains local text after a real transport disconnect and does not claim it was saved", async () => {
    const editor = await showEditor();
    fireEvent.change(editor, {
      target: { value: "# Network must not lose this" },
    });
    disconnectSave = true;
    await click(screen.getByRole("button", { name: "保存全局规则" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "保存全局规则" }),
      ).toBeEnabled(),
    );
    expect(editor).toHaveValue("# Network must not lose this");
    expect(content).toBe(savedRules);
    expect(screen.queryByText(/全局规则已保存/)).not.toBeInTheDocument();
  });

  it("shows a read-only saved policy without edit, upload or save actions", async () => {
    canManage = false;
    const editor = await showEditor();
    expect(editor).toHaveValue(savedRules);
    expect(
      editor.hasAttribute("readonly") || editor.hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.queryByRole("button", { name: "保存全局规则" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("选择全局规则文件")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "预览 URL 规则" }),
    ).not.toBeInTheDocument();
  });

  it("handles a non-admin 403 without exposing a writable empty editor", async () => {
    forbidden = true;
    render(
      <ToastProvider>
        <GlobalRulesEditor />
      </ToastProvider>,
    );
    expect(await screen.findByText(/管理员/)).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "全局审核规则" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "保存全局规则" }),
    ).not.toBeInTheDocument();
    expect(puts()).toHaveLength(0);
  });

  it("rejects invalid UTF-8 and oversized files without changing saved or draft text", async () => {
    const editor = await showEditor();
    await upload(
      new File([new Uint8Array([0xff, 0xfe, 0x00])], "broken.md", {
        type: "text/markdown",
      }),
    );
    expect(await screen.findByText(/不是有效的 UTF-8/)).toBeInTheDocument();
    expect(editor).toHaveValue(savedRules);
    await upload(
      new File(["a".repeat(maxBytes + 1)], "large.txt", { type: "text/plain" }),
    );
    expect(await screen.findByText(/规则文件最多/)).toBeInTheDocument();
    expect(editor).toHaveValue(savedRules);
    expect(content).toBe(savedRules);
    expect(puts()).toHaveLength(0);
  });

  it("keeps the current draft when URL preview fails", async () => {
    const editor = await showEditor();
    fireEvent.change(editor, { target: { value: "# Local draft" } });
    unavailable = "preview";
    fireEvent.change(screen.getByRole("textbox", { name: "全局规则 URL" }), {
      target: { value: "https://rules.example/policy.md" },
    });
    await click(screen.getByRole("button", { name: "预览 URL 规则" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "预览 URL 规则" }),
      ).toBeEnabled(),
    );
    expect(editor).toHaveValue("# Local draft");
    expect(
      screen.queryByRole("region", { name: "导入预览" }),
    ).not.toBeInTheDocument();
    expect(puts()).toHaveLength(0);
  });
});
