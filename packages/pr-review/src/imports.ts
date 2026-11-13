/**
 * 源码依赖图：只读源码快照，提取常见静态导入，解释改动会影响哪些文件。
 * 调用：const graph = buildImportGraph([{ path: "src/a.ts", content: "import './b.js'" }, ...]);
 * 不执行仓库代码；动态表达式和不支持的语言会明确标记为不完整，不能据此证明无影响。
 */
import { posix } from "node:path";
import { normalizeReviewPath } from "./utils/path.js";

export type SourceSnapshot = { path: string; content: string };
export type ImportReference = {
  specifier: string;
  line: number;
  kind: "static" | "dynamic" | "require" | "python" | "go" | "rust";
};
export type ImportEdge = ImportReference & {
  source: string;
  target: string | null;
  resolution: "resolved" | "external" | "unresolved";
};
export type ImportNode = {
  path: string;
  language: string;
  bytes: number;
  parsed: boolean;
};
export type ImportGraph = {
  version: "review-import-graph/v1";
  nodes: readonly ImportNode[];
  edges: readonly ImportEdge[];
  warnings: readonly { path: string; line: number; message: string }[];
  complete: boolean;
};
export type ImportGraphOptions = {
  /** 简单前缀别名，如 { "@/": "src/" }；只影响仓库内解析，不加载构建配置。 */
  aliases?: Readonly<Record<string, string>>;
  maxFiles?: number;
  maxFileBytes?: number;
};

type SourceToken = {
  kind: "word" | "string" | "punctuation";
  value: string;
  line: number;
};
const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
];

/** 用词法扫描排除注释和字符串里的伪导入，不执行源码或求值模板字符串。 */
function sourceTokens(content: string, hashComments: boolean): SourceToken[] {
  const tokens: SourceToken[] = [];
  let index = 0;
  let line = 1;
  while (index < content.length) {
    const char = content[index]!;
    if (char === "\n") {
      line += 1;
      index += 1;
      continue;
    }
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (content.startsWith("//", index) || (hashComments && char === "#")) {
      while (index < content.length && content[index] !== "\n") index += 1;
      continue;
    }
    if (content.startsWith("/*", index)) {
      index += 2;
      while (index < content.length && !content.startsWith("*/", index)) {
        if (content[index] === "\n") line += 1;
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const startLine = line;
      const quote = char;
      let value = "";
      let dynamic = false;
      index += 1;
      while (index < content.length && content[index] !== quote) {
        const current = content[index]!;
        if (current === "\n") line += 1;
        if (quote === "`" && current === "$" && content[index + 1] === "{")
          dynamic = true;
        if (current === "\\" && index + 1 < content.length) {
          const escaped = content[index + 1]!;
          value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
          index += 2;
        } else {
          value += current;
          index += 1;
        }
      }
      index += 1;
      // 带表达式的模板无法静态解析，留成特殊标记，调用方会说明不完整。
      tokens.push({
        kind: "string",
        value: dynamic ? "<dynamic-expression>" : value,
        line: startLine,
      });
      continue;
    }
    if (/[a-zA-Z_$\u0080-\uffff]/u.test(char)) {
      const start = index;
      while (
        index < content.length &&
        /[\w$\u0080-\uffff]/u.test(content[index]!)
      )
        index += 1;
      tokens.push({ kind: "word", value: content.slice(start, index), line });
      continue;
    }
    tokens.push({ kind: "punctuation", value: char, line });
    index += 1;
  }
  return tokens;
}

/** JS/TS 的 import/export/require，包括字面量动态导入。 */
function scriptImports(tokens: readonly SourceToken[]): {
  references: ImportReference[];
  dynamicLines: number[];
} {
  const references: ImportReference[] = [];
  const dynamicLines: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== "word" || tokens[index - 1]?.value === ".") continue;
    if (
      token.value === "require" ||
      (token.value === "import" && tokens[index + 1]?.value === "(")
    ) {
      if (tokens[index + 1]?.value !== "(") continue;
      const value = tokens[index + 2];
      if (
        value?.kind === "string" &&
        value.value !== "<dynamic-expression>" &&
        tokens[index + 3]?.value === ")"
      ) {
        references.push({
          specifier: value.value,
          line: token.line,
          kind: token.value === "require" ? "require" : "dynamic",
        });
      } else {
        dynamicLines.push(token.line);
      }
      continue;
    }
    if (token.value !== "import" && token.value !== "export") continue;
    const next = tokens[index + 1];
    if (token.value === "import" && next?.kind === "string") {
      references.push({
        specifier: next.value,
        line: token.line,
        kind: "static",
      });
      continue;
    }
    for (
      let cursor = index + 1;
      cursor < Math.min(tokens.length, index + 100);
      cursor += 1
    ) {
      const candidate = tokens[cursor]!;
      if (candidate.value === ";" || candidate.line > token.line + 20) break;
      if (candidate.value === "from" && tokens[cursor + 1]?.kind === "string") {
        references.push({
          specifier: tokens[cursor + 1]!.value,
          line: token.line,
          kind: "static",
        });
        break;
      }
      if (candidate.value === "import" || candidate.value === "export") break;
    }
  }
  return { references, dynamicLines };
}

