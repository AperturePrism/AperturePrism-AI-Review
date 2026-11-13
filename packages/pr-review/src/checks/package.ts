/** 依赖配置检查：检查新增生命周期脚本和浮动来源；不执行任何 npm 脚本。 */
import type { ReviewCheck, CheckObservationInput } from "../checks.js";
import { dependencySource } from "../dependencies.js";

const check: ReviewCheck = {
  description: "核对 package.json 生命周期脚本、依赖来源与锁文件事实",
  matches: (path) =>
    /(^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/u.test(path),
  run(file) {
    const results: CheckObservationInput[] = [];
    if (!/(^|\/)package\.json$/u.test(file.path)) {
      const first = file.lines.find((line) => line.changed);
      if (first)
        results.push({
          path: file.path,
          line: first.number,
          level: "info",
          category: "dependency",
          nature: "review_reminder",
          title: "依赖锁文件发生变化",
          message: `可见 diff 新增 ${file.additions} 行、删除 ${file.deletions} 行锁文件内容。此提醒不判断依赖是否有漏洞。`,
          evidence: "锁文件变更统计（不展开可能含私有源地址的内容）",
          recommendation:
            "确认锁文件与依赖清单一致，核对来源、完整性字段和 CI 安装方式。",
        });
      return results;
    }
    // 完整 JSON 可精确判断 scripts/dependencies；只有 diff 时不猜测某个字符串所属字段。
    if (file.content === null) return results;
    let manifest: unknown;
    try {
      manifest = JSON.parse(file.content);
    } catch {
      return results;
    }
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      Array.isArray(manifest)
    )
      return results;
    const object = manifest as Record<string, unknown>;
    const scripts = object.scripts;
    if (
      typeof scripts === "object" &&
      scripts !== null &&
      !Array.isArray(scripts)
    ) {
      for (const [name, value] of Object.entries(scripts)) {
        if (
          typeof value !== "string" ||
          ![
            "preinstall",
            "install",
            "postinstall",
            "prepare",
            "prepublish",
            "preprepare",
            "postprepare",
          ].includes(name)
        )
          continue;
        const line = file.lines.find(
          (entry) =>
            entry.changed &&
            entry.text.includes(JSON.stringify(name)) &&
            entry.text.includes(JSON.stringify(value)),
        );
        if (!line) continue;
        const piped = /\b(?:curl|wget)\b[^|\n]*\|\s*(?:ba)?sh\b/u.test(value);
        results.push({
          path: file.path,
          line: line.number,
          level: piped ? "warning" : "info",
          category: "dependency",
          nature: "configuration_fact",
          title: piped
            ? "安装生命周期直接执行下载内容"
            : "安装生命周期脚本发生新增或修改",
          message: piped
            ? "新增脚本把网络下载结果直接交给 shell；结果是否可信取决于下载源、固定摘要和执行环境。"
            : `${name} 会在相应的包管理生命周期执行；此处只确认配置事实。`,
          evidence: line.text,
          recommendation: piped
            ? "固定下载内容与来源并核验摘要，避免把可变网络响应直接作为安装脚本执行。"
            : "核对脚本是否需要在安装时运行，使用受控构建环境验证其行为。",
        });
      }
    }
    for (const section of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      const values = object[section];
      if (
        typeof values !== "object" ||
        values === null ||
        Array.isArray(values)
      )
        continue;
      for (const [name, version] of Object.entries(values)) {
        if (typeof version !== "string") continue;
        const source = dependencySource(version);
        const floating = /^(?:latest|next|canary|\*)$/u.test(version.trim());
        const unpinnedGit =
          source === "git" && !/#[a-f0-9]{40}$/iu.test(version);
        if (!floating && !unpinnedGit && source !== "url") continue;
        const line = file.lines.find(
          (entry) =>
            entry.changed &&
            entry.text.includes(JSON.stringify(name)) &&
            entry.text.includes(JSON.stringify(version)),
        );
        if (!line) continue;
        results.push({
          path: file.path,
          line: line.number,
          level: "info",
          category: "dependency",
          nature: "configuration_fact",
          title: "新增依赖使用浮动版本或直接来源",
          message: `${name} 的来源类型是 ${source}${floating ? "，并使用浮动标签" : ""}${unpinnedGit ? "，没有固定到完整 Git SHA" : ""}。这不是漏洞结论。`,
          evidence: line.text,
          recommendation:
            "核对锁文件和完整性信息，确认构建输入可复现且来源受信。",
        });
      }
    }
    return results;
  },
};
export default check;
