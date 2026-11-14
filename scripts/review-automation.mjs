#!/usr/bin/env node
/** 本地规则试跑与持久自动化管理，不调用模型或外发消息。 */
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const help = `AperturePrism 审查自动化

node scripts/review-automation.mjs --repository owner/repo --action summary

--data-dir PATH       自动化数据绝对路径，默认 ~/.apertureprism/automation
--workbench-dir PATH  工作台数据绝对路径，默认 ~/.apertureprism/workbench
--repository NAME     必填，仓库 owner/name
--action NAME         rules.create/list/preview/export/import、events.dispatch、runs.resume/recover
--json JSON           输入对象，不能与 --input 同时使用
--input FILE          从 JSON 文件读取输入
--output FILE         新建结果文件；规则导出写 JSONL，其他命令写 JSON
--user NAME           审计身份，默认本地系统用户
--help                显示说明

人工审批：approvals.list、approvals.decide；默认不能批准自己发起的执行。
报告：artifacts.list、artifacts.get。已有事件可用相同id恢复，已完成步骤不会重做。
自定义动作不能从CLI加载任意脚本；宿主需显式注入带幂等键的实现。
`;
async function main() {
  const values = new Map();
  const allowed = new Set([
    "data-dir",
    "workbench-dir",
    "repository",
    "action",
    "json",
    "input",
    "output",
    "user",
  ]);
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(help);
      return;
    }
    if (!argument?.startsWith("--") || !allowed.has(argument.slice(2)))
      throw new Error(`未知参数：${argument}`);
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} 缺少值`);
    if (values.has(argument.slice(2))) throw new Error(`${argument} 不能重复`);
    values.set(argument.slice(2), value);
    index += 1;
  }
  if (!values.has("repository"))
    throw new Error("请提供 --repository owner/name");
  if (values.has("json") && values.has("input"))
    throw new Error("--json 和 --input 只能选一个");
  const directory =
    values.get("data-dir") ??
    process.env.AUTOMATION_DATA_DIRECTORY ??
    join(homedir(), ".apertureprism", "automation");
  const workbenchDirectory =
    values.get("workbench-dir") ??
    process.env.WORKBENCH_DATA_DIRECTORY ??
    process.env.APERTURE_WORKBENCH_DATA_DIR ??
    join(homedir(), ".apertureprism", "workbench");
  if (!isAbsolute(directory) || !isAbsolute(workbenchDirectory))
    throw new Error("数据目录必须为绝对路径");
  const [{ createAutomation }, { createWorkbench }] = await Promise.all([
    import(
      new URL("../packages/review-automation/dist/index.js", import.meta.url)
        .href
    ),
    import(
      new URL("../packages/review-workbench/dist/index.js", import.meta.url)
        .href
    ),
  ]);
  const input = JSON.parse(
    values.has("input")
      ? await readFile(resolve(values.get("input")), "utf8")
      : (values.get("json") ?? "{}"),
  );
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("输入必须为JSON对象");
  const automation = createAutomation({
    dataDirectory: directory,
    workbench: createWorkbench({ dataDirectory: workbenchDirectory }),
  });
  const actor = {
    userId:
      values.get("user") ??
      process.env.USER ??
      process.env.USERNAME ??
      "local-cli",
    isAdmin: true,
    canAccessRepository: () => true,
  };
  const action = values.get("action") ?? "summary";
  const result = await automation.execute(actor, {
    action,
    input: { ...input, repository: values.get("repository") },
  });
  const content =
    action === "rules.export"
      ? result.content
      : JSON.stringify(result, null, 2) + "\n";
  if (values.has("output"))
    await writeFile(resolve(values.get("output")), content, {
      mode: 0o600,
      flag: "wx",
    });
  else process.stdout.write(content);
}
main().catch((error) => {
  process.stderr.write(
    `${error.code ? error.code + ": " : ""}${error.message}\n`,
  );
  process.exitCode = 1;
});
