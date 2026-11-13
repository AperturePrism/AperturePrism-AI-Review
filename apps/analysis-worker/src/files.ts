/**
 * 源码：寻找Issue点名的文件、预读源码并核对模型建议路径。
 * 调用示例：extractTargetFiles("请检查 src/main.ts 中的问题")。
 * 仅拆分内部实现；任务与数据契约保持兼容，依赖在下方显式列出。
 */
import { type ProposedChange } from "../../../packages/contracts/src/index.js";
import {
  type IssueContext,
  CODE_ACCESS_UNKNOWN_PATH,
} from "../../../packages/issue-analysis/src/index.js";
import { logger } from "./runtime.js";

/** 最小文件读取器：避免引入 github-adapter 的完整 GitHubClient 类型依赖。 */
type FileReader = {
  getFileContents(args: {
    installationId: string;
    owner: string;
    name: string;
    path: string;
    ref: string;
  }): Promise<{ content?: string } | null | undefined>;
  /** 列目录条目（contents API），供兜底命中按关键词扫仓用。 */
  listDirectory(args: {
    installationId: string;
    owner: string;
    name: string;
    path: string;
    ref: string;
  }): Promise<{ name: string; path: string; type: string }[]>;
};

/** 审查/缺陷请求里用户点名的文件路径（如 main.py、backend/app.ts）。最多取 2 个。 */
const TARGET_FILE_RE =
  /([\w.\-/]+\.(?:py|js|ts|tsx|jsx|json|go|rs|java|c|cc|cpp|h|hpp|sh|ps1|bat|mjs|cjs|css|html|yaml|yml|toml|md))/gi;

const PRELOAD_MAX_CHARS = 60_000;

function extractTargetFiles(context: IssueContext): string[] {
  const hay = `${context.issue.title ?? ""}\n${context.issue.body ?? ""}`;
  const found: string[] = [];
  for (const match of hay.matchAll(TARGET_FILE_RE)) {
    const path = match[1];
    if (path && path.length <= 160 && !path.includes(" ")) found.push(path);
  }
  return [...new Set(found)].slice(0, 2);
}

/**
 * 方案B：服务端主动预读目标文件源码并注入上下文，模型无需依赖调用 read_file
 * 即可看到代码（deepseek 对 function-calling 不稳定，工具注入无法保证其一定
 * 主动读仓）。先取用户点名文件；未点名的（常见于模糊 enhancement）走兜底命中：
 * 按 issue 关键词在有界扫出的仓库路径里打分，挑最相关的源码注入（#62）。
 * 读不到的文件静默跳过，不阻断分析。
 */
const FALLBACK_MAX_FILES = 200;

const FALLBACK_MAX_DEPTH = 3;

/** 需跳过的目录（依赖/产物/版本控制/虚拟环境）。 */
const FALLBACK_SKIP_DIR =
  /(^|\/)(\.git|node_modules|dist|build|\.next|\.nuxt|out|coverage|vendor|target|\.cache|\.venv)(\/|$)/;

/** 只把可读的源码/配置纳入候选，排除二进制/图片/归档/压缩产物。 */
const FALLBACK_SOURCE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cc|cpp|h|hpp|sh|ps1|bat|json|css|scss|less|html|vue|svelte|yml|yaml|toml|md)$/i;

/** 从 issue 标题/正文提取英文技术关键词（去停用词），用于兜底扫仓匹配。 */
function extractIssueKeywords(context: IssueContext): Set<string> {
  const hay =
    `${context.issue.title ?? ""}\n${context.issue.body ?? ""}`.toLowerCase();
  const stop = new Set(
    "a|an|the|and|or|for|with|from|to|of|in|on|at|by|as|is|it|be|are|was|were|been|this|that|these|those|its|our|their|your|his|her|my|i|we|you|they|he|she|do|does|did|not|no|yes|but|if|so|then|there|here|about|into|over|under|again|while|when|how|why|what|where|which|who|can|could|would|should|may|might|must|will|shall|also|only|some|such|more|most|other|same|very|too|just|please|help|bug|fix|feat|feature|enhancement|issue|support|add|adding|new|use|used|using|get|got|give|need|needs|want|wants|have|has|having".split(
      "|",
    ),
  );
  const terms = new Set<string>();
  for (const m of hay.matchAll(/\b[a-z][a-z0-9_-]{2,}\b/g)) {
    const w = m[0];
    if (!stop.has(w) && !/^\d/.test(w)) terms.add(w);
  }
  return terms;
}

