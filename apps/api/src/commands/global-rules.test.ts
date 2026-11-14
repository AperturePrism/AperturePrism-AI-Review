/** 真实 HTTP 验证全局规则读取、预览、保存与权限边界。 */
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
vi.mock("../runtime.js", () => ({
  database: { db: {} },
  logger: { warn: vi.fn() },
  config: {},
}));
vi.mock("../identity.js", () => ({
  audit: vi.fn(),
  isAdminRequest: vi.fn(),
  isReadOnlyRequest: vi.fn(),
}));
import {
  GlobalReviewRulesConflict,
  globalReviewRulesHash,
} from "../../../../packages/database/src/global-review-rules.js";
import {
  createGlobalRulesRoutes,
  MAX_GLOBAL_RULES_BYTES,
  type GlobalRulesServices,
} from "./global-rules.js";
import { dispatch, orderRoutes } from "../utils/routes.js";
import { HttpError } from "../utils/http.js";
import { RuleSourceError } from "../../../../packages/github-adapter/src/rule-source.js";

function services(content = "既有全局规则") {
  let saved = {
    content,
    contentHash: globalReviewRulesHash(content),
    updatedAt: "2026-11-14T00:00:00.000Z",
  };
  return {
    isAdmin: vi.fn(async () => true),
    isReadOnly: vi.fn(async () => false),
    load: vi.fn(async () => saved),
    save: vi.fn<GlobalRulesServices["save"]>(async (input) => {
      if (input.expectedContentHash !== saved.contentHash)
        throw new GlobalReviewRulesConflict(saved.contentHash);
      saved = {
        content: input.content,
        contentHash: globalReviewRulesHash(input.content),
        updatedAt: "2026-11-14T01:00:00.000Z",
      };
      return saved;
    }),
    fetchSource: vi.fn<GlobalRulesServices["fetchSource"]>(async () => ({
      content: "# 导入规则\n优先验证证据",
      sourceUrl: "https://rules.example/rules.md",
    })),
    audit: vi.fn(),
  };
}

