#!/usr/bin/env node
/**
 * 本地工作台管理入口。仅操作 --data-dir 指定的数据，不联系付费模型或 GitHub。
 * 示例：npm run build -w @apertureprism/review-workbench
 * node scripts/review-workbench.mjs --repository owner/repo --action summary
 * node scripts/review-workbench.mjs --repository owner/repo --action policies.create --json '{"name":"生产门禁"}'
 */
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const help = `AperturePrism 审查工作台

使用：node scripts/review-workbench.mjs --repository owner/repo --action summary [选项]

--data-dir PATH    工作台数据绝对路径，默认 ~/.apertureprism/workbench
--repository NAME  仓库 owner/name，必填
--action NAME      业务动作，例如 findings.list、policies.create、reports.render
--json JSON        作为输入的 JSON 对象
--input FILE       从 UTF-8 JSON 文件读取输入（不能与 --json 同时使用）
--archive FILE     读取归档文件，供 archive.preview 或 archive.restore 使用
--confirm-checksum SHA256  恢复时显式确认预览校验值
--output FILE      把结果写到此文件；报告写原格式，其它操作写 JSON
--user NAME        审计操作者，默认本地用户
--help             显示本说明

常用动作：
  summary / policies.templates / policies.list / policies.create / policies.version
  findings.import / findings.list / findings.transition / findings.assign
  baselines.create / baselines.activate / baselines.compare
  suppressions.create / suppressions.preview / suppressions.renew
  batches.create / batches.start / batches.claim / batches.complete / batches.preview
  budgets.create / budgets.reserve / budgets.settle / budgets.availability
  feedback.create / feedback.resolve / feedback.summary
  evaluations.create / evaluations.result / evaluations.compare
  gate.evaluate / reports.render / audit.list / audit.verify
  trends / archive.export / archive.preview / archive.restore

报告示例：--action reports.render --json '{"format":"sarif"}' --output review.sarif
备份示例：--action archive.export --output workbench-backup.json
预览示例：--action archive.preview --archive workbench-backup.json
恢复示例：--action archive.restore --archive workbench-backup.json --confirm-checksum SHA256_FROM_PREVIEW
本地 CLI 具有数据目录所有者权限；生产 HTTP 仍使用登录和仓库授权。
`;

async function main() {
  const values = new Map();
  const allowed = new Set([
    "data-dir",
    "repository",
    "action",
    "json",
    "input",
    "archive",
    "confirm-checksum",
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
    const key = argument.slice(2);
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} 缺少值`);
    if (values.has(key)) throw new Error(`${argument} 不能重复`);
    values.set(key, value);
    index += 1;
  }
  const repository = values.get("repository");
  if (!repository) throw new Error("请提供 --repository owner/name");
  if (values.has("input") && values.has("json"))
    throw new Error("--input 和 --json 只能选一个");
  const directory =
    values.get("data-dir") ??
    process.env.WORKBENCH_DATA_DIRECTORY ??
    process.env.APERTURE_WORKBENCH_DATA_DIR ??
    join(homedir(), ".apertureprism", "workbench");
  if (!isAbsolute(directory)) throw new Error("--data-dir 必须为绝对路径");
  const input = JSON.parse(
    values.has("input")
      ? await readFile(resolve(values.get("input")), "utf8")
      : (values.get("json") ?? "{}"),
  );
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("输入必须是 JSON 对象");
  const moduleUrl = new URL(
    "../packages/review-workbench/dist/index.js",
    import.meta.url,
  );
  let createWorkbench;
  try {
    ({ createWorkbench } = await import(moduleUrl.href));
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND")
      throw new Error(
        "请先执行 npm run build -w @apertureprism/review-workbench",
      );
    throw error;
  }
  const action = values.get("action") ?? "summary";
  if (values.has("archive")) {
    if (action !== "archive.preview" && action !== "archive.restore")
      throw new Error("--archive 仅用于 archive.preview 或 archive.restore");
    input.archive = JSON.parse(
      await readFile(resolve(values.get("archive")), "utf8"),
    );
  }
  if (values.has("confirm-checksum"))
    input.confirmChecksum = values.get("confirm-checksum");
  const workbench = createWorkbench({ dataDirectory: directory });
  const actor = {
    userId:
      values.get("user") ??
      process.env.USER ??
      process.env.USERNAME ??
      "local-cli",
    isAdmin: true,
    canAccessRepository: () => true,
  };
  const result = await workbench.execute(actor, {
    action,
    input: { ...input, repository },
  });
  const content =
    action === "reports.render"
      ? result.content
      : JSON.stringify(result, null, 2) + "\n";
  if (values.has("output")) {
    const output = resolve(values.get("output"));
    await writeFile(output, content, { mode: 0o600, flag: "wx" });
    process.stderr.write(`已创建 ${output}\n`);
  } else process.stdout.write(content);
}

main().catch((error) => {
  process.stderr.write(
    `${error.code ? error.code + ": " : ""}${error.message}\n`,
  );
  process.exitCode = 1;
});
