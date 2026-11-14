import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dollarsToMicros,
  formatDollars,
  normalizeRepository,
  nonnegativeNumber,
  parseJsonArray,
  workbench,
  WorkbenchError,
} from "../lib/workbench";
import { onUnauthorized } from "../lib/auth";

const fetchMock = vi.fn<typeof fetch>();
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  onUnauthorized(null);
});

describe("工作台 HTTP 边界", () => {
  it("每个只读请求携带当前仓库、认证和取消信号", async () => {
    const controller = new AbortController();
    localStorage.setItem("apertureprism.token", "session-for-test");
    fetchMock.mockResolvedValue(response({ items: [], total: 0 }));
    await workbench.list("findings", " owner/repo ", controller.signal);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("/api/workbench/findings?repository=owner%2Frepo");
    expect(init).toMatchObject({
      signal: controller.signal,
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        authorization: "Bearer session-for-test",
      },
    });
  });
  it("写入的仓库字段由当前范围决定，输入不能覆盖仓库", async () => {
    fetchMock.mockResolvedValue(response({ id: "created" }));
    await workbench.create("policies", "owner/current", {
      repository: "other/repo",
      name: "策略",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("repository=owner%2Fcurrent");
    expect(JSON.parse(String(init?.body))).toEqual({
      repository: "owner/current",
      name: "策略",
    });
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ "content-type": "application/json" });
  });
  it("资源标识按一个路径段编码，不能插入其他操作", async () => {
    fetchMock.mockResolvedValue(response({ id: "finding" }));
    await workbench.action("findings", "a/b?x=1", "transition", "owner/repo", {
      status: "fixed",
      reason: "已验证",
    });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "/api/workbench/findings/a%2Fb%3Fx%3D1/transition?repository=owner%2Frepo",
    );
  });
  it("401 通知登录边界，保留服务端可读原因", async () => {
    const unauthorized = vi.fn();
    onUnauthorized(unauthorized);
    fetchMock.mockResolvedValue(
      response(
        {
          error: { code: "session_expired", message: "会话已过期，请重新登录" },
        },
        401,
      ),
    );
    await expect(workbench.summary("owner/repo")).rejects.toMatchObject({
      status: 401,
      code: "session_expired",
      message: "会话已过期，请重新登录",
    });
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });
  it("403 不伪装成空集合，越权原因显示为错误", async () => {
    fetchMock.mockResolvedValue(
      response(
        {
          error: {
            code: "repository_forbidden",
            message: "没有当前仓库的查看权限",
          },
        },
        403,
      ),
    );
    await expect(workbench.list("budgets", "owner/private")).rejects.toThrow(
      "没有当前仓库的查看权限",
    );
  });
  it("代理返回 HTML 时仍报告真实状态，不泄露解析堆栈", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>bad gateway</html>", { status: 502 }),
    );
    await expect(workbench.summary("owner/repo")).rejects.toMatchObject({
      status: 502,
      code: "http_502",
      message: "工作台请求失败（502）",
    });
  });
  it("取消请求仍以取消原因退出，不转换成成功空列表", async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValue(new DOMException("Aborted", "AbortError"));
    await expect(
      workbench.list("audit", "owner/repo", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("报告请求传递选定格式并保留实际响应内容", async () => {
    fetchMock.mockResolvedValue(
      new Response("# Review\n", {
        headers: { "content-type": "text/markdown" },
      }),
    );
    const blob = await workbench.report("owner/repo", "markdown");
    // 只校验 Blob 的元数据：jsdom 的 Blob 未实现 text()/arrayBuffer()，而 fetch
    // 返回的 Blob 与 FileReader 不同 realm，直接读取会抛 TypeError。
    expect(blob.size).toBe(new TextEncoder().encode("# Review\n").length);
    expect(blob.type).toContain("text/markdown");
    expect(String(fetchMock.mock.calls[0]![0])).toContain("format=markdown");
  });
  it("非法仓库在发起网络请求前拒绝", async () => {
    await expect(workbench.summary("../etc/passwd")).rejects.toBeInstanceOf(
      WorkbenchError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("预算金额与表单数值", () => {
  it("小数金额转换不会累积浮点误差", () => {
    expect(dollarsToMicros("0.1") + dollarsToMicros("0.2")).toBe(300_000);
    expect(dollarsToMicros("1.000001")).toBe(1_000_001);
    expect(dollarsToMicros(" 12.34 ")).toBe(12_340_000);
    expect(dollarsToMicros("0")).toBe(0);
  });
  it("不接受指数、负数、超精度和不可安全表示的金额", () => {
    for (const value of [
      "",
      "-1",
      "1e6",
      "0.0000001",
      "Infinity",
      "9007199255",
      "1,000",
      ".2",
    ]) {
      expect(() => dollarsToMicros(value), value).toThrow();
    }
  });
  it("非负整数不悄悄接受空值、NaN、小数或超安全范围", () => {
    for (const value of [
      "",
      "-1",
      "2.5",
      "NaN",
      "Infinity",
      "9007199254740992",
    ])
      expect(() => nonnegativeNumber(value, "额度")).toThrow();
    expect(nonnegativeNumber("0", "额度")).toBe(0);
    expect(nonnegativeNumber("0.72", "置信度", false)).toBe(0.72);
  });
  it("格式化仍能看到微美元差异", () => {
    expect(formatDollars(1_000_001)).toContain("1.000001");
  });
});

describe("仓库与导入输入", () => {
  it("整理首尾空格，保留 GitHub 仓库标识的大小写", () => {
    expect(normalizeRepository(" AperturePrism/Review-UI ")).toBe(
      "AperturePrism/Review-UI",
    );
  });
  it("拒绝查询、片段、协议、额外路径段和空仓库", () => {
    for (const value of [
      "",
      "owner",
      "owner/repo/extra",
      "owner/repo?x=1",
      "https://github.com/a/b",
      "/owner/repo",
      "owner/",
      "owner/repo#x",
    ])
      expect(() => normalizeRepository(value)).toThrow();
  });
  it("导入只允许对象数组，不把字符串和数组当发现记录", () => {
    expect(parseJsonArray('[{"title":"发现"}]', "发现")).toEqual([
      { title: "发现" },
    ]);
    expect(parseJsonArray("[]", "发现")).toEqual([]);
    for (const value of ["{", "{}", "null", '["text"]', "[null]", "[[]]"])
      expect(() => parseJsonArray(value, "发现")).toThrow();
  });
});
