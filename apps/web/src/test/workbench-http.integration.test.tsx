/** DOM 与真实工作台 HTTP/文件事务的贯通测试；不依赖数据库或模型费用。 */
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { createWorkbench } from "../../../../packages/review-workbench/src/index";
import { createWorkbenchHttp } from "../../../../packages/review-workbench/src/http";
import type {
  Actor,
  Finding,
  Policy,
  Workbench,
} from "../../../../packages/review-workbench/src/types";
import { Policies } from "../features/workbench/policy";
import { Findings } from "../features/workbench/finding";
import { Intake } from "../features/workbench/intake";
import { workbench } from "../lib/workbench";
import { onUnauthorized } from "../lib/auth";

const nativeFetch = globalThis.fetch;
const repository = "verification/dom-http";
const actor: Actor = {
  userId: "dom-http-verifier",
  isAdmin: false,
  canAccessRepository: (value) => value === repository,
};
let engine: Workbench;
let server: Server;
let origin = "";
let directory = "";
const user = {
  click: (element: Element) =>
    act(async () => {
      await userEvent.click(element);
    }),
  type: (element: Element, value: string) =>
    act(async () => {
      await userEvent.type(element, value);
    }),
};
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "review-web-http-"));
  engine = createWorkbench({ dataDirectory: directory });
  const handle = createWorkbenchHttp(engine);
  server = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer dom-http-session") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { code: "unauthorized", message: "未登录" } }),
      );
      return;
    }
    void handle(request, response, actor).then((matched) => {
      if (!matched) {
        response.writeHead(404);
        response.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("HTTP 验证服务未取得端口");
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("apertureprism.token", "dom-http-session");
  vi.stubGlobal("fetch", ((input: RequestInfo | URL, init?: RequestInit) => {
      // JSDOM 与 Undici 的 AbortSignal 分属不同 realm；取消竞争由 hooks 测试覆盖。
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
  await rm(directory, { recursive: true, force: true });
});

describe("DOM → HTTP → 真实文件事务", () => {
  it("创建策略后从服务端重新读取，不依赖组件乐观伪数据", async () => {
    render(<Policies repository={repository} />);
    await screen.findByText("尚未创建审查策略");
    const summary = screen.getByText("创建策略", { selector: "summary" });
    fireEvent.click(summary);
    const form = within(summary.closest("details")!);
    await user.type(form.getByLabelText(/策略名称/), "DOM真实HTTP策略");
    await user.click(
      form.getByRole("button", { name: "创建策略" }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "DOM真实HTTP策略",
        }),
    ).toBeInTheDocument();
    const saved = (await engine.execute(actor, {
      action: "policies.list",
      input: { repository },
    })) as { items: Policy[] };
    expect(saved.items).toHaveLength(1);
    expect(saved.items[0]?.name).toBe("DOM真实HTTP策略");
    expect(saved.items[0]?.versions[0]?.rules.blockedSeverities).toEqual([
      "critical",
      "high",
    ]);
  });
  it("发现处置通过 HTTP 写入真实历史，界面刷新显示后端状态", async () => {
    const finding = (await engine.execute(actor, {
      action: "findings.create",
      input: {
        repository,
        ruleId: "VERIFY.STATE",
        title: "DOM状态验证",
        description: "验证数据",
        path: "src/state.ts",
        line: 3,
        severity: "medium",
        confidence: 0.9,
      },
    })) as Finding;
    render(<Findings repository={repository} />);
    await screen.findByRole("heading", { name: "DOM状态验证" });
    fireEvent.click(screen.getByText("处置与指派", { selector: "summary" }));
    fireEvent.change(screen.getByLabelText("设置状态"), {
      target: { value: "acknowledged" },
    });
    await user.type(screen.getByLabelText(/^原因/), "真实HTTP确认记录");
    await user.click(
      screen.getByRole("button", { name: "保存处置" }),
    );
    expect(
      await screen.findByText("已确认", { selector: ".pill" }),
    ).toBeInTheDocument();
    const saved = (await engine.execute(actor, {
      action: "findings.get",
      input: { repository, id: finding.id },
    })) as Finding;
    expect(saved.status).toBe("acknowledged");
    expect(saved.history.at(-1)).toMatchObject({
      actor: "dom-http-verifier",
      to: "acknowledged",
      reason: "真实HTTP确认记录",
    });
  });
  it("预览导入确认后整批写入，后台保存的来源和位置正确", async () => {
    render(<Intake repository={repository} />);
    fireEvent.change(screen.getByLabelText("导入格式"), {
      target: { value: "json" },
    });
    fireEvent.change(screen.getByLabelText(/报告内容/), {
      target: {
        value: JSON.stringify([
          {
            title: "DOM导入验证",
            ruleId: "VERIFY.IMPORT",
            path: "src/import.ts",
            line: 12,
            severity: "low",
          },
        ]),
      },
    });
    await user.click(
      screen.getByRole("button", { name: "验证并预览" }),
    );
    await user.click(screen.getByLabelText("我已核对仓库范围和导入内容"));
    await user.click(
      screen.getByRole("button", { name: "导入 1 个发现" }),
    );
    await screen.findByText("发现已整批导入，可在发现与处置页查看");
    const saved = (await engine.execute(actor, {
      action: "findings.list",
      input: { repository },
    })) as { items: Finding[] };
    expect(
      saved.items.find((item) => item.ruleId === "VERIFY.IMPORT"),
    ).toMatchObject({
      title: "DOM导入验证",
      line: 12,
      path: "src/import.ts",
      source: "json-import",
    });
  });
  it("服务端仓库授权错误不会变成空列表或成功状态", async () => {
    await expect(workbench.list("findings", "private/other")).rejects.toThrow(
      "无权访问",
    );
    render(<Policies repository="private/other" />);
    await waitFor(() =>
      expect(screen.getByText("仓库不存在或无权访问")).toBeInTheDocument(),
    );
    expect(screen.queryByText("尚未创建审查策略")).not.toBeInTheDocument();
  });
});
