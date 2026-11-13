# 审查工作台

工作台把真实审查结果、人工处置、基线、质量门禁和批次放在同一处。业务文件平铺在 `src/`：改发现状态看 `finding.ts`，改预算看 `budget.ts`，改实际审查交付看 `review.ts`。`index.ts` 只做授权和明确的动作分派，`http.ts` 只解释 HTTP 请求。

## 数据和运行

`createWorkbench({ dataDirectory })` 要求源码目录之外的绝对路径。API、analysis-worker 和本地 CLI 都优先使用 `WORKBENCH_DATA_DIRECTORY`，兼容旧变量 `APERTURE_WORKBENCH_DATA_DIR`，默认 `~/.apertureprism/workbench`。容器需要挂载同一份持久卷；各自的临时目录不会自动同步。

工作台数据保存在 `workbench.json`。一次命令的发现、预算、审计与交付记录一起原子提交；失败时保持旧文件。每次写入在固定的 `workbench.lock` 上取得内核 `flock`，不会按时间强抢慢写者的锁。进程或容器被终止后内核自动释放。需要 Linux/WSL 和 util-linux 的 `flock`，生产镜像已安装它。请使用支持 `flock` 和原子 rename 的文件系统；不要把这些保证直接套用于不具备相同语义的对象存储挂载。

默认快照上限为 32 MiB。HTTP 普通输入上限为 2 MiB，归档输入单独允许 32 MiB 加请求封装。工作台是现有 PostgreSQL 审查系统的补充记录，不替代主任务队列。原始模型输出不会被当成命令执行。

## 调用入口

```ts
import { createWorkbench } from "@apertureprism/review-workbench";

const workbench = createWorkbench({
  dataDirectory: "/var/lib/apertureprism/workbench",
});
const actor = {
  userId: "reviewer-id",
  isAdmin: false,
  canAccessRepository: async (repository: string, write: boolean) => {
    return existingRepositoryPermission(repository, write ? "manage" : "view");
  },
};
const result = await workbench.execute(actor, {
  action: "findings.list",
  input: { repository: "owner/name", limit: 100, offset: 0 },
});
```

Actor 必须来自宿主已认证会话。正文里的 `userId`、`isAdmin`、`actor` 不参与授权。仓库名在检查权限前转为小写，宿主回调也应按 GitHub 的大小写规则查找仓库。业务错误为 `WorkbenchError`，包含 `code`、`status` 和可操作的 `message`。找不到记录和跨仓库越权统一返回 404。

| 主体 | 只读动作 | 写动作 |
| --- | --- | --- |
| 策略 | `policies.list/get/templates/compare` | `policies.create/version/activate/toggle` |
| 基线 | `baselines.list/get/compare` | `baselines.create/activate/archive` |
| 发现 | `findings.list/get` | `findings.create/import/transition/bulk_transition/assign` |
| 忽略规则 | `suppressions.list/get/preview` | `suppressions.create/toggle/renew` |
| 批次 | `batches.list/get/preview` | `batches.create/start/pause/resume/cancel/retry` |
| 人工反馈 | `feedback.list/get/summary` | `feedback.create/resolve` |
| 预算 | `budgets.list/get/availability` | `budgets.create/toggle/limits/reserve/settle/release/expire` |
| 离线评估 | `evaluations.list/get/result/compare` | `evaluations.create` |
| 审计 | `audit.list/get/verify` | 由其它命令自动追加 |
| 仓库总览 | `summary/trends/gate.evaluate` | — |
| 报告 | `reports.formats/render` | — |
| 归档 | `archive.export/preview` | `archive.restore`，仅管理员 |

集合列表返回 `{ items, total }`，主体写入返回当前实体。编辑已有记录可提供 `expectedRevision`，版本不一致时返回 409，不覆盖另一人的修改。

HTTP 前缀为 `/api/workbench`。集合读取使用 `GET /findings?repository=owner/name`，创建使用 `POST /findings`，主体动作使用 `POST /findings/ID/transition`。查询和正文都必须携带 `repository`。报告通过 `GET /reports?repository=owner/name&format=sarif` 下载。趋势通过 `GET /trends?repository=owner/name&days=30` 获取，时间桶是 UTC，数据来自真实审查交付账本。

