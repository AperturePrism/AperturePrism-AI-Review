/** DOM → 实际自动化 HTTP → 持久事务，覆盖规则、独立审批、继续执行和生成报告。 */
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL as NodeURL } from "node:url";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
import { createAutomation } from "../../../../packages/review-automation/src/index";
import { createAutomationHttp } from "../../../../packages/review-automation/src/http";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import type {
  Automation,
  AutomationActor,
  AutomationRule,
  AutomationRun,
} from "../lib/automation";
import { automation, type AutomationPageContext } from "../lib/automation";
import { AutomationRuleForm } from "../features/automation/rule";
import { AutomationApprovals } from "../features/automation/approval";
import { AutomationRuns } from "../features/automation/run";
import { AutomationReports } from "../features/automation/report";

const repository = "verification/automation-dom";
const author: AutomationActor = {
  userId: "author",
  isAdmin: true,
  canAccessRepository: () => true,
};
const reviewer: AutomationActor = {
  userId: "reviewer",
  isAdmin: true,
  canAccessRepository: () => true,
};
const observer: AutomationActor = {
  userId: "observer",
  isAdmin: false,
  isReadOnly: true,
  canAccessRepository: (repo, write) => repo === repository && !write,
};
const nativeFetch = globalThis.fetch;
let engine: Automation;
let server: Server;
let directory = "";
let origin = "";
let reportFailure: unknown = null;
const pageContext = (
  userId: string,
  canWrite = true,
): AutomationPageContext => ({
  repository,
  viewer: { userId, isAdmin: userId !== "observer", canWrite },
  supportedActions: [
    "audit.record",
    "approval.request",
    "report.create",
    "finding.transition",
  ],
  onChanged: vi.fn(),
});
const user = {
  click: (element: Element) =>
    act(async () => {
      await userEvent.click(element);
    }),
  type: (element: Element, text: string) =>
    act(async () => {
      await userEvent.type(element, text);
    }),
};
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "automation-web-dom-"));
  // 文件式报告插件必须在 Node file:// 上运行，不能使用 JSDOM 改写后的 http:// import.meta.url。
  const serverPackage = join(process.cwd(), "../../packages/review-workbench");
  execFileSync(process.execPath, [
    join(process.cwd(), "node_modules/typescript/lib/tsc.js"),
    "-p",
    serverPackage,
  ]);
  const { createWorkbench } = createRequire(
    join(process.cwd(), "package.json"),
  )(
    join(serverPackage, "dist/index.js"),
  ) as typeof import("../../../../packages/review-workbench/src/index");
  const realWorkbench = createWorkbench({
    dataDirectory: join(directory, "workbench"),
  });
  const workbench = {
    execute: async (...args: Parameters<typeof realWorkbench.execute>) => {
      try {
        return await realWorkbench.execute(...args);
      } catch (error) {
        reportFailure = error;
        throw error;
      }
    },
  };
  engine = createAutomation({
    dataDirectory: join(directory, "automation"),
    workbench,
  });
  const handle = createAutomationHttp(engine);
  server = createServer((request, response) => {
    const actor =
      request.headers.authorization === "Bearer reviewer-session"
        ? reviewer
        : request.headers.authorization === "Bearer author-session"
          ? author
          : request.headers.authorization === "Bearer observer-session"
            ? observer
            : null;
    if (!actor) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          status: "error",
          code: "unauthorized",
          reason: "未登录",
        }),
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
    throw new Error("未取得测试端口");
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => {
  // 文件系统 API 要求 Node URL，JSDOM 的 URL 对象属于另一 realm。
  vi.stubGlobal("URL", NodeURL);
  localStorage.clear();
  localStorage.setItem("apertureprism.token", "author-session");
  vi.stubGlobal("fetch", ((input: RequestInfo | URL, init?: RequestInit) => {
    // JSDOM 与 Undici 的 AbortSignal 分属不同 realm，取消竞争由独立 hooks 测试覆盖。
    const transport = { ...init };
    delete transport.signal;
    return nativeFetch(new URL(String(input), origin), transport);
  }) as typeof fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(directory, { recursive: true, force: true });
});