/** Python 只静态解释 import 与 from；运行时 importlib 不做猜测。 */
function pythonImports(tokens: readonly SourceToken[]): ImportReference[] {
  const references: ImportReference[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (
      token.kind !== "word" ||
      (token.value !== "from" && token.value !== "import")
    )
      continue;
    if (
      token.value === "import" &&
      tokens
        .slice(Math.max(0, index - 20), index)
        .some((item) => item.line === token.line && item.value === "from")
    )
      continue;
    const parts: string[] = [];
    for (
      let cursor = index + 1;
      cursor < tokens.length && tokens[cursor]!.line === token.line;
      cursor += 1
    ) {
      const item = tokens[cursor]!;
      if (item.value === "import" || item.value === "as" || item.value === ";")
        break;
      if (item.value === ",") {
        if (parts.length)
          references.push({
            specifier: parts.join(""),
            line: token.line,
            kind: "python",
          });
        parts.length = 0;
      } else if (item.kind === "word" || item.value === ".")
        parts.push(item.value);
      else break;
    }
    if (parts.length)
      references.push({
        specifier: parts.join(""),
        line: token.line,
        kind: "python",
      });
  }
  return references;
}

/** Go 的导入块和单行导入都使用字符串路径，别名不影响依赖目标。 */
function goImports(tokens: readonly SourceToken[]): ImportReference[] {
  const references: ImportReference[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== "word" || token.value !== "import") continue;
    const block = tokens[index + 1]?.value === "(";
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const item = tokens[cursor]!;
      if ((block && item.value === ")") || (!block && item.line > token.line))
        break;
      if (item.kind === "string")
        references.push({ specifier: item.value, line: item.line, kind: "go" });
    }
  }
  return references;
}

/** Rust 的外部模块声明与 crate/self/super 引用；嵌套 use 树会给出保守的模块前缀。 */
function rustImports(tokens: readonly SourceToken[]): ImportReference[] {
  const references: ImportReference[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== "word") continue;
    if (
      token.value === "mod" &&
      tokens[index + 1]?.kind === "word" &&
      tokens[index + 2]?.value === ";"
    ) {
      references.push({
        specifier: `self::${tokens[index + 1]!.value}`,
        line: token.line,
        kind: "rust",
      });
    }
    if (token.value !== "use") continue;
    const parts: string[] = [];
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const item = tokens[cursor]!;
      if (
        item.value === ";" ||
        item.value === "{" ||
        item.value === "as" ||
        item.value === "*"
      )
        break;
      if (item.kind === "word" || item.value === ":") parts.push(item.value);
      else break;
    }
    const specifier = parts.join("").replace(/::$/u, "");
    if (specifier)
      references.push({ specifier, line: token.line, kind: "rust" });
  }
  return references;
}

