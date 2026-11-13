import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  automation,
  AutomationRequestError,
  parseAutomationObject,
} from "../lib/automation";
import { onUnauthorized } from "../lib/auth";
const fetchMock = vi.fn<typeof fetch>();
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  onUnauthorized(null);
});
describe("自动化 HTTP 边界", () => {
  it("只读查询发送 GET、当前仓库及取消信号", async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValue(
      response({ status: "ok", data: { items: [], total: 0 } }),
    );
    await automation.list(
      "runs",
      " Owner/Repo ",
      { state: "waiting", limit: 50, offset: 100 },
      controller.signal,
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    const query = new URL(String(url), "http://test").searchParams;
    expect(query.get("action")).toBe("runs.list");
    expect(query.get("repository")).toBe("owner/repo");
    expect(query.get("offset")).toBe("100");
    expect(query.get("state")).toBe("waiting");
    expect(init).toMatchObject({
      method: "GET",
      signal: controller.signal,
      credentials: "same-origin",
    });
  });
  it("POST 规则不能用输入覆盖当前仓库或规则版本", async () => {
    localStorage.setItem("apertureprism.token", "test-session");
    fetchMock.mockResolvedValue(
      response({ status: "ok", data: { id: "rule" } }),
    );
    await automation.updateRule("owner/current", "real-rule", 3, {
      repository: "other/private",
      id: "false-rule",
      version: 1,
      name: "规则",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/automation");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer test-session",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      action: "rules.update",
      input: {
        repository: "owner/current",
        id: "real-rule",
        version: 3,
        name: "规则",
      },
    });
  });
  it("只读试跑使用 POST 传完整对象，但不会转成 events.dispatch", async () => {
    fetchMock.mockResolvedValue(
      response({ status: "ok", data: { writes: false } }),
    );
    await automation.preview("owner/repo", {
      id: "rule",
      event: { id: "e", gate: "fail" },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject(
      {
        action: "rules.preview",
        input: {
          repository: "owner/repo",
          id: "rule",
          event: { id: "e", gate: "fail" },
        },
      },
    );
  });
  it("审批必须发送明确布尔决定和附言", async () => {
    fetchMock.mockResolvedValue(
      response({ status: "ok", data: { state: "rejected" } }),
    );
    await automation.decide(
      "owner/repo",
      "approval-1",
      false,
      "需要修改后再提交",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      action: "approvals.decide",
      input: {
        repository: "owner/repo",
        id: "approval-1",
        approved: false,
        note: "需要修改后再提交",
      },
    });
  });
  it("重试调用真实 runs.retry，取消调用 runs.cancel", async () => {
    fetchMock.mockImplementation(async () =>
      response({ status: "ok", data: { id: "run" } }),
    );
    await automation.runAction("owner/repo", "run", "retry");
    await automation.runAction("owner/repo", "run", "cancel");
    expect(
      fetchMock.mock.calls.map(
        ([, init]) => JSON.parse(String(init?.body)).action,
      ),
    ).toEqual(["runs.retry", "runs.cancel"]);
  });
  it("401 触发登录边界，保留服务端原因", async () => {
    const unauthorized = vi.fn();
    onUnauthorized(unauthorized);
    fetchMock.mockResolvedValue(
      response(
        { status: "error", code: "unauthorized", reason: "会话已失效" },
        401,
      ),
    );
    await expect(automation.summary("owner/repo")).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
      message: "会话已失效",
    });
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });
  it("200 错误包也不能被当作写入成功", async () => {
    fetchMock.mockResolvedValue(
      response({
        status: "error",
        code: "version_conflict",
        reason: "规则版本已变化",
      }),
    );
    await expect(automation.createRule("owner/repo", {})).rejects.toThrow(
      "规则版本已变化",
    );
  });
  it("非 JSON 代理错误保留 HTTP 状态", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>gateway error</html>", { status: 502 }),
    );
    await expect(automation.summary("owner/repo")).rejects.toMatchObject({
      status: 502,
      code: "http_502",
    });
  });
  it("越权和自审批失败不会变成空结果", async () => {
    fetchMock.mockResolvedValue(
      response(
        {
          status: "error",
          code: "different_approver_required",
          reason: "需要另一位管理员",
        },
        403,
      ),
    );
    await expect(
      automation.decide("owner/repo", "approval", true, ""),
    ).rejects.toBeInstanceOf(AutomationRequestError);
  });
  it("恶意路径仓库在网络边界前拒绝", async () => {
    await expect(automation.summary("../private")).rejects.toThrow(
      "owner/name",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
describe("规则编辑输入", () => {
  it("仅允许对象 JSON，不把 null、数组或脚本当作条件", () => {
    for (const value of ["null", "[]", "(()=>42)()", "{", "false"])
      expect(() => parseAutomationObject(value, "规则")).toThrow();
    expect(
      parseAutomationObject(
        '{"field":"gate","op":"eq","value":"fail"}',
        "规则",
      ),
    ).toEqual({ field: "gate", op: "eq", value: "fail" });
  });
});
