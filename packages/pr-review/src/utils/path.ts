/**
 * 相对路径与路径匹配：审查策略、基线及报告共用同一份路径规则。
 * 调用：matchPath("src/** /test.ts".replace(" ", ""), "src/a/test.ts")。
 * 这里只匹配路径，不读文件；外部路径必须先经 normalizeReviewPath。
 */

/** 把仓库内路径统一成正斜线，拒绝绝对路径、父目录和控制字符。 */
export function normalizeReviewPath(value: string): string {
  if (containsControlCharacters(value))
    throw new Error("审查文件路径不能含控制字符");
  const path = value.trim().replaceAll("\\", "/"); // GitHub 与 Windows 调用方得到同一种路径。
  if (!path || path.startsWith("/") || /^[a-z]:/i.test(path)) {
    throw new Error("审查文件路径必须是仓库内的相对路径");
  }
  const parts = path.split("/").filter((part) => part !== "." && part !== "");
  if (parts.includes("..")) throw new Error("审查文件路径不能跳出仓库");
  if (parts.length === 0) throw new Error("审查文件路径不能为空");
  return parts.join("/"); // 不解码百分号，Git 路径的百分号本来就是字面量。
}

/**
 * 匹配仓库路径。* 匹配一层，** 匹配多层，? 匹配一个非分隔字符。
 * 不接受用户正则，避免复杂正则拖住整个审查进程。
 */
export function matchPath(pattern: string, path: string): boolean {
  if (!pattern || pattern.length > 500) return false; // 配置边界限制匹配规模。
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?"; // **/ 可以匹配零层，因此 **/a.ts 也命中根目录 a.ts。
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"); // 其余字符按字面匹配。
  }
  return new RegExp(`^${source}$`, "u").test(path);
}

/** 公开报告中的 URL 只允许 HTTP(S)，防止报告链接成为脚本入口。 */
export function safeReportUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value); // 非 URL 是配置错误，保留明确报错。
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("报告链接只允许 http 或 https");
  }
  if (url.username || url.password) throw new Error("报告链接不能包含凭据");
  return url.toString();
}

/** 检查不可见控制字符，避免路径或日志被换行、NUL 等内容改变含义。 */
export function containsControlCharacters(value: string): boolean {
  return [...value].some((char) => {
    const point = char.codePointAt(0)!;
    return point < 32 || point === 127;
  });
}