/** 使用文件快照解析路径；不读取本机依赖，也不把未知包当成仓库文件。 */
function resolveImport(
  source: string,
  reference: ImportReference,
  paths: ReadonlySet<string>,
  aliases: Readonly<Record<string, string>>,
): { target: string | null; resolution: ImportEdge["resolution"] } {
  let specifier = reference.specifier;
  const alias = Object.keys(aliases)
    .sort((left, right) => right.length - left.length)
    .find((key) => specifier.startsWith(key));
  let base: string;
  if (alias) {
    base = posix.normalize(`${aliases[alias]}${specifier.slice(alias.length)}`);
  } else if (reference.kind === "python") {
    const dots = /^\.+/u.exec(specifier)?.[0].length ?? 0;
    specifier = specifier.slice(dots).replaceAll(".", "/");
    base =
      dots > 0
        ? posix.normalize(
            posix.join(
              posix.dirname(source),
              "../".repeat(dots - 1),
              specifier,
            ),
          )
        : specifier;
    if (
      !dots &&
      ![...paths].some(
        (path) => path === `${base}.py` || path.startsWith(`${base}/`),
      )
    )
      return { target: null, resolution: "external" };
  } else if (reference.kind === "rust") {
    const parts = specifier.split("::");
    const prefix = parts.shift();
    if (prefix === "crate")
      base = posix.join(source.startsWith("src/") ? "src" : "", ...parts);
    else if (prefix === "self")
      base = posix.join(
        posix.basename(source) === "mod.rs"
          ? posix.dirname(source)
          : posix.dirname(source),
        ...parts,
      );
    else if (prefix === "super")
      base = posix.join(posix.dirname(source), "..", ...parts);
    else return { target: null, resolution: "external" };
  } else if (specifier.startsWith(".")) {
    base = posix.normalize(posix.join(posix.dirname(source), specifier));
  } else if (reference.kind === "go") {
    const packageFiles = [...paths].filter(
      (path) => posix.dirname(path) === specifier && path.endsWith(".go"),
    );
    return packageFiles.length
      ? { target: packageFiles[0]!, resolution: "resolved" }
      : { target: null, resolution: "external" };
  } else {
    return { target: null, resolution: "external" };
  }
  if (base.startsWith("../") || base.startsWith("/"))
    return { target: null, resolution: "unresolved" };
  const withoutExtension = base.replace(/\.(?:js|jsx|mjs|cjs)$/u, "");
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...[".ts", ".tsx", ".mts", ".cts"].map(
      (extension) => `${withoutExtension}${extension}`,
    ),
    ...SOURCE_EXTENSIONS.map((extension) => `${base}/index${extension}`),
    `${base}/__init__.py`,
    `${base}/mod.rs`,
  ];
  const target = candidates.find((candidate) => paths.has(candidate));
  return target
    ? { target, resolution: "resolved" }
    : { target: null, resolution: "unresolved" };
}

