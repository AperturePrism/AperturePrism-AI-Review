import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchModels } from "../lib/api/provider";
import { setToken } from "../lib/auth";

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  localStorage.clear();
  fetchMock
    .mockReset()
    .mockResolvedValue(
      new Response(JSON.stringify({ models: ["m"] }), { status: 200 }),
    );
  vi.stubGlobal("fetch", fetchMock);
  setToken("local-admin-session");
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("provider model discovery request", () => {
  it("sends only the saved account identity and address, without a credential placeholder", async () => {
    await expect(
      fetchModels("https://api.example.test/v1", "", {
        provider: "p",
        accountName: "a",
      }),
    ).resolves.toEqual(["m"]);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/setup/models");
    expect(options?.headers).toMatchObject({
      authorization: "Bearer local-admin-session",
    });
    expect(JSON.parse(options!.body as string)).toEqual({
      baseUrl: "https://api.example.test/v1",
      provider: "p",
      accountName: "a",
    });
  });
  it("preserves explicit new-key discovery for the install wizard and replacement keys", async () => {
    await fetchModels("https://api.example.test/v1", "local-new-provider-key");
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      baseUrl: "https://api.example.test/v1",
      apiKey: "local-new-provider-key",
    });
  });
  it("shows a bounded server failure rather than an empty success list", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          reason: "saved_credential_unavailable",
          hint: "请检查凭据配置或替换密钥",
        }),
        { status: 503 },
      ),
    );
    await expect(
      fetchModels("https://api.example.test/v1", "", {
        provider: "p",
        accountName: "a",
      }),
    ).rejects.toThrow("请检查凭据配置或替换密钥");
  });
});
