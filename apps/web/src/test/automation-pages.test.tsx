import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/automation", async (original) => {
  const actual = await original<typeof import("../lib/automation")>();
  return {
    ...actual,
    automation: {
      ...actual.automation,
      list: vi.fn(),
      preview: vi.fn(),
      createRule: vi.fn(),
      updateRule: vi.fn(),
      toggleRule: vi.fn(),
      deleteRule: vi.fn(),
      runAction: vi.fn(),
      decide: vi.fn(),
      artifact: vi.fn(),
      dispatch: vi.fn(),
    },
  };
});
import {
  automation,
  type Approval,
  type AutomationPageContext,
  type AutomationRule,
  type AutomationRun,
} from "../lib/automation";
import { AutomationRuleForm } from "../features/automation/rule";
import { ApprovalCard } from "../features/automation/approval";
import { AutomationRunCard } from "../features/automation/run";
import { AutomationReports } from "../features/automation/report";
import { visualCondition } from "../features/automation/condition";
const context: AutomationPageContext = {
  repository: "owner/repo",
  viewer: { userId: "reviewer", isAdmin: true, canWrite: true },
  supportedActions: [
    "audit.record",
    "approval.request",
    "report.create",
    "finding.transition",
  ],
  onChanged: vi.fn(),
};
const rule: AutomationRule = {
  id: "rule-1",
  repository: context.repository,
  name: "高风险规则",
  description: "核查高风险审查",
  enabled: true,
  version: 3,
  condition: { field: "gate", op: "eq", value: "fail" },
  actions: [
    {
      kind: "audit.record",
      input: { message: "发现高风险事件" },
      costUnits: 1,
      maxAttempts: 3,
    },
  ],
  window: null,
  rate: { limit: 100, windowSeconds: 3600 },
  budget: { maxActions: 20, maxCostUnits: 1000, maxDurationMs: 30000 },
  createdAt: "2026-11-13T00:00:00Z",
  updatedAt: "2026-11-13T00:00:00Z",
  createdBy: "author",
};
const approval: Approval = {
  id: "approval",
  repository: context.repository,
  runId: "run-1",
  stepId: "step-1",
  title: "确认高风险处理",
  reason: "需要另一位管理员核查",
  state: "pending",
  requestedBy: "author",
  decidedBy: null,
  decidedAt: null,
  note: "",
  requireDifferentActor: true,
  createdAt: rule.createdAt,
};
const run: AutomationRun = {
  id: "run-1",
  repository: context.repository,
  ruleId: rule.id,
  ruleVersion: rule.version,
  ruleName: rule.name,
  eventId: "event-1",
  event: {
    id: "event-1",
    type: "review.completed",
    repository: context.repository,
    occurredAt: rule.createdAt,
  },
  state: "failed",
  explanation: { passed: true, description: "规则匹配" },
  steps: [
    {
      id: "step-1",
      kind: "report.create",
      input: { format: "markdown" },
      costUnits: 1,
      maxAttempts: 3,
      attempts: 3,
      state: "failed",
      idempotencyKey: "stable",
      startedAt: rule.createdAt,
      completedAt: null,
      error: "upstream_failure",
      output: null,
    },
  ],
  budget: rule.budget,
  costUsed: 3,
  durationMs: 12,
  nextAttemptAt: null,
  leaseOwner: null,
  leaseUntil: null,
  createdAt: rule.createdAt,
  updatedAt: rule.createdAt,
  createdBy: "author",
};
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
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(automation.list).mockResolvedValue({ items: [], total: 0 });
  vi.mocked(automation.createRule).mockResolvedValue(rule);
  vi.mocked(automation.updateRule).mockResolvedValue(rule);
  vi.mocked(automation.runAction).mockResolvedValue(run);
  vi.mocked(automation.decide).mockResolvedValue({
    ...approval,
    state: "approved",
  });
  vi.mocked(automation.preview).mockResolvedValue({
    matched: true,
    explanation: {
      passed: true,
      description: "gate equals fail",
      field: "gate",
      actual: "fail",
      expected: "fail",
    },
    actions: rule.actions,
    writes: false,
  });
});
describe("条件与动作编辑", () => {
  it("可视条件和动作表单能创建实际规则，默认先停用", async () => {
    render(<AutomationRuleForm {...context} onSaved={vi.fn()} />);
    await user.type(screen.getByLabelText(/规则名称/), "审查失败记录");
    await user.click(screen.getByRole("button", { name: "保存自动化规则" }));
    await waitFor(() =>
      expect(automation.createRule).toHaveBeenCalledWith(
        "owner/repo",
        expect.objectContaining({
          name: "审查失败记录",
          enabled: false,
          condition: { field: "gate", op: "eq", value: "fail" },
          actions: [expect.objectContaining({ kind: "audit.record" })],
        }),
      ),
    );
  });
  it("添加审批动作提供独立审批选项，不只要求用户填写 JSON", async () => {
    render(<AutomationRuleForm {...context} onSaved={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "添加执行动作" }));
    const actions = document.querySelectorAll(".auto-action");
    const second = within(actions[1] as HTMLElement);
    fireEvent.change(second.getByLabelText("类型"), {
      target: { value: "approval.request" },
    });
    expect(screen.getByLabelText("审批标题")).toBeInTheDocument();
    expect(screen.getByLabelText("审批人必须与请求人不同")).toBeChecked();
  });
  it("只读账号不能保存或编辑，但可以用保存的规则试跑", async () => {
    render(
      <AutomationRuleForm
        {...context}
        viewer={{ ...context.viewer, canWrite: false }}
        initial={rule}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/规则名称/)).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "保存规则新版本" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "解释规则匹配" }));
    await waitFor(() =>
      expect(automation.preview).toHaveBeenCalledWith(
        "owner/repo",
        expect.objectContaining({ id: "rule-1", event: expect.any(Object) }),
      ),
    );
    expect(await screen.findByText("该事件会匹配规则")).toBeInTheDocument();
    expect(screen.getByText("gate equals fail")).toBeInTheDocument();
    expect(automation.createRule).not.toHaveBeenCalled();
  });
  it("JSON 条件语法错误显示原因，不保存上一份有效条件", async () => {
    render(
      <AutomationRuleForm {...context} initial={rule} onSaved={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("编辑方式"), {
      target: { value: "json" },
    });
    fireEvent.change(screen.getByLabelText("规则条件 JSON"), {
      target: { value: "{" },
    });
    await user.click(screen.getByRole("button", { name: "保存规则新版本" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("不是有效 JSON");
    expect(automation.updateRule).not.toHaveBeenCalled();
  });
  it("版本冲突保留当前输入，不显示保存成功", async () => {
    vi.mocked(automation.updateRule).mockRejectedValueOnce(
      new Error("规则版本已变化，请刷新"),
    );
    render(
      <AutomationRuleForm {...context} initial={rule} onSaved={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText(/规则名称/), {
      target: { value: "我的修改" },
    });
    await user.click(screen.getByRole("button", { name: "保存规则新版本" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("版本已变化");
    expect(screen.getByLabelText(/规则名称/)).toHaveValue("我的修改");
    expect(automation.updateRule).toHaveBeenCalledWith(
      "owner/repo",
      "rule-1",
      3,
      expect.objectContaining({ name: "我的修改" }),
    );
  });
});
describe("审批与执行边界", () => {
  it("请求人不能自行同意或拒绝要求独立操作者的审批", () => {
    render(
      <ApprovalCard
        {...context}
        viewer={{ ...context.viewer, userId: "author" }}
        approval={approval}
        onSaved={vi.fn()}
      />,
    );
    expect(
      screen.getByText("你是此步骤的请求人，需要另一位管理员审批。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "同意审批" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "拒绝执行" })).toBeDisabled();
  });
  it("另一位管理员确认后只提交审批，继续运行是独立操作", async () => {
    render(<ApprovalCard {...context} approval={approval} onSaved={vi.fn()} />);
    await user.type(screen.getByLabelText(/审批附言/), "已核查审查结果");
    await user.click(screen.getByRole("button", { name: "同意审批" }));
    expect(automation.decide).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "确认同意审批" }));
    await waitFor(() =>
      expect(automation.decide).toHaveBeenCalledWith(
        "owner/repo",
        "approval",
        true,
        "已核查审查结果",
      ),
    );
    expect(automation.runAction).not.toHaveBeenCalled();
  });
  it("只读管理员仍不能审批，也不能重试执行", () => {
    const readOnly = {
      ...context,
      viewer: { ...context.viewer, canWrite: false },
    };
    const rendered = render(
      <ApprovalCard {...readOnly} approval={approval} onSaved={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "同意审批" })).toBeDisabled();
    rendered.unmount();
    render(<AutomationRunCard {...readOnly} run={run} onRefresh={vi.fn()} />);
    expect(
      screen.queryByRole("button", { name: "重试失败步骤" }),
    ).not.toBeInTheDocument();
  });
  it("失败重试调用专用端点，展示真实每步错误", async () => {
    render(<AutomationRunCard {...context} run={run} onRefresh={vi.fn()} />);
    fireEvent.click(
      screen.getByText(/执行步骤、结果与错误/, { selector: "summary" }),
    );
    expect(screen.getByText("upstream_failure")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试失败步骤" }));
    await user.click(screen.getByRole("button", { name: "确认重试失败步骤" }));
    await waitFor(() =>
      expect(automation.runAction).toHaveBeenCalledWith(
        "owner/repo",
        "run-1",
        "retry",
      ),
    );
  });
  it("生成报告按文本显示，HTML 不会作为页面元素执行", async () => {
    vi.mocked(automation.list).mockResolvedValue({
      items: [
        {
          id: "artifact",
          repository: context.repository,
          runId: run.id,
          stepId: "step-1",
          format: "markdown",
          mediaType: "text/markdown",
          createdAt: rule.createdAt,
        },
      ],
      total: 1,
    });
    vi.mocked(automation.artifact).mockResolvedValue({
      id: "artifact",
      repository: context.repository,
      runId: run.id,
      stepId: "step-1",
      format: "markdown",
      mediaType: "text/markdown",
      createdAt: rule.createdAt,
      content: '<img src=x onerror="alert(1)">',
    });
    render(<AutomationReports {...context} />);
    await user.click(await screen.findByRole("button", { name: "纯文本预览" }));
    expect(
      await screen.findByText('<img src=x onerror="alert(1)">'),
    ).toBeInTheDocument();
    expect(document.querySelector(".auto-report-preview img")).toBeNull();
  });
});
describe("JSON 转条件树", () => {
  it("拒绝畸形 group 和过深结构，避免可视编辑崩溃", () => {
    for (const value of [
      { all: "wrong" },
      { not: null },
      { field: "gate", op: "eval" },
    ])
      expect(() => visualCondition(value)).toThrow();
    let tree: unknown = { field: "gate", op: "eq", value: "fail" };
    for (let i = 0; i < 15; i++) tree = { not: tree };
    expect(() => visualCondition(tree)).toThrow();
  });
});

describe("条件值与无效动作输入", () => {
  it("数字相等比较保存后仍是数字，不悄悄变成字符串", async () => {
    render(
      <AutomationRuleForm
        {...context}
        initial={{
          ...rule,
          condition: { field: "findings.new", op: "eq", value: 3 },
        }}
        onSaved={vi.fn()}
      />,
    );
    const value = screen.getByLabelText("比较值");
    expect(value).toHaveAttribute("type", "number");
    fireEvent.change(value, { target: { value: "4" } });
    await user.click(screen.getByRole("button", { name: "保存规则新版本" }));
    await waitFor(() =>
      expect(automation.updateRule).toHaveBeenCalledWith(
        "owner/repo",
        "rule-1",
        3,
        expect.objectContaining({
          condition: { field: "findings.new", op: "eq", value: 4 },
        }),
      ),
    );
  });
  it("动作 JSON 输入无效时，保存按钮不会悄悄提交上一份有效参数", async () => {
    render(
      <AutomationRuleForm
        {...context}
        initial={{
          ...rule,
          actions: [
            {
              kind: "finding.transition",
              input: {
                findingId: "finding-1",
                status: "acknowledged",
                reason: "已确认",
              },
              costUnits: 1,
              maxAttempts: 1,
            },
          ],
        }}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/动作参数 JSON/), {
      target: { value: "{" },
    });
    await user.click(screen.getByRole("button", { name: "保存规则新版本" }));
    expect(screen.getByRole("alert")).toHaveTextContent("不是有效 JSON");
    expect(automation.updateRule).not.toHaveBeenCalled();
  });
});
