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
vi.mock("../lib/workbench", async (original) => {
  const actual = await original<typeof import("../lib/workbench")>();
  return {
    ...actual,
    workbench: {
      ...actual.workbench,
      list: vi.fn(),
      create: vi.fn(),
      action: vi.fn(),
      importFindings: vi.fn(),
      transitionFindings: vi.fn(),
      gate: vi.fn(),
      summary: vi.fn(),
      evaluate: vi.fn(),
      trends: vi.fn(),
      previewArchive: vi.fn(),
      restoreArchive: vi.fn(),
    },
  };
});
vi.mock("../lib/api", () => ({
  fetchRepositories: vi.fn(async () => ({
    items: [{ fullName: "owner/repo" }],
  })),
}));
import {
  workbench,
  type Finding,
  type Policy,
  type GateResult,
} from "../lib/workbench";
import { Policies } from "../features/workbench/policy";
import { Findings } from "../features/workbench/finding";
import { Suppressions } from "../features/workbench/suppression";
import { Batches } from "../features/workbench/batch";
import { Budgets } from "../features/workbench/budget";
import { Evaluations } from "../features/workbench/evaluation";
import { Intake } from "../features/workbench/intake";
import { GatePreview } from "../features/workbench/gate";
import { Archives } from "../features/workbench/archive";
import { Trends } from "../features/workbench/trend";
import { WorkbenchPage } from "../pages/WorkbenchPage";

const identity = {
  id: "record-1",
  repository: "owner/repo",
  createdAt: "2026-11-13T10:00:00Z",
  updatedAt: "2026-11-13T10:00:00Z",
  createdBy: "reviewer",
  revision: 1,
};
const finding: Finding = {
  ...identity,
  fingerprint: "stable",
  ruleId: "AUTH",
  title: "缺少权限检查",
  description: "低权限用户可以修改设置",
  path: "src/auth.ts",
  line: 10,
  endLine: 10,
  severity: "high",
  confidence: 0.9,
  status: "open",
  assignee: "",
  source: "test",
  reference: "main",
  tags: [],
  occurrences: 1,
  lastSeenAt: identity.updatedAt,
  history: [],
};
const rules = {
  blockedSeverities: [
    "critical",
    "high",
  ] as Policy["versions"][number]["rules"]["blockedSeverities"],
  maxNewFindings: 10,
  minConfidence: 0.7,
  requireBaseline: false,
  requireHumanApproval: false,
  includePaths: [],
  excludePaths: [],
  labels: [],
};
const policy: Policy = {
  ...identity,
  name: "默认策略",
  description: "仓库审核规则",
  enabled: true,
  activeVersion: 1,
  versions: [
    {
      version: 1,
      name: "默认策略",
      description: "仓库审核规则",
      rules,
      savedAt: identity.createdAt,
      savedBy: "reviewer",
      note: "首版",
    },
  ],
};
const gate: GateResult = {
  repository: "owner/repo",
  decision: "fail",
  policyId: policy.id,
  policyVersion: 1,
  baselineId: null,
  evaluatedAt: identity.createdAt,
  counts: { total: 1, new: 1, existing: 0, suppressed: 0, resolved: 0 },
  checks: [
    {
      name: "blocked_severity",
      decision: "fail",
      message: "一个新增高危发现阻止合入",
      findingIds: [finding.id],
    },
  ],
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
function creation(title: string) {
  const summary = screen.getByText(title, { selector: "summary" });
  fireEvent.click(summary);
  return within(summary.closest("details")!);
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  window.location.hash = "#/workbench";
  vi.mocked(workbench.list).mockResolvedValue({ items: [], total: 0 });
  vi.mocked(workbench.create).mockResolvedValue({ ...finding });
  vi.mocked(workbench.action).mockResolvedValue({ ...finding, revision: 2 });
  vi.mocked(workbench.importFindings).mockResolvedValue({
    items: [finding],
    imported: 1,
  });
  vi.mocked(workbench.transitionFindings).mockResolvedValue({
    items: [finding],
  });
  vi.mocked(workbench.gate).mockResolvedValue(gate);
});

describe("仓库范围入口", () => {
  it("没有仓库时显示范围选择，不请求或伪造审查数据", async () => {
    render(<WorkbenchPage />);
    expect(screen.getByText("先选择需要管理的仓库")).toBeInTheDocument();
    expect(workbench.list).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.querySelector("datalist option")).toHaveAttribute(
        "value",
        "owner/repo",
      ),
    );
  });
  it("非法仓库保持输入并显示原因，不发起工作台请求", async () => {
    render(<WorkbenchPage />);
    await user.type(screen.getByLabelText("当前仓库"), "../private");
    await user.click(screen.getByRole("button", { name: "进入仓库" }));
    expect(screen.getByRole("alert")).toHaveTextContent("owner/name");
    expect(workbench.summary).not.toHaveBeenCalled();
  });
});

