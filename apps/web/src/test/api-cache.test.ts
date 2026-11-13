import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bumpCache, fetchTasks } from "../lib/api";
import { getJson } from "../lib/api/http";
import { onUnauthorized, setToken } from "../lib/auth";
const fetchMock = vi.fn<typeof fetch>();
function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200 });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
  bumpCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  onUnauthorized(null);
});

describe("拆分后的单一 HTTP 缓存", () => {
  it("兼容出口与主体入口共用同一缓存", async () => {
    fetchMock.mockImplementation(async () => json({ items: [] }));
    await fetchTasks();
    await getJson("/tasks");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    bumpCache();
    await getJson("/tasks");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("账号切换后相同 URL 也必须重新请求", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ user: "first" }))
      .mockResolvedValueOnce(json({ user: "second" }));
    setToken("first-session");
    expect(await getJson("/users/me")).toEqual({ user: "first" });
    setToken("second-session");
    expect(await getJson("/users/me")).toEqual({ user: "second" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("退出登录不复用带认证取得的缓存", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ private: true }))
      .mockResolvedValueOnce(new Response("", { status: 401 }));
    setToken("session");
    await getJson("/private");
    setToken("");
    await expect(getJson("/private")).rejects.toThrow("unauthorized");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("并发 GET 合并，失败后允许下一次真实重试", async () => {
    const delayed = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(delayed.promise)
      .mockResolvedValueOnce(json({ ok: true }));
    const first = getJson("/summary");
    const second = getJson("/summary");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    delayed.resolve(new Response("", { status: 503 }));
    const failures = await Promise.allSettled([first, second]);
    expect(failures.every((value) => value.status === "rejected")).toBe(true);
    expect(await getJson("/summary")).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("写入前发起的旧 GET 不会覆盖写入后的新响应", async () => {
    const old = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(json({ revision: 2 }));
    const first = getJson("/settings");
    bumpCache();
    expect(await getJson("/settings")).toEqual({ revision: 2 });
    old.resolve(json({ revision: 1 }));
    await first;
    expect(await getJson("/settings")).toEqual({ revision: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("旧账号晚到响应不会覆盖新账号数据", async () => {
    const old = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(json({ user: "second" }));
    setToken("first");
    const first = getJson("/users/me");
    setToken("second");
    expect(await getJson("/users/me")).toEqual({ user: "second" });
    old.resolve(json({ user: "first" }));
    await first;
    expect(await getJson("/users/me")).toEqual({ user: "second" });
  });
  it("缓存条目有硬上限，短时间访问大量 URL 仍会淘汰最老条目", async () => {
    fetchMock.mockImplementation(async (url) => json({ url }));
    for (let index = 0; index < 105; index += 1)
      await getJson(`/tasks/${index}`);
    await getJson("/tasks/104");
    expect(fetchMock).toHaveBeenCalledTimes(105);
    await getJson("/tasks/0");
    expect(fetchMock).toHaveBeenCalledTimes(106);
  });
  it("TTL 过期后重新请求最新内容", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(json({ revision: 1 }))
      .mockResolvedValueOnce(json({ revision: 2 }));
    expect(await getJson("/summary")).toEqual({ revision: 1 });
    vi.advanceTimersByTime(5_001);
    expect(await getJson("/summary")).toEqual({ revision: 2 });
  });
});