## 实际审查交付

analysis-worker 的 PostgreSQL outbox 将成功审查写入 `review.sync`。它和批次的 `claim/heartbeat/link/complete` 是内部执行动作，没有对应的公共 HTTP 写接口。

```ts
await workbench.execute(workerActor, {
  action: "review.sync",
  input: {
    repository: "owner/name",
    source: "pr#42",
    reference: "head-commit-sha",
    deliveryKey: "immutable-task-attempt-id",
    sourceSequence: "17945280000000001794528000000000",
    resolveMissing: false,
    findings: [{
      ruleId: "missing-authorization",
      title: "管理入口缺少仓库授权",
      path: "src/api.ts",
      line: 42,
      severity: "high",
      confidence: 0.95,
    }],
  },
});
```

相同交付键和内容重放不增加次数、不追加审计，也不重新打开人工修复的发现。相同键换内容返回 409。`sourceSequence` 是不超过 50 位的正整数字符串，用 BigInt 比较；旧任务晚到会返回 `ignored: true`，不会覆盖更近的审查。无序列的 CLI 手工导入仍可使用。`resolveMissing` 默认关闭，只有确认审查完整、没有因截断漏看文件时，宿主才应将它设为 true。

发现指纹忽略行号，行移动不会制造重复问题。已修复发现被新审查再次报告时重开；已接受风险和误报保留人工判断。基线中的问题升为更高严重度时重新视为新增风险。忽略规则的所有已填条件必须同时满足，且在到期瞬间失效。

## 批次与预算

批次项的 `subject` 可写 `pr:42` 或 `issue:7`，依赖填写项 id；省略 id 时按 `item-1`、`item-2` 生成。真实任务派发器使用批次 id、项 id 和 `generation` 去重。租约过期沿用同一代，用户明确重试失败项时才增加 generation。暂停不发新项，已有项仍可心跳和完成；取消由派发器同步取消真实任务。

预算以整数微美元、输入 token、输出 token 和请求数计数。零额度表示零额度。预留占用预算；重复结算不重复记账；到期预留不占额度并拒绝迟到结算。这里没有支付接口，记账不会自动购买模型额度。

## 归档与报告

```bash
npm run build -w @apertureprism/review-workbench
node scripts/review-workbench.mjs --repository owner/name --action archive.export --output workbench-backup.json
node scripts/review-workbench.mjs --repository owner/name --action archive.preview --archive workbench-backup.json
node scripts/review-workbench.mjs --repository owner/name --action archive.restore --archive workbench-backup.json --confirm-checksum SHA256_FROM_PREVIEW
node scripts/review-workbench.mjs --repository owner/name --action reports.render --json '{"format":"sarif"}' --output review.sarif
```

CLI 具有数据目录所有者权限。`--output` 只创建新文件，已有文件不会被覆盖。归档只包含指定仓库。预览检查 schema、SHA-256、主体唯一键和引用，管理员恢复还要显式回传预览 checksum。校验值说明内容完整，不是对来源的数字签名。恢复保留当前审计并追加恢复事件；备份中的原审计作为归档证据，不会被伪造成当前实例里发生的操作。运行租约会清空，未结算预算预留会释放。

报告格式放在 `src/formats/`，每个文件导出 `mimeType`、`extension` 和 `render` 即可被自动发现。CSV 转义公式开头，Markdown 转义 HTML 和表格控制字符，SARIF 使用标准位置与稳定指纹。

## 验证

```bash
npm run build -w @apertureprism/review-workbench
npx vitest run packages/review-workbench/src
npx eslint packages/review-workbench/src scripts/review-workbench.mjs
```

测试包含真实 HTTP 请求、四进程并发写、慢写不抢锁、SIGKILL 后释放、已编译入口从其它 cwd 调用、预算竞争、反序审查交付，以及恢复失败时不部分写入。跨进程测试调用刚编译的 JavaScript，因此需先 build。
