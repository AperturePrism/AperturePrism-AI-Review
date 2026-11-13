import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bumpCache, fetchMe } from "../lib/api";
import { setToken } from "../lib/auth";

const fetchMock = vi.fn();
const account = (login: string) => new Response(JSON.stringify({ login }), {
  headers: { "content-type": "application/json" },
});

beforeEach(() => {
  localStorage.clear();
  bumpCache();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("GET cache authentication isolation", () => {
  it("does not reuse the previous account's cached response after a token change", async () => {
    setToken("alice-token");
    fetchMock.mockResolvedValueOnce(account("alice"));
    expect((await fetchMe()).login).toBe("alice");
    setToken("bob-token");
    fetchMock.mockResolvedValueOnce(account("bob"));
    expect((await fetchMe()).login).toBe("bob");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1].headers.authorization).toBe("Bearer bob-token");
  });

  it("does not return authenticated account data after logging out", async () => {
    setToken("alice-token");
    fetchMock.mockResolvedValueOnce(account("alice"));
    await fetchMe();
    setToken("");
    fetchMock.mockResolvedValueOnce(account("anonymous"));
    expect((await fetchMe()).login).toBe("anonymous");
    expect(fetchMock.mock.calls[1]?.[1].headers.authorization).toBeUndefined();
  });

  it("does not let a late response from the old account replace the new cache", async () => {
    let resolveAlice!: (response: Response) => void;
    setToken("alice-token");
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolveAlice = resolve;
    }));
    const aliceRequest = fetchMe();
    setToken("bob-token");
    fetchMock.mockResolvedValueOnce(account("bob"));
    expect((await fetchMe()).login).toBe("bob");
    resolveAlice(account("alice"));
    await aliceRequest;
    expect((await fetchMe()).login).toBe("bob");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("continues caching repeated reads for the same account", async () => {
    setToken("alice-token");
    fetchMock.mockResolvedValueOnce(account("alice"));
    await fetchMe();
    expect((await fetchMe()).login).toBe("alice");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