/** 构建确定性的依赖图，输入次序不会改变图中边的排序。 */
export function buildImportGraph(
  sources: readonly SourceSnapshot[],
  options: ImportGraphOptions = {},
): ImportGraph {
  const maxFiles = options.maxFiles ?? 5_000;
  const maxFileBytes = options.maxFileBytes ?? 1_000_000;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 50_000)
    throw new Error("依赖图文件上限必须在 1 到 50000 之间");
  if (
    !Number.isSafeInteger(maxFileBytes) ||
    maxFileBytes < 1 ||
    maxFileBytes > 20_000_000
  )
    throw new Error("依赖图单文件字节上限无效");
  if (sources.length > maxFiles)
    throw new Error(`依赖图文件数超过上限 ${maxFiles}`);
  if (
    sources.reduce(
      (sum, source) => sum + Buffer.byteLength(source.content),
      0,
    ) > 50_000_000
  )
    throw new Error("依赖图源码快照总大小超过 50 MB");
  const normalized = sources
    .map((source) => ({ ...source, path: normalizeReviewPath(source.path) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const paths = new Set(normalized.map((source) => source.path));
  if (paths.size !== normalized.length)
    throw new Error("依赖图源码快照中存在重复路径");
  const nodes: ImportNode[] = [];
  const edges: ImportEdge[] = [];
  const warnings: { path: string; line: number; message: string }[] = [];
  for (const source of normalized) {
    const extension = posix.extname(source.path).toLowerCase();
    const bytes = Buffer.byteLength(source.content);
    const language =
      extension === ".py"
        ? "python"
        : extension === ".go"
          ? "go"
          : extension === ".rs"
            ? "rust"
            : /\.(?:[cm]?[jt]sx?)$/u.test(extension)
              ? "script"
              : "unsupported";
    const parsed = language !== "unsupported" && bytes <= maxFileBytes;
    nodes.push({ path: source.path, language, bytes, parsed });
    if (!parsed) {
      warnings.push({
        path: source.path,
        line: 0,
        message:
          language === "unsupported"
            ? "此语言尚未解析静态导入，影响范围可能不完整"
            : "文件超过解析预算，未推断其导入关系",
      });
      continue;
    }
    const tokens = sourceTokens(source.content, language === "python");
    const script = language === "script" ? scriptImports(tokens) : null;
    const references =
      script?.references ??
      (language === "python"
        ? pythonImports(tokens)
        : language === "go"
          ? goImports(tokens)
          : rustImports(tokens));
    for (const line of script?.dynamicLines ?? [])
      warnings.push({
        path: source.path,
        line,
        message: "动态导入不是字符串字面量，无法静态确定依赖目标",
      });
    for (const reference of references) {
      const resolution = resolveImport(
        source.path,
        reference,
        paths,
        options.aliases ?? {},
      );
      edges.push({ source: source.path, ...reference, ...resolution });
      if (resolution.resolution === "unresolved")
        warnings.push({
          path: source.path,
          line: reference.line,
          message: `未在源码快照中找到导入目标 ${reference.specifier}`,
        });
    }
  }
  return {
    version: "review-import-graph/v1",
    nodes,
    edges,
    warnings,
    complete: warnings.length === 0,
  };
}

/** 从修改文件沿反向依赖扩散，给出最短影响链；循环导入不会导致无限递归。 */
export function affectedImportPaths(
  graph: ImportGraph,
  changedPaths: readonly string[],
  maxDepth = 20,
): readonly { path: string; depth: number; chain: readonly string[] }[] {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 1_000)
    throw new Error("依赖扩散深度必须在 0 到 1000 之间");
  const visited = new Map<
    string,
    { path: string; depth: number; chain: readonly string[] }
  >();
  const queue = [...new Set(changedPaths.map(normalizeReviewPath))].map(
    (path) => ({ path, depth: 0, chain: [path] }),
  );
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!edge.target) continue;
    const dependents = incoming.get(edge.target) ?? [];
    if (!dependents.includes(edge.source)) dependents.push(edge.source);
    incoming.set(edge.target, dependents);
  }
  for (let index = 0; index < queue.length; index += 1) {
    const entry = queue[index]!;
    if (visited.has(entry.path)) continue;
    visited.set(entry.path, entry);
    if (entry.depth >= maxDepth) continue;
    for (const path of incoming.get(entry.path) ?? [])
      queue.push({
        path,
        depth: entry.depth + 1,
        chain: [...entry.chain, path],
      });
  }
  return [...visited.values()].sort(
    (left, right) =>
      left.depth - right.depth || left.path.localeCompare(right.path),
  );
}

/** 显示图中的循环，便于决定是否拆分耦合；每个循环只输出一次。 */
export function importCycles(
  graph: ImportGraph,
): readonly (readonly string[])[] {
  const outgoing = new Map<string, string[]>();
  for (const node of graph.nodes) outgoing.set(node.path, []);
  for (const edge of graph.edges)
    if (edge.target) outgoing.get(edge.source)?.push(edge.target);
  // 用显式栈做两次遍历，数万文件的长依赖链也不会撑爆 JavaScript 调用栈。
  const visited = new Set<string>();
  const finished: string[] = [];
  for (const node of graph.nodes) {
    if (visited.has(node.path)) continue;
    const frames: { path: string; next: number }[] = [
      { path: node.path, next: 0 },
    ];
    visited.add(node.path);
    while (frames.length) {
      const frame = frames.at(-1)!;
      const neighbors = outgoing.get(frame.path) ?? [];
      if (frame.next < neighbors.length) {
        const target = neighbors[frame.next++]!;
        if (!visited.has(target)) {
          visited.add(target);
          frames.push({ path: target, next: 0 });
        }
        continue;
      }
      finished.push(frame.path);
      frames.pop();
    }
  }
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!edge.target) continue;
    const sources = incoming.get(edge.target) ?? [];
    sources.push(edge.source);
    incoming.set(edge.target, sources);
  }
  const assigned = new Set<string>();
  const cycles: string[][] = [];
  for (const path of finished.reverse()) {
    if (assigned.has(path)) continue;
    const component: string[] = [];
    const pending = [path];
    assigned.add(path);
    while (pending.length) {
      const current = pending.pop()!;
      component.push(current);
      for (const source of incoming.get(current) ?? []) {
        if (assigned.has(source)) continue;
        assigned.add(source);
        pending.push(source);
      }
    }
    if (component.length > 1 || outgoing.get(path)?.includes(path))
      cycles.push(component.sort());
  }
  return cycles.sort((left, right) => left[0]!.localeCompare(right[0]!));
}
