import { describe, expect, it, vi } from "vitest";
import type {
  ModelInvocationRequest,
  ModelInvocationResponse,
} from "../../../packages/domain/src/index.js";
import type { GitHubClient } from "../../../packages/github-adapter/src/index.js";
import {
  builtinTools,
  executeToolCall,
  runToolLoop,
  type ToolExecutionContext,
} from "./tools.js";

function clientWith(overrides: Partial<GitHubClient>): GitHubClient {
  return {
    getFileContents: async () => ({ content: "const x = 1;\n" }),
    writeFileContents: async () => true,
    deleteFileContents: async () => true,
    listDirectory: async () => [
      { name: "src", path: "src", type: "dir" },
      { name: "README.md", path: "README.md", type: "file" },
    ],
    ...overrides,
  } as GitHubClient;
}

const ctx: ToolExecutionContext = {
  client: clientWith({}),
  installationId: "42",
  owner: "owner",
  name: "repo",
  ref: "abc123",
};

describe("builtinTools", () => {
  it("exposes read_file / list_directory / get_git_info", () => {
    const names = builtinTools().map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("list_directory");
    expect(names).toContain("get_git_info");
  });
});

describe("executeToolCall", () => {
  it("reads a file via the contents API", async () => {
    const result = await executeToolCall(
      "read_file",
      '{"path":"src/a.ts"}',
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.content).toBe("const x = 1;\n");
    expect(result.sourceFile).toEqual({
      path: "src/a.ts",
      content: result.content,
    });
  });

  it("reports a missing file", async () => {
    const missingCtx = {
      ...ctx,
      client: clientWith({ getFileContents: async () => null }),
    };
    const result = await executeToolCall(
      "read_file",
      '{"path":"nope.ts"}',
      missingCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("文件不存在");
  });

  it("truncates oversized files", async () => {
    const big = "a".repeat(5000);
    const bigCtx = {
      ...ctx,
      client: clientWith({ getFileContents: async () => ({ content: big }) }),
    };
    const result = await executeToolCall("read_file", '{"path":"big.ts"}', {
      ...bigCtx,
      maxFileBytes: 100,
    });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("已截断");
    expect(result.content.length).toBeLessThan(big.length);
    expect(result.sourceFile).toEqual({
      path: "big.ts",
      content: big.slice(0, 100),
    });
  });

  it("preserves whole UTF-8 characters within the byte limit", async () => {
    const result = await executeToolCall("read_file", '{"path":"src/a.ts"}', {
      ...ctx,
      maxFileBytes: 6,
      client: clientWith({
        getFileContents: async () => ({ content: "源😀码" }),
      }),
    });
    expect(result.content).toBe("源\n…[已截断，文件较大]");
    expect(result.sourceFile).toEqual({ path: "src/a.ts", content: "源" });
  });

  it("does not count a whitespace-only bounded excerpt as source", async () => {
    const result = await executeToolCall("read_file", '{"path":"src/a.ts"}', {
      ...ctx,
      maxFileBytes: 3,
      client: clientWith({
        getFileContents: async () => ({ content: " \t\nsource" }),
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("已截断");
    expect(result.sourceFile).toBeUndefined();
  });

  it("sanitizes traversal paths", async () => {
    let requested = "";
    const traversalCtx = {
      ...ctx,
      client: clientWith({
        getFileContents: async ({ path }) => {
          requested = path;
          return { content: "ok" };
        },
      }),
    };
    await executeToolCall(
      "read_file",
      '{"path":"../etc/passwd"}',
      traversalCtx,
    );
    expect(requested).not.toContain("..");
  });

  it("lists a directory", async () => {
    const result = await executeToolCall(
      "list_directory",
      '{"path":"src"}',
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("dir   src");
    expect(result.content).toContain("file  README.md");
  });

  it("returns git info", async () => {
    const result = await executeToolCall("get_git_info", "{}", ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("owner/repo");
  });

  it("rejects unknown tools and bad JSON", async () => {
    const unknown = await executeToolCall("rm_rf", "{}", ctx);
    expect(unknown.ok).toBe(false);
    const bad = await executeToolCall("read_file", "not json", ctx);
    expect(bad.ok).toBe(false);
  });
});

describe("runToolLoop", () => {
  const finalResponse = (content: string): ModelInvocationResponse => ({
    content,
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  const toolCallResponse = (
    name = "read_file",
    args = '{"path":"src/a.ts"}',
  ): ModelInvocationResponse => ({
    content: "",
    usage: { inputTokens: 1, outputTokens: 1 },
    toolCalls: [{ id: "c1", name, arguments: args }],
  });
  const issueOptions = { forceToolUse: true, requireSourceRead: true };

  it("executes tool calls and returns the final assistant content", async () => {
    let calls = 0;
    const invoke = async (
      request: ModelInvocationRequest,
    ): Promise<ModelInvocationResponse> => {
      calls += 1;
      if (calls === 1) {
        expect(request.tools).toBeDefined();
        return toolCallResponse();
      }
      return finalResponse('{"summary":"ok"}');
    };

    const result = await runToolLoop(
      invoke,
      [{ role: "user", content: "review" }],
      ctx,
    );

    expect(calls).toBe(2);
    const last = result.messages[result.messages.length - 1];
    expect(last?.content).toBe('{"summary":"ok"}');
    // assistant tool-call + tool result were appended between the rounds.
    expect(
      result.messages.some((m) => m.role === "tool" && m.toolCallId === "c1"),
    ).toBe(true);
  });

  it("stops immediately when the model returns content without tools", async () => {
    const invoke = async () => finalResponse("done");
    const result = await runToolLoop(
      invoke,
      [{ role: "user", content: "hi" }],
      ctx,
    );
    expect(result.rounds).toBe(1);
    expect(result.messages[result.messages.length - 1]?.content).toBe("done");
  });

  it.each([
    ["directory metadata", toolCallResponse("list_directory", "{}"), ctx],
    ["git metadata", toolCallResponse("get_git_info", "{}"), ctx],
    [
      "a failed read",
      toolCallResponse(),
      {
        ...ctx,
        client: clientWith({ getFileContents: async () => null }),
      },
    ],
    [
      "a whitespace-only read",
      toolCallResponse(),
      {
        ...ctx,
        client: clientWith({
          getFileContents: async () => ({ content: " \n\t" }),
        }),
      },
    ],
  ] as const)(
    "does not accept %s as source in Issue mode",
    async (_, response, toolContext) => {
      const invoke = vi
        .fn<
          (request: ModelInvocationRequest) => Promise<ModelInvocationResponse>
        >()
        .mockResolvedValueOnce(response)
        .mockResolvedValue(finalResponse("no source"));

      const result = await runToolLoop(invoke, [], toolContext, issueOptions);

      expect(result.rounds).toBe(5); // 1 tool call + 3 nudges + final response
      expect(result.sourceFiles).toEqual([]);
      expect(invoke.mock.calls[2]?.[0].messages.at(-1)?.content).toContain(
        "read_file",
      );
    },
  );

  it("accepts bounded source reads and deduplicates repeated paths", async () => {
    const getFileContents = vi
      .fn<GitHubClient["getFileContents"]>()
      .mockResolvedValueOnce({ content: "old content" })
      .mockResolvedValueOnce({ content: "new content" });
    const invoke = vi
      .fn<
        (request: ModelInvocationRequest) => Promise<ModelInvocationResponse>
      >()
      .mockResolvedValueOnce(toolCallResponse())
      .mockResolvedValueOnce(toolCallResponse())
      .mockResolvedValueOnce(finalResponse("done"));

    const result = await runToolLoop(
      invoke,
      [],
      {
        ...ctx,
        client: clientWith({ getFileContents }),
        maxFileBytes: 3,
      },
      issueOptions,
    );

    expect(invoke).toHaveBeenCalledTimes(3);
    expect(result.sourceFiles).toEqual([{ path: "src/a.ts", content: "new" }]);
    expect(invoke.mock.calls[2]?.[0].messages.at(-1)?.content).toBe(
      "new\n…[已截断，文件较大]",
    );
  });

  it("accepts preloaded source without requiring a tool call", async () => {
    const invoke = vi.fn().mockResolvedValue(finalResponse("done"));
    const result = await runToolLoop(
      invoke,
      [{ role: "user", content: "const x = 1;" }],
      ctx,
      {
        ...issueOptions,
        hasPreloadedSource: true,
      },
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.sourceFiles).toEqual([]);
  });

  it("does not force tool calls when only requireSourceRead is set", async () => {
    const invoke = vi.fn().mockResolvedValue(finalResponse("done"));
    await runToolLoop(invoke, [], ctx, { requireSourceRead: true });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("retains legacy forceToolUse behavior when source reads are not required", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(toolCallResponse("get_git_info", "{}"))
      .mockResolvedValue(finalResponse("done"));
    const result = await runToolLoop(invoke, [], ctx, { forceToolUse: true });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.sourceFiles).toEqual([]);
  });

  it("does not nudge past the Issue round limit after metadata", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(toolCallResponse("get_git_info", "{}"))
      .mockResolvedValue(finalResponse("done"));
    const result = await runToolLoop(invoke, [], ctx, {
      ...issueOptions,
      maxRounds: 2,
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.sourceFiles).toEqual([]);
  });

  it("asks for an honest final answer if the Issue tool limit is reached without source", async () => {
    const invoke = vi
      .fn<
        (request: ModelInvocationRequest) => Promise<ModelInvocationResponse>
      >()
      .mockResolvedValueOnce(toolCallResponse("get_git_info", "{}"))
      .mockResolvedValue(finalResponse("done"));
    const result = await runToolLoop(invoke, [], ctx, {
      ...issueOptions,
      maxRounds: 1,
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    const finalRequest = invoke.mock.calls[1]?.[0];
    expect(finalRequest?.tools).toBeUndefined();
    expect(finalRequest?.messages.at(-1)?.content).toContain(
      "尚未取得非空源码",
    );
    expect(result.sourceFiles).toEqual([]);
  });

  it("forces a final answer after reaching maxRounds", async () => {
    let calls = 0;
    const invoke = async (): Promise<ModelInvocationResponse> => {
      calls += 1;
      // Always request tools except the very last forced turn.
      if (calls <= 2) return toolCallResponse();
      return finalResponse("final");
    };
    const result = await runToolLoop(
      invoke,
      [{ role: "user", content: "hi" }],
      ctx,
      { maxRounds: 2 },
    );
    expect(result.messages[result.messages.length - 1]?.content).toBe("final");
  });
});