async function http<T>(
  dependencies: GlobalRulesServices,
  run: (url: string) => Promise<T>,
): Promise<T> {
  const routes = orderRoutes(createGlobalRulesRoutes(dependencies));
  const server = createServer((request, response) => {
    void dispatch(routes, request, response, "test-request", {
      isAdmin: () => dependencies.isAdmin(request),
    })
      .then((found) => {
        if (!found) {
          response.statusCode = 404;
          response.end();
        }
      })
      .catch((error) => {
        response.writeHead(error instanceof HttpError ? error.status : 500, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify({
            status: "error",
            reason: error instanceof Error ? error.message : "error",
          }),
        );
      });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    return await run(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const put = (
  content: string,
  expectedContentHash = globalReviewRulesHash("既有全局规则"),
) => ({
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ content, expectedContentHash }),
});
const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("global review rules HTTP contract", () => {
  it("reads old configuration independently of a GitHub installation", async () => {
    const deps = services();
    await http(deps, async (url) => {
      const response = await fetch(url + "/repo-rules/global");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        content: "既有全局规则",
        contentHash: globalReviewRulesHash("既有全局规则"),
        maxChars: 16000,
        maxBytes: 64000,
        canManage: true,
      });
    });
    expect(deps.fetchSource).not.toHaveBeenCalled();
  });
  it("lets a read-only admin inspect the content but never import or save", async () => {
    const deps = services();
    deps.isReadOnly.mockResolvedValue(true);
    await http(deps, async (url) => {
      const get = await fetch(url + "/repo-rules/global");
      expect((await get.json()).canManage).toBe(false);
      expect((await fetch(url + "/repo-rules/global", put("new"))).status).toBe(
        403,
      );
      expect(
        (
          await fetch(
            url + "/repo-rules/global/from-url",
            post({ url: "https://rules.example/r.md" }),
          )
        ).status,
      ).toBe(403);
    });
    expect(deps.save).not.toHaveBeenCalled();
    expect(deps.fetchSource).not.toHaveBeenCalled();
  });
  it("does not expose global content or import services to a non-admin", async () => {
    const deps = services();
    deps.isAdmin.mockResolvedValue(false);
    await http(deps, async (url) => {
      for (const [path, init] of [
        ["/repo-rules/global", undefined],
        ["/repo-rules/global", put("new")],
        [
          "/repo-rules/global/from-url",
          post({ url: "https://rules.example/a" }),
        ],
      ] as const)
        expect((await fetch(url + path, init)).status).toBe(403);
    });
    expect(deps.load).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
    expect(deps.fetchSource).not.toHaveBeenCalled();
  });
  it("saves exact Markdown and allows an explicit empty value to clear rules", async () => {
    const deps = services();
    await http(deps, async (url) => {
      const content = "# 规则\r\n\t- 验证事实 🐾\n";
      const response = await fetch(url + "/repo-rules/global", put(content));
      expect(response.status).toBe(200);
      expect((await response.json()).content).toBe(content);
      const clear = await fetch(
        url + "/repo-rules/global",
        put("", globalReviewRulesHash(content)),
      );
      expect(clear.status).toBe(200);
      expect((await clear.json()).content).toBe("");
    });
    expect(deps.audit).toHaveBeenCalledTimes(2);
    expect(
      JSON.stringify(deps.audit.mock.calls.map((call) => call.slice(1))),
    ).not.toContain("验证事实");
  });
  it("returns a conflict without leaking the concurrently saved content", async () => {
    const deps = services("管理员的新规则");
    await http(deps, async (url) => {
      const response = await fetch(
        url + "/repo-rules/global",
        put("stale editor text"),
      );
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body).toMatchObject({
        reason: "global_rules_conflict",
        currentContentHash: globalReviewRulesHash("管理员的新规则"),
      });
      expect(JSON.stringify(body)).not.toContain("管理员的新规则");
    });
    expect(deps.audit).not.toHaveBeenCalled();
  });
  it("previews a URL without changing persisted rules", async () => {
    const deps = services();
    await http(deps, async (url) => {
      const response = await fetch(
        url + "/repo-rules/global/from-url",
        post({ url: " https://rules.example/rules.md?signature=private " }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        content: "# 导入规则\n优先验证证据",
        sourceUrl: "https://rules.example/rules.md",
      });
      expect(
        (await (await fetch(url + "/repo-rules/global")).json()).content,
      ).toBe("既有全局规则");
    });
    expect(deps.save).not.toHaveBeenCalled();
    expect(deps.audit).not.toHaveBeenCalled();
  });
  it("redacts underlying URL, query and credential errors", async () => {
    const deps = services();
    deps.fetchSource.mockRejectedValue(
      new Error(
        "fetch https://internal.example/rules?token=private-api-key failed",
      ),
    );
    await http(deps, async (url) => {
      const response = await fetch(
        url + "/repo-rules/global/from-url",
        post({ url: "https://internal.example/rules?token=private-api-key" }),
      );
      expect(response.status).toBe(502);
      const body = await response.text();
      expect(body).toContain("rules_url_unreachable");
      expect(body).not.toContain("private-api-key");
      expect(body).not.toContain("internal.example");
    });
  });
  it.each(["EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED", "ECONNRESET"])(
    "distinguishes a remote transport failure from invalid rule input: %s",
    async (code) => {
      const deps = services();
      deps.fetchSource.mockRejectedValue(
        Object.assign(
          new Error(
            "cannot reach https://private-host.example/rules?key=hidden",
          ),
          { code },
        ),
      );
      await http(deps, async (url) => {
        const response = await fetch(
          url + "/repo-rules/global/from-url",
          post({ url: "https://private-host.example/rules?key=hidden" }),
        );
        expect(response.status).toBe(502);
        const body = await response.json();
        expect(body).toMatchObject({
          reason: "rules_url_unreachable",
          message: "服务器暂时无法解析或连接规则链接，请检查链接或稍后重试",
        });
        expect(JSON.stringify(body)).not.toContain("private-host");
        expect(JSON.stringify(body)).not.toContain("hidden");
      });
      expect(deps.save).not.toHaveBeenCalled();
    },
  );
  it.each([
    new DOMException("upstream signed URL timed out", "TimeoutError"),
    Object.assign(new Error("request aborted"), {
      name: "AbortError",
      code: "ABORT_ERR",
      cause: new DOMException("deadline", "TimeoutError"),
    }),
    Object.assign(new Error("connect ETIMEDOUT private-host"), {
      code: "ETIMEDOUT",
    }),
  ])(
    "reports direct or wrapped network timeouts as HTTP 504, case %#",
    async (failure) => {
      const deps = services();
      deps.fetchSource.mockRejectedValue(failure);
      await http(deps, async (url) => {
        const response = await fetch(
          url + "/repo-rules/global/from-url",
          post({ url: "https://rules.example/private?token=hidden" }),
        );
        expect(response.status).toBe(504);
        expect(await response.json()).toEqual({
          status: "error",
          reason: "rules_url_timeout",
          message: "规则链接读取超时，请检查链接或稍后重试",
        });
      });
    },
  );
  it.each([
    "invalid_url",
    "non_public_url",
    "invalid_utf8",
    "unsupported_response",
    "redirect_limit",
  ] as const)(
    "keeps a source validation failure client-correctable: %s",
    async (code) => {
      const deps = services();
      deps.fetchSource.mockRejectedValue(
        new RuleSourceError(code, "source validation failed"),
      );
      await http(deps, async (url) => {
        const response = await fetch(
          url + "/repo-rules/global/from-url",
          post({ url: "https://rules.example/rules" }),
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          reason: "rules_url_import_failed",
          code,
        });
      });
    },
  );
  it.each(["byte_limit", "character_limit"] as const)(
    "reports a bounded URL import as HTTP 413: %s",
    async (code) => {
      const deps = services();
      deps.fetchSource.mockRejectedValue(
        new RuleSourceError(code, "rule source exceeds its limit"),
      );
      await http(deps, async (url) => {
        const response = await fetch(
          url + "/repo-rules/global/from-url",
          post({ url: "https://rules.example/rules" }),
        );
        expect(response.status).toBe(413);
        expect(await response.json()).toMatchObject({
          reason: "rules_url_import_failed",
          code,
        });
      });
    },
  );
  it.each([
    {},
    { content: "new" },
    { content: 42, expectedContentHash: "a".repeat(64) },
    { content: "new", expectedContentHash: "bad" },
    { content: "new", expectedContentHash: "a".repeat(64), extra: true },
    [],
    null,
  ])("rejects invalid update input without writes: %j", async (body) => {
    const deps = services();
    await http(deps, async (url) =>
      expect(
        (
          await fetch(url + "/repo-rules/global", {
            ...post(body),
            method: "PUT",
          })
        ).status,
      ).toBe(400),
    );
    expect(deps.save).not.toHaveBeenCalled();
  });
  it.each(["\u0000", "\u001b", "\u007f", "\ud800"])(
    "rejects binary or malformed text: %j",
    async (bad) => {
      const deps = services();
      await http(deps, async (url) =>
        expect((await fetch(url + "/repo-rules/global", put(bad))).status).toBe(
          400,
        ),
      );
      expect(deps.save).not.toHaveBeenCalled();
    },
  );
  it("accepts the character limit and rejects even one extra character", async () => {
    const deps = services();
    await http(deps, async (url) => {
      const content = "中".repeat(16000);
      expect(
        (await fetch(url + "/repo-rules/global", put(content))).status,
      ).toBe(200);
      expect(
        (
          await fetch(
            url + "/repo-rules/global",
            put(content + "a", globalReviewRulesHash(content)),
          )
        ).status,
      ).toBe(413);
    });
  });
  it("rejects invalid wire UTF-8 and excessive request bytes", async () => {
    const deps = services();
    await http(deps, async (url) => {
      expect(
        (
          await fetch(url + "/repo-rules/global", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: Buffer.from([0x7b, 0xff, 0x7d]),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await fetch(url + "/repo-rules/global", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: "x".repeat(100000),
          })
        ).status,
      ).toBe(413);
    });
    expect(deps.save).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { url: "" },
    { url: 42 },
    { url: "x".repeat(4097) },
    { url: "https://rules.example/a", extra: true },
  ])("rejects invalid URL preview input, case %#", async (body) => {
    const deps = services();
    await http(deps, async (url) =>
      expect(
        (await fetch(url + "/repo-rules/global/from-url", post(body))).status,
      ).toBe(400),
    );
    expect(deps.fetchSource).not.toHaveBeenCalled();
  });
  it("does not accept empty, oversized or malformed downloaded text", async () => {
    const deps = services();
    await http(deps, async (url) => {
      for (const [content, status] of [
        ["  \n", 400],
        ["x".repeat(16001), 413],
        ["\u0000", 400],
      ] as const) {
        deps.fetchSource.mockResolvedValueOnce({
          content,
          sourceUrl: "https://rules.example/a",
        });
        expect(
          (
            await fetch(
              url + "/repo-rules/global/from-url",
              post({ url: "https://rules.example/a" }),
            )
          ).status,
        ).toBe(status);
      }
    });
    expect(deps.save).not.toHaveBeenCalled();
  });
  it("keeps method and media-type boundaries explicit", async () => {
    const deps = services();
    await http(deps, async (url) => {
      expect(
        (await fetch(url + "/repo-rules/global", { method: "POST" })).status,
      ).toBe(405);
      expect((await fetch(url + "/repo-rules/global/from-url")).status).toBe(
        405,
      );
      expect(
        (await fetch(url + "/repo-rules/global", { method: "PUT", body: "{}" }))
          .status,
      ).toBe(415);
    });
  });
  it("exports the same bounded UTF-8 budget as the worker", () =>
    expect(MAX_GLOBAL_RULES_BYTES).toBe(64000));
});
