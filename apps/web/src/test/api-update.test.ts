import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyUpdate, bumpCache, fetchUpdateHistory, fetchUpdateProgress, fetchUpdateStatus } from "../lib/api";
import { getJson } from "../lib/api/http";
import * as updateApi from "../lib/api/update";
import { setToken } from "../lib/auth";

const fetchMock = vi.fn<typeof fetch>();
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

beforeEach(() => {
  localStorage.clear();
  bumpCache();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("fresh update progress API", () => {
  it("reexports the modular update API and bypasses cached history without losing authentication", async () => {
    expect(fetchUpdateStatus).toBe(updateApi.fetchUpdateStatus);
    expect(fetchUpdateProgress).toBe(updateApi.fetchUpdateProgress);
    expect(fetchUpdateHistory).toBe(updateApi.fetchUpdateHistory);
    expect(applyUpdate).toBe(updateApi.applyUpdate);
    setToken("update-session");
    const cached = { items: [], currentVersion: "1.2.15", inProgress: true };
    const fresh = { items: [], currentVersion: "1.2.17", inProgress: false };
    fetchMock.mockResolvedValueOnce(jsonResponse(cached)).mockResolvedValueOnce(jsonResponse(fresh));
    await expect(getJson("/update/history")).resolves.toEqual(cached);
    const controller = new AbortController();
    await expect(fetchUpdateProgress(controller.signal)).resolves.toEqual(fresh);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith("/update/history", expect.objectContaining({
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
      headers: expect.objectContaining({ accept: "application/json", authorization: "Bearer update-session" }),
    }));
  });

  it("never reuses the GET history cache and disables browser caching on every read", async () => {
    const pending = { items: [{ at: "2026-11-13T10:00:00Z", from: "1.2.15", to: "v1.2.17", ok: true, status: "pending", id: "new" }], currentVersion: "1.2.15", inProgress: true };
    const confirmed = { items: [{ ...pending.items[0], status: "success" }], currentVersion: "1.2.17", inProgress: false };
    fetchMock.mockResolvedValueOnce(jsonResponse(pending)).mockResolvedValueOnce(jsonResponse(confirmed))
      .mockResolvedValueOnce(jsonResponse(confirmed));
    const controller = new AbortController();
    await expect(fetchUpdateProgress(controller.signal)).resolves.toEqual(pending);
    await expect(fetchUpdateProgress()).resolves.toEqual(confirmed);
    await expect(fetchUpdateHistory()).resolves.toEqual(confirmed.items);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe("/update/history");
      expect(init).toEqual(expect.objectContaining({ cache: "no-store", credentials: "same-origin", headers: expect.objectContaining({ accept: "application/json" }) }));
    }
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("preserves missing legacy metadata instead of fabricating confirmation", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [] }));
    await expect(fetchUpdateProgress()).resolves.toEqual({ items: [] });
  });

  it("rejects history 503 rather than returning an empty successful result", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ reason: "history_read_failed" }, 503));
    await expect(fetchUpdateProgress()).rejects.toThrow("request failed with 503");
  });

  it("fetches registry status freshly and retains nullable availability/stale metadata", async () => {
    const body = { current: { version: "unknown" }, latest: { version: null, tags: [], digest: null, stale: true, source: "mirror.example" }, updateAvailable: null, degraded: true };
    fetchMock.mockResolvedValue(jsonResponse(body));
    await expect(fetchUpdateStatus()).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/update/status", expect.objectContaining({ cache: "no-store" }));
  });

  it("posts the exact target only once and forwards cancellation", async () => {
    fetchMock.mockResolvedValue(new Response("event: done\ndata: {}\n\n"));
    const controller = new AbortController();
    await applyUpdate("v1.2.17", true, controller.signal);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/update/apply", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ target: "v1.2.17", backupBefore: true }),
      signal: controller.signal,
    }));
  });
});
