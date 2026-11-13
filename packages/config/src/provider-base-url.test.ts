import { describe, expect, it } from "vitest";
import { loadConfig } from "./index.js";
const environment = {
  DATABASE_URL: "postgres://user:pass@localhost/prism",
  REDIS_URL: "redis://localhost",
};

describe("model provider base URL configuration", () => {
  it.each([
    "",
    "/v1",
    "models.example/v1",
    "ftp://models.example/v1",
    "file:///tmp/model",
    "data:text/plain,model",
    "ws://localhost/v1",
    "http://",
  ])("rejects unusable provider base URL %j at startup", (baseUrl) => {
    expect(() =>
      loadConfig({
        ...environment,
        MODEL_PROVIDER_BASE_URLS: JSON.stringify({ primary: baseUrl }),
      }),
    ).toThrow(/MODEL_PROVIDER_BASE_URLS/);
  });

  it("rejects a mixed map instead of keeping an unusable fallback", () => {
    expect(() =>
      loadConfig({
        ...environment,
        MODEL_PROVIDER_BASE_URLS: JSON.stringify({
          primary: "https://models.example/v1",
          fallback: "relative/v1",
        }),
      }),
    ).toThrow(/MODEL_PROVIDER_BASE_URLS/);
  });

  it("accepts HTTP local gateways and HTTPS hosted endpoints unchanged", () => {
    const urls = {
      local: "http://127.0.0.1:11434/v1",
      remote: "https://models.example/v1/",
    };
    expect(
      loadConfig({
        ...environment,
        MODEL_PROVIDER_BASE_URLS: JSON.stringify(urls),
      }).modelProviderBaseUrls,
    ).toEqual(urls);
  });

  it("keeps absent, empty and empty-object configuration compatible", () => {
    for (const value of [undefined, "", "{}"]) {
      expect(
        loadConfig({
          ...environment,
          ...(value === undefined ? {} : { MODEL_PROVIDER_BASE_URLS: value }),
        }).modelProviderBaseUrls,
      ).toEqual({});
    }
  });
});
