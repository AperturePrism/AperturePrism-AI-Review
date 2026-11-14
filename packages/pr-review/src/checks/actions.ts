/** GitHub Actions 检查：不可信事件上下文、checkout 与 shell 表达式；由 checks.ts 自动发现。 */
import type {
  FileCheckContext,
  ReviewCheck,
  CheckObservationInput,
} from "../checks.js";

/** 从 YAML 行提取明确的 step 边界；不把字符串中的 uses: 当成配置。 */
function stepBlocks(
  file: FileCheckContext,
): readonly { lines: FileCheckContext["lines"]; run: boolean }[] {
  const blocks: { lines: (typeof file.lines)[number][]; run: boolean }[] = [];
  let current: { lines: (typeof file.lines)[number][]; run: boolean } | null =
    null;
  let stepIndent = -1;
  for (const line of file.lines) {
    const start =
      /^(\s*)-\s+(?:name|uses|run|id|if|env|shell|working-directory|with|timeout-minutes|continue-on-error)\s*:/u.exec(
        line.text,
      );
    if (start && (stepIndent < 0 || start[1]!.length <= stepIndent)) {
      stepIndent = start[1]!.length;
      current = { lines: [], run: false };
      blocks.push(current);
    }
    if (!current) continue;
    current.lines.push(line);
    if (/^\s*(?:-\s*)?run\s*:/u.test(line.text)) current.run = true;
  }
  return blocks;
}

const check: ReviewCheck = {
  description:
    "核对 GitHub Actions 中不可信上下文进入高权限工作流或 shell 的位置",
  matches: (path) => /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path),
  run(file) {
    const observations: CheckObservationInput[] = [];
    const source = file.lines.map((line) => line.text).join("\n");
    const targetEventLine = file.lines.find(
      (line) => line.changed && /\bpull_request_target\b/u.test(line.text),
    );
    const targetEvent =
      /\bpull_request_target\s*:/u.test(source) ||
      /\bon\s*:\s*(?:\[[^\]]*\b)?pull_request_target\b/u.test(source);
    for (const block of stepBlocks(file)) {
      const checkout = block.lines.find((line) =>
        /^\s*(?:-\s*)?uses\s*:\s*['"]?actions\/checkout@/u.test(line.text),
      );
      if (targetEvent && checkout) {
        const untrustedRef = block.lines.find(
          (line) =>
            /^\s*ref\s*:/u.test(line.text) &&
            /github\.event\.pull_request\.head\.(?:sha|ref)/u.test(line.text),
        );
        const headRepository = block.lines.find(
          (line) =>
            /^\s*repository\s*:/u.test(line.text) &&
            /github\.event\.pull_request\.head\.repo/u.test(line.text),
        );
        const changed = [
          checkout,
          untrustedRef,
          headRepository,
          targetEventLine,
        ].filter((line) => line?.changed);
        if ((untrustedRef || headRepository) && changed.length) {
          const line = changed[0]!;
          observations.push({
            path: file.path,
            line: line.number,
            level: "warning",
            category: "workflow",
            nature: "configuration_fact",
            title: "pull_request_target 工作流检出 PR 作者控制的代码",
            message:
              "当前可见配置将高权限事件与 PR head 检出放在同一个工作流中；是否可利用取决于后续执行、令牌权限和环境。",
            evidence: [checkout, untrustedRef, headRepository]
              .filter((entry) => entry !== undefined)
              .map((entry) => `${entry.number}: ${entry.text}`)
              .join("\n"),
            recommendation:
              "核对后续是否执行 PR 代码；优先在 pull_request 低权限工作流处理不可信代码，并显式收紧 token 权限。",
          });
        }
      }
      if (!block.run) continue;
      // 只看 run 对应的块，不把通过 env 传入的数据误报为直接 shell 插值。
      let inRun = false;
      let runIndent = -1;
      for (const line of block.lines) {
        const runStart = /^(\s*)(?:-\s*)?run\s*:\s*(.*)$/u.exec(line.text);
        if (runStart) {
          inRun = true;
          runIndent =
            runStart[1]!.length +
            (line.text.trimStart().startsWith("-") ? 2 : 0);
        } else if (
          inRun &&
          line.text.trim() &&
          line.text.search(/\S/u) <= runIndent
        )
          inRun = false;
        if (!inRun || !line.changed) continue;
        const expression =
          /\$\{\{[^}]*github\.event\.(?:pull_request\.(?:title|body|head\.ref)|issue\.(?:title|body)|comment\.body|review\.body|discussion\.(?:title|body))[^}]*\}\}/u.exec(
            line.text,
          );
        if (!expression) continue;
        observations.push({
          path: file.path,
          line: line.number,
          level: "warning",
          category: "workflow",
          nature: "configuration_fact",
          title: "不可信事件字段直接插入 shell 脚本",
          message:
            "GitHub 表达式会在 shell 执行前被替换；事件文本可能改变最终脚本语法。实际影响仍需结合 shell、事件来源和权限核对。",
          evidence: line.text,
          recommendation:
            "把事件字段放入 step 的 env，再在脚本内以正确引号读取环境变量，避免将表达式直接插进脚本文本。",
        });
      }
    }
    return observations;
  },
};
export default check;
