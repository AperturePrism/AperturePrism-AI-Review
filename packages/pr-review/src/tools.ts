import type {
  ModelInvocationRequest,
  ModelInvocationResponse,
  ModelMessage,
  ModelToolCall,
  ModelToolSpec,
} from "../../../packages/domain/src/index.js";
import { createLogger } from "../../../packages/observability/src/index.js";
import type { GitHubClient } from "../../../packages/github-adapter/src/client.js";

/** 工具执行诊断日志（同 main.ts 使用的 fmt），便于排查 deep 读仓工具是否被
 *  模型调用、执行成败与耗时。无实例级 logger 可注入，用独立实例（同写 stdout）。 */
const logger = createLogger();

/**
 * AI 主动探索工具系统：审查模型可按需调用工具读取仓库上下文，
 * 而不是只依赖一次性注入的 diff。工具执行严格受限于目标仓库（只读）。
 */

/** 工具执行上下文：GitHub 只读访问 + 目标仓库定位。 */
export type ToolExecutionContext = {
  client: GitHubClient;
  installationId: string;
  owner: string;
  name: string;
  /** 读取文件所用的 ref（PR head sha）。 */
  ref: string;
  /** 单文件最大返回字节数（超出截断）。 */
  maxFileBytes?: number;
};

export type ToolResult = { ok: boolean; content: string };

/** 内置工具定义（暴露给模型的 JSON Schema）。 */
export function builtinTools(): ModelToolSpec[] {
  return [
    {
      name: "read_file",
      description:
        "读取仓库中某个文件的 UTF-8 内容（基于当前分支）。path 值必须是仓库内相对路径，如 src/main.ts、desktop.py —— 不要传以 / 开头的绝对路径，也不要拼上 /home/user/repos/ 这类用户目录前缀。大文件只返回开头部分。仅用于读取，禁止修改。",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "仓库内相对文件路径（如 src/main.ts，不含仓库名/绝对路径前缀）",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "list_directory",
      description:
        "列出仓库中某个目录下的条目（文件名与子目录名）。要查看仓库根目录时，path 传空字符串 \"\"；要进入子目录就传相对路径（如 src）。绝不要传 / 开头的绝对路径或 /home/user/repos/... 这种用户目录前缀。",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "目录相对路径（空字符串=仓库根目录，禁止绝对路径）",
          },
        },
      },
    },
    {
      name: "get_git_info",
      description:
        "获取当前 PR 的元信息：标题、head 分支与 sha、base 分支。用于了解变更范围与目标分支。",
      parameters: { type: "object", properties: {} },
    },
  ];
}

/**
 * 把模型给的路径规范化到仓库根内：去掉前导 /、去 ../ 组件、并拒绝任何
 * 从仓库根"逃逸"出去的绝对路径或用户目录前缀（如 /home/...、repos/owner/name/）。
 * 越界时返回 null，由调用方给模型明确报错，避免模型把错误路径当"成功"继续深入。
 */
function safePath(raw: string): string | null {
  const value = String(raw || "").trim();
  if (value === "") return "";
  // 去掉前导 / 与任何仓库名前缀式路径（绝对路径 / 绝对化前缀），统一成相对路径。
  const stripped = value.replace(/^\/+/, "");
  // 拒绝显式 user 目录前缀（常见于模型幻觉出 /home/... 后逐级往上列）。
  if (/^(home|root|home\/[^/]+|var|tmp|usr|repos)(\/|$)/i.test(stripped)) return null;
  // 去掉 .. 组件（禁止跳出仓库根）。
  const hasDotDot = stripped.split("/").some((seg) => seg === "..");
  if (hasDotDot) return null;
  return stripped;
}