describe("策略编辑与版本", () => {
  it("创建表单提交真实规则和整理后的名称", async () => {
    render(<Policies repository="owner/repo" />);
    await screen.findByText("尚未创建审查策略");
    const form = creation("创建策略");
    await user.type(form.getByLabelText(/策略名称/), "  核心规则  ");
    await user.click(form.getByLabelText("要求已有生效基线"));
    await user.click(form.getByRole("button", { name: "创建策略" }));
    await waitFor(() =>
      expect(workbench.create).toHaveBeenCalledWith(
        "policies",
        "owner/repo",
        expect.objectContaining({
          name: "核心规则",
          rules: expect.objectContaining({
            requireBaseline: true,
            blockedSeverities: ["critical", "high"],
          }),
        }),
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("策略已创建");
  });
  it("保存失败保留填写内容并展示可操作原因", async () => {
    vi.mocked(workbench.create).mockRejectedValueOnce(
      new Error("没有当前仓库的管理权限"),
    );
    render(<Policies repository="owner/repo" />);
    await screen.findByText("尚未创建审查策略");
    const form = creation("创建策略");
    await user.type(form.getByLabelText(/策略名称/), "保留的名称");
    await user.click(form.getByRole("button", { name: "创建策略" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("管理权限");
    expect(form.getByLabelText(/策略名称/)).toHaveValue("保留的名称");
  });
  it("启停策略必须先确认，取消不提交写请求", async () => {
    vi.mocked(workbench.list).mockResolvedValue({ items: [policy], total: 1 });
    render(<Policies repository="owner/repo" />);
    await screen.findByText("默认策略", { selector: "h3" });
    await user.click(screen.getByRole("button", { name: "停用策略" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("门禁结果");
    await user.click(screen.getByRole("button", { name: "返回" }));
    expect(workbench.action).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "停用策略" }));
    await user.click(screen.getByRole("button", { name: "确认停用策略" }));
    await waitFor(() =>
      expect(workbench.action).toHaveBeenCalledWith(
        "policies",
        policy.id,
        "toggle",
        "owner/repo",
        { enabled: false },
      ),
    );
  });
});

describe("发现与处置", () => {
  it("按照风险和状态显示真实发现，可以整批原子处置", async () => {
    vi.mocked(workbench.list).mockResolvedValue({ items: [finding], total: 1 });
    render(<Findings repository="owner/repo" />);
    await screen.findByText("缺少权限检查", { selector: "h3" });
    await user.click(screen.getByLabelText("选择发现 缺少权限检查"));
    fireEvent.click(
      screen.getByText(/批量处置（已选 1 个）/, { selector: "summary" }),
    );
    await user.type(screen.getByLabelText(/处置原因/), "人工确认问题成立");
    await user.click(screen.getByRole("button", { name: "处置选中的发现" }));
    await waitFor(() =>
      expect(workbench.transitionFindings).toHaveBeenCalledWith(
        "owner/repo",
        [finding.id],
        "acknowledged",
        "人工确认问题成立",
      ),
    );
    expect(
      await screen.findByText(/同一个事务中处置 1 个/),
    ).toBeInTheDocument();
  });
  it("空白原因不会提交批量写入", async () => {
    vi.mocked(workbench.list).mockResolvedValue({ items: [finding], total: 1 });
    render(<Findings repository="owner/repo" />);
    await screen.findByText("缺少权限检查", { selector: "h3" });
    await user.click(screen.getByLabelText("选择发现 缺少权限检查"));
    fireEvent.click(
      screen.getByText(/批量处置（已选 1 个）/, { selector: "summary" }),
    );
    await user.type(screen.getByLabelText(/处置原因/), "   ");
    await user.click(screen.getByRole("button", { name: "处置选中的发现" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("说明原因");
    expect(workbench.transitionFindings).not.toHaveBeenCalled();
  });
});

describe("抑制与批次的输入边界", () => {
  it("不允许创建无任何匹配条件的全局抑制", async () => {
    render(<Suppressions repository="owner/repo" />);
    await screen.findByText("尚未设置抑制规则");
    const form = creation("添加抑制规则");
    await user.type(form.getByLabelText(/规则名称/), "临时已知问题");
    await user.type(form.getByLabelText(/抑制原因/), "正在迁移");
    await user.click(form.getByRole("button", { name: "创建抑制规则" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("至少填写");
    expect(workbench.create).not.toHaveBeenCalled();
  });
  it("批次逐行模式会去重并传递共同引用", async () => {
    render(<Batches repository="owner/repo" />);
    await screen.findByText("没有匹配的批次");
    const form = creation("创建审查批次");
    await user.type(form.getByLabelText(/批次名称/), "每周审查");
    await user.type(form.getByLabelText(/审查对象/), "pr:12\npr:12\npr:13");
    fireEvent.change(form.getByLabelText(/共同引用/), {
      target: { value: "current" },
    });
    await user.click(form.getByRole("button", { name: "创建批次草稿" }));
    await waitFor(() =>
      expect(workbench.create).toHaveBeenCalledWith(
        "batches",
        "owner/repo",
        expect.objectContaining({
          name: "每周审查",
          concurrency: 2,
          items: [
            { subject: "pr:12", reference: "current", dependencies: [] },
            { subject: "pr:13", reference: "current", dependencies: [] },
          ],
        }),
      ),
    );
  });
});

describe("预算与评估", () => {
  it("金额按整数微美元提交，时间窗口按 UTC 提交", async () => {
    render(<Budgets repository="owner/repo" />);
    await screen.findByText("尚未配置预算");
    const form = creation("创建预算窗口");
    fireEvent.change(form.getByLabelText(/预算名称/), {
      target: { value: "月度预算" },
    });
    fireEvent.change(form.getByLabelText(/美元额度/), {
      target: { value: "0.100001" },
    });
    fireEvent.change(form.getByLabelText(/开始时间/), {
      target: { value: "2026-11-01T00:00" },
    });
    fireEvent.change(form.getByLabelText(/结束时间/), {
      target: { value: "2026-12-01T00:00" },
    });
    fireEvent.change(form.getByLabelText(/输入 token 额度/), {
      target: { value: "1000" },
    });
    fireEvent.change(form.getByLabelText(/输出 token 额度/), {
      target: { value: "500" },
    });
    fireEvent.change(form.getByLabelText(/请求次数额度/), {
      target: { value: "10" },
    });
    await user.click(form.getByRole("button", { name: "创建预算" }));
    await waitFor(() =>
      expect(workbench.create).toHaveBeenCalledWith(
        "budgets",
        "owner/repo",
        expect.objectContaining({
          limits: {
            amountMicros: 100001,
            inputTokens: 1000,
            outputTokens: 500,
            requests: 10,
          },
        }),
      ),
    );
  });
  it("评估不接受零样本，避免出现虚假的满分结果", async () => {
    render(<Evaluations repository="owner/repo" />);
    await screen.findByText("还没有评估记录");
    const form = creation("创建评估记录");
    await user.type(form.getByLabelText(/评估名称/), "回归对照");
    await user.type(form.getByLabelText(/模型或运行标识/), "reviewer-v2");
    await user.click(form.getByRole("button", { name: "保存并评估" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "至少需要一个样本",
    );
    expect(workbench.create).not.toHaveBeenCalled();
  });
});

describe("导入预览与门禁试算", () => {
  it("导入前必须先验证和核对，之后调用整批事务接口", async () => {
    render(<Intake repository="owner/repo" />);
    fireEvent.change(screen.getByLabelText("导入格式"), {
      target: { value: "json" },
    });
    fireEvent.change(screen.getByLabelText(/报告内容/), {
      target: {
        value: JSON.stringify([
          {
            title: finding.title,
            ruleId: finding.ruleId,
            path: finding.path,
            line: 10,
            severity: "high",
          },
        ]),
      },
    });
    await user.click(screen.getByRole("button", { name: "验证并预览" }));
    expect(await screen.findByText("导入预览：1 个发现")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "导入 1 个发现" });
    expect(save).toBeDisabled();
    expect(workbench.importFindings).not.toHaveBeenCalled();
    await user.click(screen.getByLabelText("我已核对仓库范围和导入内容"));
    await user.click(save);
    await waitFor(() =>
      expect(workbench.importFindings).toHaveBeenCalledWith("owner/repo", [
        expect.objectContaining({
          title: finding.title,
          path: "src/auth.ts",
          source: "json-import",
        }),
      ]),
    );
  });
  it("改变预览内容会清除先前确认，不会导入旧预览", async () => {
    render(<Intake repository="owner/repo" />);
    fireEvent.change(screen.getByLabelText("导入格式"), {
      target: { value: "json" },
    });
    const input = screen.getByLabelText(/报告内容/);
    fireEvent.change(input, {
      target: {
        value: JSON.stringify([{ title: "first", ruleId: "R", path: "a.ts" }]),
      },
    });
    await user.click(screen.getByRole("button", { name: "验证并预览" }));
    await user.click(screen.getByLabelText("我已核对仓库范围和导入内容"));
    fireEvent.change(input, { target: { value: "[]" } });
    expect(
      screen.queryByRole("button", { name: "导入 1 个发现" }),
    ).not.toBeInTheDocument();
    expect(workbench.importFindings).not.toHaveBeenCalled();
  });
  it("试算明确传递人工确认选项，只执行 GET 计算不修改策略", async () => {
    render(<GatePreview repository="owner/repo" />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "计算门禁" }),
      ).not.toBeDisabled(),
    );
    await user.click(
      screen.getByLabelText("模拟已取得人工确认（仅本次只读试算）"),
    );
    await user.click(screen.getByRole("button", { name: "计算门禁" }));
    await waitFor(() =>
      expect(workbench.gate).toHaveBeenCalledWith(
        "owner/repo",
        expect.any(AbortSignal),
        { policyId: "", baselineId: "", humanApproved: true },
      ),
    );
    expect(
      await screen.findByText("一个新增高危发现阻止合入"),
    ).toBeInTheDocument();
    expect(workbench.create).not.toHaveBeenCalled();
    expect(workbench.action).not.toHaveBeenCalled();
  });
});

describe("归档与真实趋势", () => {
  it("管理员预览后仍需确认校验和、替换范围及最终操作", async () => {
    const archive = {
      format: "apertureprism-workbench-archive",
      version: 1,
      repository: "owner/repo",
      checksum: "a".repeat(64),
      data: {},
    };
    const counts = {
      policies: 1,
      baselines: 0,
      findings: 1,
      suppressions: 0,
      batches: 0,
      feedback: 0,
      budgets: 0,
      reservations: 0,
      evaluations: 0,
      reviews: 0,
      audit: 1,
    };
    vi.mocked(workbench.previewArchive).mockResolvedValue({
      repository: "owner/repo",
      createdAt: identity.createdAt,
      checksum: archive.checksum,
      counts,
      currentCounts: { ...counts, findings: 2 },
      warnings: ["运行租约将清除"],
      canRestore: true,
    });
    vi.mocked(workbench.restoreArchive).mockResolvedValue({ restored: true });
    render(<Archives repository="owner/repo" />);
    const file = new File([JSON.stringify(archive)], "review-backup.json", {
      type: "application/json",
    });
    Object.defineProperty(file, "text", {
      value: async () => JSON.stringify(archive),
    });
    fireEvent.change(screen.getByLabelText(/选择工作台归档/), {
      target: { files: [file] },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "校验并预览影响" }),
      ).not.toBeDisabled(),
    );
    await user.click(screen.getByRole("button", { name: "校验并预览影响" }));
    expect(await screen.findByText("运行租约将清除")).toBeInTheDocument();
    const restore = screen.getByRole("button", {
      name: "恢复当前仓库",
    });
    expect(restore).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/确认校验和/), {
      target: { value: archive.checksum },
    });
    await user.click(
      screen.getByLabelText("我已备份当前数据，并理解这将替换当前仓库记录"),
    );
    await user.click(restore);
    expect(workbench.restoreArchive).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "确认恢复当前仓库" }));
    await waitFor(() =>
      expect(workbench.restoreArchive).toHaveBeenCalledWith(
        "owner/repo",
        archive,
        archive.checksum,
      ),
    );
  });
  it("趋势使用服务器日桶，不凭计划次数推算完成审查", async () => {
    vi.mocked(workbench.trends).mockResolvedValue({
      repository: "owner/repo",
      since: "2026-11-01T00:00:00Z",
      until: "2026-11-13T00:00:00Z",
      daily: [
        {
          date: "2026-11-12",
          reviews: 3,
          imported: 7,
          resolved: 2,
          gatePass: 1,
          gateWarn: 1,
          gateFail: 1,
        },
      ],
      rules: [],
      owners: [],
      aging: { under7Days: 1, days7To30: 0, days30To90: 0, over90Days: 0 },
      totals: {
        reviews: 3,
        imported: 7,
        resolved: 2,
        failRate: 1 / 3,
        fixedFindings: 2,
        reopenedFindings: 0,
      },
    });
    render(<Trends repository="owner/repo" />);
    expect(await screen.findByText("33.3%")).toBeInTheDocument();
    expect(workbench.trends).toHaveBeenCalledWith(
      "owner/repo",
      30,
      expect.any(AbortSignal),
    );
    fireEvent.click(screen.getByText("每日完整数据", { selector: "summary" }));
    expect(
      screen.getByText("2026-11-12", { selector: "td" }),
    ).toBeInTheDocument();
  });
});