describe("自动化真实 DOM 与 HTTP", () => {
  it("可视创建的规则经后端保存，再只读试跑显示真实解释", async () => {
    render(<AutomationRuleForm {...pageContext("author")} onSaved={vi.fn()} />);
    await user.type(screen.getByLabelText(/规则名称/), "DOM事件审计规则");
    await user.click(screen.getByLabelText("启用规则匹配新事件"));
    await user.click(screen.getByRole("button", { name: "保存自动化规则" }));
    await screen.findByText("规则已保存");
    const saved = (await engine.execute(author, {
      action: "rules.list",
      input: { repository },
    })) as { items: AutomationRule[] };
    expect(saved.items[0]).toMatchObject({
      name: "DOM事件审计规则",
      enabled: true,
      condition: { field: "gate", op: "eq", value: "fail" },
    });
    await user.click(screen.getByRole("button", { name: "解释规则匹配" }));
    await screen.findByText("该事件会匹配规则");
    const beforeRuns = (await engine.execute(author, {
      action: "runs.list",
      input: { repository },
    })) as { total: number };
    expect(beforeRuns.total).toBe(0);
  });
  it("请求人无法自批，另一管理员审批后可继续运行并下载真实报告内容", async () => {
    await engine.execute(author, {
      action: "rules.create",
      input: {
        repository,
        name: "独立审批后生成报告",
        condition: { field: "type", op: "eq", value: "approval.test" },
        actions: [
          {
            kind: "approval.request",
            input: { title: "DOM独立审批", requireDifferentActor: true },
            costUnits: 1,
            maxAttempts: 1,
          },
          {
            kind: "report.create",
            input: { format: "markdown" },
            costUnits: 1,
            maxAttempts: 1,
          },
        ],
      },
    });
    const dispatch = (await engine.execute(author, {
      action: "events.dispatch",
      input: {
        repository,
        event: {
          id: "approval-dom",
          type: "approval.test",
          repository,
          occurredAt: new Date().toISOString(),
        },
      },
    })) as { runs: AutomationRun[] };
    const runId = dispatch.runs[0]!.id;
    render(<AutomationApprovals {...pageContext("author")} />);
    await screen.findByRole("heading", { name: "DOM独立审批" });
    expect(screen.getByRole("button", { name: "同意审批" })).toBeDisabled();
    cleanup();
    localStorage.setItem("apertureprism.token", "reviewer-session");
    render(<AutomationApprovals {...pageContext("reviewer")} />);
    await screen.findByRole("heading", { name: "DOM独立审批" });
    await user.type(screen.getByLabelText(/审批附言/), "另一位管理员确认");
    await user.click(screen.getByRole("button", { name: "同意审批" }));
    await user.click(screen.getByRole("button", { name: "确认同意审批" }));
    await screen.findByText("没有匹配的审批请求");
    cleanup();
    render(<AutomationRuns {...pageContext("reviewer")} />);
    await user.click(await screen.findByRole("button", { name: "继续执行" }));
    await waitFor(async () => {
      const current = (await engine.execute(reviewer, {
        action: "runs.get",
        input: { repository, id: runId },
      })) as AutomationRun;
      if (current.state === "failed")
        throw new Error(`生成报告失败：${String(reportFailure)}`);
      expect(current.state).toBe("completed");
    });
    const saved = (await engine.execute(reviewer, {
      action: "runs.get",
      input: { repository, id: runId },
    })) as AutomationRun;
    expect(saved.state).toBe("completed");
    expect(saved.steps[0]?.state).toBe("completed");
    cleanup();
    render(<AutomationReports {...pageContext("reviewer")} />);
    await user.click(await screen.findByRole("button", { name: "纯文本预览" }));
    await screen.findByText("报告纯文本预览");
    expect(
      document.querySelector(".auto-report-preview pre")?.textContent,
    ).toContain(repository);
  });
  it("只读身份可以 POST 试跑，但真实创建被服务端拒绝", async () => {
    localStorage.setItem("apertureprism.token", "observer-session");
    const summary = await automation.summary(repository);
    expect(summary.viewer).toMatchObject({
      userId: "observer",
      canWrite: false,
    });
    const rules = (await engine.execute(author, {
      action: "rules.list",
      input: { repository },
    })) as { items: AutomationRule[] };
    const preview = await automation.preview(repository, {
      id: rules.items[0]!.id,
      event: {
        id: "observer-preview",
        type: "review.completed",
        repository,
        occurredAt: new Date().toISOString(),
        gate: "fail",
      },
    });
    expect(preview.writes).toBe(false);
    await expect(
      automation.createRule(repository, { name: "should-not-create" }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