/** 执行单个工具调用，返回给模型的结果文本。 */
export async function executeToolCall(
  name: string,
  rawArgs: string,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
  } catch {
    return { ok: false, content: "工具参数不是合法 JSON" };
  }

  try {
    switch (name) {
      case "read_file": {
        const path = safePath(typeof args.path === "string" ? args.path : "");
        if (path === null)
          return {
            ok: false,
            content:
              "read_file: path 无效。必须传仓库内相对路径（如 desktop.py、src/main.ts），禁止绝对路径或 /home/... 等用户目录前缀。",
          };
        if (path === "") return { ok: false, content: "read_file: 缺少 path 参数" };
        const file = await ctx.client.getFileContents({
          installationId: ctx.installationId,
          owner: ctx.owner,
          name: ctx.name,
          path,
          ref: ctx.ref,
        });
        if (!file)
          return { ok: false, content: `read_file: 文件不存在或不是文件：${path}` };
        const maxBytes = ctx.maxFileBytes ?? 200_000;
        const content =
          file.content.length > maxBytes
            ? `${file.content.slice(0, maxBytes)}\n…[已截断，文件较大]`
            : file.content;
        return { ok: true, content };
      }

      case "list_directory": {
        const path = safePath(typeof args.path === "string" ? args.path : "");
        if (path === null)
          return {
            ok: false,
            content:
              "list_directory: path 无效。传空字符串 \"\" 表示仓库根目录，进子目录用相对路径（如 src）；禁止绝对路径或 /home/... 等用户目录前缀。",
          };
        const entries = await ctx.client.listDirectory({
          installationId: ctx.installationId,
          owner: ctx.owner,
          name: ctx.name,
          path,
          ref: ctx.ref,
        });
        if (entries.length === 0) return { ok: true, content: "(空目录或路径不存在)" };
        return {
          ok: true,
          content: entries
            .map((e) => `${e.type === "dir" ? "dir " : "file"}  ${e.path}`)
            .join("\n"),
        };
      }

      case "get_git_info":
        return {
          ok: true,
          content: `仓库: ${ctx.owner}/${ctx.name}\n读取 ref: ${ctx.ref}`,
        };

      default:
        return { ok: false, content: `未知工具: ${name}` };
    }
  } catch (error) {
    return {
      ok: false,
      content: `工具执行失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export type ToolLoopOptions = {
  /** 暴露给模型的工具（默认内置工具）。 */
  tools?: readonly ModelToolSpec[];
  /** 最大工具调用轮数（超出后强制模型收尾）。 */
  maxRounds?: number;
  /** 注入给模型的"开始探索"引导消息。 */
  exploreInstruction?: string;
  /**
   * 强制读仓：当模型在尚未调用任何读取工具时就试图收尾（false「无法读取/无法审查」
   * 这类模板逃避）时，插入一条强制指令要求它先调用 read_file / list_directory 再作答。
   * 最多强制 2 次；仍不调用则放行（避免死循环）。代码审查 / 缺陷任务应开启。
   */
  forceToolUse?: boolean;
};

/**
 * 多轮 tool-calling 循环：不断把模型的 tool_calls 交给执行器并把结果回传，
 * 直到模型直接给出最终内容或达到最大轮数。返回最终消息序列与轮数。
 */
export async function runToolLoop(
  invoke: (request: ModelInvocationRequest) => Promise<ModelInvocationResponse>,
  messages: readonly ModelMessage[],
  ctx: ToolExecutionContext,
  options: ToolLoopOptions = {},
): Promise<{ messages: ModelMessage[]; rounds: number }> {
  const tools = options.tools ?? builtinTools();
  const maxRounds = options.maxRounds ?? 6;
  const forceToolUse = options.forceToolUse ?? false;
  let rounds = 0;
  // 强制读仓仅允许插入有限次，避免模型一直不配合时无限循环。
  let forcedCount = 0;
  let sawToolCall = false;
  let current: ModelMessage[] = [...messages];

  if (options.exploreInstruction) {
    current = [...current, { role: "user", content: options.exploreInstruction }];
  }

  // 空响应重试：模型（如 kimi-k3）在工具循环中偶发返回「既无 content 也无
  // tool_calls」的空消息，openai-compatible 适配器据此抛 invalid_output
  // （"did not contain message content"）。这是瞬态抖动而非真实失败——重试当前
  // 轮即可，若直接上抛会让整个 deep 分析无谓地致命失败。
  const invokeWithEmptyRetry: typeof invoke = async (request) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await invoke(request);
      } catch (error) {
        const emptyResponse =
          error instanceof Error &&
          /did not contain message content/.test(error.message);
        if (!emptyResponse || attempt >= 2) throw error;
      }
    }
  };

  for (;;) {
    // 诊断：确认 tools 是否随每次调用送达模型（排查"探针可调、worker 实际不调"差异）。
    logger.info(
      {
        owner: ctx.owner,
        name: ctx.name,
        rounds,
        tools: tools.length,
        messages: current.length,
        contentChars: current.reduce((a, m) => a + (m.content?.length ?? 0), 0),
      },
      "deep tool loop invoke",
    );
    const response = await invokeWithEmptyRetry({
      messages: current,
      tools,
      // 工具循环的调用同样要给输出预算上限：reasoning 模型不限制时可能把
      // max_tokens 全花在推理上、正文迟迟不产出，拖长单轮耗时（504 主因）。
      maxOutputTokens: 4_000,
    });
    rounds += 1;

    if (!response.toolCalls || response.toolCalls.length === 0) {
      // 强制读仓：模型在从没调用过任何工具时就打算收尾（往往输出"无法读取/无法
      // 审查"这类逃避模板）。审查/缺陷任务必须让它真读仓后再作答。
      if (forceToolUse && !sawToolCall && forcedCount < 2) {
        forcedCount += 1;
        current = [
          ...current,
          { role: "assistant", content: response.content ?? "" },
          {
            role: "user",
            content:
              "警告：你还没有调用任何读取工具就准备给出最终结论。这是一个要求读仓的任务，" +
              "你必须先用 read_file 或 list_directory 读取相关文件后再作答（path 用仓库内相对路径，" +
              "根目录传空字符串，不要用绝对路径），不要在结论中说「无代码访问能力」。" +
              "请现在立刻调用工具。",
          },
        ];
        continue;
      }
      logger.info(
        { rounds, owner: ctx.owner, name: ctx.name, toolCalls: 0 },
        "deep tool loop finished without tool calls",
      );
      current = [...current, { role: "assistant", content: response.content }];
      return { messages: current, rounds };
    }
    sawToolCall = true;

    logger.info(
      { rounds, owner: ctx.owner, name: ctx.name, toolCalls: response.toolCalls.length },
      "deep tool loop round",
    );

    const assistantMsg: ModelMessage = {
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls as readonly ModelToolCall[],
    };
    const toolResults: ModelMessage[] = [];
    for (const call of response.toolCalls) {
      const started = Date.now();
      const result = await executeToolCall(call.name, call.arguments, ctx);
      const fields = {
        owner: ctx.owner,
        name: ctx.name,
        tool: call.name,
        arguments: call.arguments.slice(0, 200),
        ok: result.ok,
        ms: Date.now() - started,
      };
      if (result.ok) {
        logger.info(fields, "deep tool executed");
      } else {
        logger.warn(fields, "deep tool failed");
      }
      toolResults.push({
        role: "tool",
        content: result.content,
        toolCallId: call.id,
      });
    }
    current = [...current, assistantMsg, ...toolResults];

    if (rounds >= maxRounds) {
      const final = await invokeWithEmptyRetry({
        messages: [
          ...current,
          {
            role: "user",
            content:
              "工具调用轮次已达上限。请停止继续调用工具，基于已获取的信息直接输出最终审查结果。",
          },
        ],
        maxOutputTokens: 4_000,
      });
      return {
        messages: [...current, { role: "assistant", content: final.content }],
        rounds: rounds + 1,
      };
    }
  }
}