/** 有界 BFS：收集仓库内源码/配置文件路径（限制深度、访问数与文件数）。 */
async function listRepoSourcePaths(
  reader: FileReader,
  context: IssueContext,
): Promise<string[]> {
  const files: string[] = [];
  const queue: string[] = [""];
  let visited = 0;
  let depth = 0;
  while (
    queue.length > 0 &&
    files.length < FALLBACK_MAX_FILES &&
    visited < FALLBACK_MAX_FILES * 2
  ) {
    const level = queue.length;
    depth += 1;
    if (depth > FALLBACK_MAX_DEPTH) break;
    for (let i = 0; i < level && queue.length > 0; i++) {
      const dir = queue.shift()!;
      visited += 1;
      const entries = await reader
        .listDirectory({
          installationId: context.installationId,
          owner: context.repository.owner,
          name: context.repository.name,
          path: dir,
          ref: "HEAD",
        })
        .catch(() => []);
      for (const e of entries) {
        if (e.type === "file") {
          if (
            FALLBACK_SOURCE_EXT.test(e.path) &&
            !/\.(min|bundle|chunk)\.\w+$/.test(e.path)
          ) {
            files.push(e.path);
          }
        } else if (e.type === "dir" && !FALLBACK_SKIP_DIR.test(e.path)) {
          queue.push(e.path);
        }
      }
    }
  }
  return files;
}

/** 按关键词给路径打分：命中文件名加权更高。 */
function scorePathByKeywords(path: string, terms: Set<string>): number {
  const lower = path.toLowerCase();
  const base = lower.split("/").pop() ?? "";
  let score = 0;
  for (const t of terms) {
    if (base.includes(t)) score += 2;
    else if (lower.includes(t)) score += 1;
  }
  return score;
}

