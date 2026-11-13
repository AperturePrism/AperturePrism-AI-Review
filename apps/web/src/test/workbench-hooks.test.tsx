import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useWorkbenchCollection,
  useWorkbenchMutation,
} from "../hooks/useWorkbench";
import { workbench } from "../lib/workbench";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
afterEach(() => vi.restoreAllMocks());

describe("仓库切换与请求竞争", () => {
  it("取消旧仓库请求，不让晚到响应覆盖新仓库", async () => {
    const first = deferred<{ items: never[]; total: number }>();
    const second = deferred<{ items: never[]; total: number }>();
    const fetchList = vi
      .spyOn(workbench, "list")
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { result, rerender } = renderHook(
      ({ repository }) => useWorkbenchCollection("policies", repository),
      { initialProps: { repository: "owner/first" } },
    );
    expect(result.current.loading).toBe(true);
    const oldSignal = fetchList.mock.calls[0]![2];
    rerender({ repository: "owner/second" });
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => {
      second.resolve({ items: [], total: 0 });
    });
    expect(result.current.loading).toBe(false);
    await act(async () => {
      first.reject(new Error("旧仓库不可用"));
    });
    expect(result.current.error).toBeNull();
  });
  it("失败保持错误态，显式刷新能够恢复", async () => {
    const fetchList = vi
      .spyOn(workbench, "list")
      .mockRejectedValueOnce(new Error("仓库无权访问"))
      .mockResolvedValueOnce({ items: [], total: 0 });
    const { result } = renderHook(() =>
      useWorkbenchCollection("findings", "owner/repo"),
    );
    await waitFor(() => expect(result.current.error).toBe("仓库无权访问"));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(fetchList).toHaveBeenCalledTimes(2);
  });
  it("卸载会取消网络读取", () => {
    const fetchList = vi
      .spyOn(workbench, "list")
      .mockImplementation(() => new Promise(() => {}));
    const { unmount } = renderHook(() =>
      useWorkbenchCollection("audit", "owner/repo"),
    );
    const signal = fetchList.mock.calls[0]![2];
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});

describe("写入互斥与反馈", () => {
  it("同一帧双击只提交一次，成功后只刷新一次", async () => {
    const pending = deferred<unknown>();
    const action = vi.fn(() => pending.promise);
    const refresh = vi.fn();
    const { result } = renderHook(() => useWorkbenchMutation(refresh));
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.run(action, "已保存");
      second = result.current.run(action, "重复");
    });
    expect(action).toHaveBeenCalledTimes(1);
    await expect(second).resolves.toBe(false);
    expect(result.current.busy).toBe(true);
    await act(async () => {
      pending.resolve({});
      await first;
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.message).toBe("已保存");
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it("失败不会刷新或显示成功，重试可以正常执行", async () => {
    const refresh = vi.fn();
    const action = vi
      .fn()
      .mockRejectedValueOnce(new Error("记录已发生变化"))
      .mockResolvedValueOnce({});
    const { result } = renderHook(() => useWorkbenchMutation(refresh));
    await act(async () => {
      await result.current.run(action, "已保存");
    });
    expect(result.current.error).toBe("记录已发生变化");
    expect(result.current.message).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.run(action, "已保存");
    });
    expect(result.current.error).toBeNull();
    expect(result.current.message).toBe("已保存");
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
