import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { triggerManualTask } from "../lib/api";

const input = {
  type: "pr" as const,
  repositoryFullName: "acme/widget",
  subjectNumber: 40,
};
const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("manual task API result", () => {
  it.each([
    { outcome: "created", taskStatus: "queued" },
    { outcome: "requeued", taskStatus: "queued" },
    { outcome: "duplicate", taskStatus: "running" },
    { outcome: "duplicate", taskStatus: "completed" },
  ])("preserves $outcome / $taskStatus for accurate feedback", async (result) => {
    const body = { status: "ok", taskId: "task-1", ...result };
    fetchMock.mockResolvedValue(jsonResponse(body));

    await expect(triggerManualTask(input)).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      "/tasks/manual",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  });

  it("accepts older servers that do not return taskStatus", async () => {
    const body = { status: "ok", taskId: "task-1", outcome: "duplicate" };
    fetchMock.mockResolvedValue(jsonResponse(body));
    await expect(triggerManualTask(input)).resolves.toEqual(body);
  });

  it("does not report a successful retry when repository manage access is denied", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ status: "error", reason: "repository_manage_required" }, 403),
    );
    await expect(triggerManualTask(input)).rejects.toThrow("repository_manage_required");
  });
});