/** 兜底命中：无点名文件时，按 issue 关键词挑最相关的源码（最多 2 个）。 */
async function findRelevantFiles(
  reader: FileReader,
  context: IssueContext,
): Promise<string[]> {
  const terms = extractIssueKeywords(context);
  if (terms.size === 0) return [];
  const paths = await listRepoSourcePaths(reader, context);
  return paths
    .map((path) => ({ path, score: scorePathByKeywords(path, terms) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((x) => x.path);
}

/** 实际读取并截断一组文件；读不到的文件静默跳过，不阻断分析。 */
async function readPreloadFiles(
  reader: FileReader,
  context: IssueContext,
  paths: string[],
): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  for (const path of paths) {
    try {
      const file = await reader.getFileContents({
        installationId: context.installationId,
        owner: context.repository.owner,
        name: context.repository.name,
        path,
        ref: "HEAD",
      });
      if (file && file.content) {
        out.push({ path, content: file.content.slice(0, PRELOAD_MAX_CHARS) });
      }
    } catch {
      // 文件不存在或读取失败 → 忽略，保留其它可读文件。
    }
  }
  return out;
}

/**
 * #62 方案2：内容级检索。路径打分未命中（多为纯中文语义，ASCII 路径无法直接
 * 匹配中文关键词）时，让模型从仓库候选文件清单里挑最相关源码回填预读注入。
 */
export function buildFilePickRequest(
  context: IssueContext,
  candidatePaths: string[],
): {
  messages: { role: "system" | "user"; content: string }[];
  responseFormat: "json";
  temperature: number;
  maxOutputTokens: number;
} {
  const issue = `${context.issue.title ?? ""}\n${context.issue.body ?? ""}`;
  const list = candidatePaths.slice(0, 500).join("\n");
  return {
    messages: [
      {
        role: "system",
        content:
          "你是仓库代码检索助手。根据用户 Issue（可能为中文）找出与修复/实现该需求最相关的仓库文件。只能从给定的文件清单中选择，不得编造路径。",
      },
      {
        role: "user",
        content: `Issue 内容（可能是中文）：\n${issue}\n\n候选文件清单（只能从这些里选）：\n${list}\n\n请返回一个 JSON 对象 {"paths": [...]}，最多 2 个、按相关度从高到低；都不相关则返回 {"paths": []}。只输出该 JSON。`,
      },
    ],
    responseFormat: "json",
    temperature: 0.1,
    maxOutputTokens: 700,
  };
}

/** 解析模型返回的文件选择，只保留候选清单内真实存在的路径（大小写不敏感）。 */
export function parseFilePicks(text: string, candidates: string[]): string[] {
  const byLower = new Map<string, string>();
  for (const p of candidates) byLower.set(p.toLowerCase(), p);
  const picked: string[] = [];
  const push = (v: string): void => {
    if (typeof v !== "string") return;
    const real = byLower.get(v.trim().toLowerCase());
    if (real && !picked.includes(real)) picked.push(real);
  };
  // 先试 JSON 块：{"paths": [ ... ]}
  const blocks = text.match(/\{[\s\S]*\}/g) ?? [];
  for (const block of blocks) {
    try {
      const obj = JSON.parse(block) as { paths?: unknown };
      if (Array.isArray(obj.paths)) for (const v of obj.paths) push(String(v));
    } catch {
      // 非 JSON 块，跳过。
    }
  }
  if (picked.length > 0) return picked.slice(0, 2);
  // 兜底：逐行当作相对路径解析（去掉列表符号/引号/逗号）。
  for (const line of text.split(/\r?\n/)) {
    const clean = line
      .trim()
      .replace(/^[-*\d.\s"'`]+/, "")
      .replace(/[,;'"]+$/u, "")
      .trim();
    if (clean) push(clean);
  }
  return picked.slice(0, 2);
}

/**
 * 预读源码：优先用户点名文件 → 路径关键词命中 → 内容级检索（模型挑文件）。
 * 注入后模型无需依赖不稳定的 function-calling 即可看到源码（#62）。
 */
export async function preloadTargetFiles(
  reader: FileReader,
  context: IssueContext,
  pickWithModel?: (
    candidatePaths: string[],
    ctx: IssueContext,
  ) => Promise<string[]>,
): Promise<{ path: string; content: string }[]> {
  const explicit = extractTargetFiles(context);
  if (explicit.length > 0) return readPreloadFiles(reader, context, explicit);
  const pathHits = await findRelevantFiles(reader, context).catch(() => []);
  if (pathHits.length > 0) return readPreloadFiles(reader, context, pathHits);
  // 路径打分未命中（中文语义居多）→ 内容级检索：让模型挑最相关源码。
  if (pickWithModel) {
    const candidatePaths = await listRepoSourcePaths(reader, context).catch(
      () => [],
    );
    if (candidatePaths.length > 0) {
      const modelPicks = await pickWithModel(candidatePaths, context).catch(
        () => [],
      );
      if (modelPicks.length > 0)
        return readPreloadFiles(reader, context, modelPicks);
    }
  }
  return [];
}

/**
 * #57：发布前校验 proposedChanges 里的 path 是否真实存在于仓库。
 * 模型在无源码上下文时会凭猜测编造文件/文件夹路径（core/ 幻觉），
 * 这里用 contents API 逐个确认；不存在或非文件（目录）的路径从
 * proposedChanges 中移除，避免评论展示无法定位的改动点。
 * 占位路径（未读取源码）跳过校验；best-effort：GitHub 校验失败时
 * 保留原条目，不因接口抖动误删模型真实给出的建议。
 */
export async function verifyProposedChangePaths(input: {
  reader: FileReader;
  installationId: string;
  owner: string;
  name: string;
  changes: readonly ProposedChange[];
}): Promise<ProposedChange[]> {
  const kept: ProposedChange[] = [];
  for (const change of input.changes) {
    if (!change.path || change.path === CODE_ACCESS_UNKNOWN_PATH) {
      kept.push(change);
      continue;
    }
    try {
      const file = await input.reader.getFileContents({
        installationId: input.installationId,
        owner: input.owner,
        name: input.name,
        path: change.path,
        ref: "HEAD",
      });
      // getFileContents 对目录/非文件/404 返回 null → 视为不存在，移除。
      if (file) {
        kept.push(change);
      } else {
        logger.warn(
          { repo: `${input.owner}/${input.name}`, path: change.path },
          "proposed change path not found; dropped before publish",
        );
      }
    } catch {
      // 校验失败（网络/限流等）不误删，保留原建议。
      kept.push(change);
    }
  }
  return kept;
}
