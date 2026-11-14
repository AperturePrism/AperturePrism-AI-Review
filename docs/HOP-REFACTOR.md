# 审查工作流与工作台

本次重构依据 [HOP](https://github.com/kernel4632/HOP)：按用户会寻找的业务组织代码，把入口、数据归属、扩展方式和错误边界写在项目里。现有 HTTP 路径、数据库迁移和原调用出口保持兼容。

## 从哪里改

| 想改的行为 | 位置 | 数据归属 |
| --- | --- | --- |
| HTTP 认证、统一错误、启动关闭 | `apps/api/src/main.ts`、`identity.ts` | 原用户、会话和授权表 |
| 某个 HTTP 业务 | `apps/api/src/commands/` | 对应主体在同一文件中完成请求处理 |
| Issue 分析、预读源码、标签与指派 | `apps/analysis-worker/src/issue.ts`、`files.ts` | 原任务、结果、仓库记忆 |
| PR 审查、专家模式、发布与对话历史 | `apps/analysis-worker/src/pull-request.ts` | 原任务、结果、发布幂等记录 |
| 审查证据、基线、抑制、门禁和风险 | `packages/pr-review/src/` | 评估对象；工作台负责持久化 |
| 队列、失败恢复、批次、时间线 | `packages/task-engine/src/` | 原 PostgreSQL 任务与事件表 |
| 模型并发、熔断、费用和缓存 | `packages/model-router/src/` | 每个适配器集合的运行状态 |
| 策略、发现、反馈、预算和归档 | `packages/review-workbench/src/` | `WORKBENCH_DATA_DIRECTORY` |
| 声明式规则、审批、运行步骤和报告 | `packages/review-automation/src/` | `AUTOMATION_DATA_DIRECTORY` |
| 离线数据集、发现匹配和模型结果对比 | `packages/review-evaluation/src/` | 用户显式提供的 JSONL 与运行清单 |
| 工作台和自动化页面 | `apps/web/src/features/`、`pages/` | 通过 HTTP 读取；不造演示数据 |
| 现有页面的 HTTP 调用 | `apps/web/src/lib/api/` | 同一 HTTP、认证和缓存边界 |

API 入口不再承载全部业务。每个 command 文件声明自己的路由；启动时自动发现。精确路径优先于带参数路径，方法和权限在统一边界判断。`GET /api/routes` 与 `GET /openapi.json` 从同一份路由元数据生成。

网页的页面声明同样自动发现：名称、分组、图标、导航和匹配规则来自页面本身。原 `lib/api.ts` 保留兼容导出，缓存只有一个所有者；身份改变时旧缓存失效，在途旧响应不能回填新身份。

## 一次真实审查

1. 领取 PostgreSQL 任务并创建永久 `task_attempts.id`。人工重跑即使重置尝试次数，也不会复用交付身份。
2. 读取任务对应的 PR head；读取 diff 前后再次核对版本。预读源码绑定该 SHA。
3. 调用普通审查或专家团队。两条路径都产生证据、覆盖、风险、依赖影响和配置检查评估。
4. 记账时确认当前尝试仍持有租约。最终外发前推进 `publishing`，取消或失去租约就停止；发布前重新核对当前 head。
5. 通过原幂等发布记录更新 GitHub。对外写入成功后，即使恰好取消，仍保存返回的对象 ID，避免下次重复发布。
6. 把结果存入原结果表，并写入持久 outbox。工作台或自动化目录暂时不可用时延后交付，不丢同步任务。
7. 工作台用证据指纹合并发现，用永久交付键去重，用数据库任务顺序拒绝晚到的旧版本。输入被裁剪或策略过滤时，不把未再次报告的问题当作已经修复。

自动化消费 `review.completed`，只拿仓库、版本、门禁和发现数量，不复制源码和原始证据。规则可以要求人工审批、生成报告或在已授权仓库处置发现；默认动作不外发消息。

仓库还可以显式开启[检查通过自动合并](AUTO-MERGE.md)：worker 只登记绑定审查 SHA 的合并意图，scheduler 在完整审查、工作台门禁和 GitHub 检查通过后执行；新提交、失败审查与关闭开关都会阻止旧请求继续合并。

## 批量审查

工作台批次的项使用 `pr#123`、`issue#123` 或同仓库的 GitHub URL，引用可用 `current` 或明确版本。开始后，analysis-worker 的维护周期把项交给真实 `analysis_tasks`，保留稳定去重键和工作台租约。

「已安装仓库」的手动审查入口可以勾选多个 Issue 或 PR，选择当前列表、清空选择，并调整并发数。提交后创建并启动持久批次，页面提供批量审查进度入口。切换仓库或对象类型会清空旧选择；启动请求失败时保留原批次，重试先读取实际状态，避免重复启动。原来的单编号触发方式仍可使用。

依赖未完成的项不会领取。暂停后停止领取；取消会传到实际任务。worker 重启会按持久关联恢复；失败重试复用原任务，人工开启新一代批次才生成新的业务去重键。状态、错误和任务链接由实际队列回写，HTTP 不提供内部领取、续租或伪造完成接口。

## 持久目录与升级

源码运行需要 Node.js 22 以上，以及 `flock`（Linux 的 util-linux；Windows 可在 WSL 内运行）。Docker 镜像已包含该依赖。

```dotenv
WORKBENCH_DATA_DIRECTORY=/var/lib/apertureprism/workbench
AUTOMATION_DATA_DIRECTORY=/var/lib/apertureprism/automation
```

API 和 analysis-worker 必须指向相同目录。未设置时使用用户目录下的 `.apertureprism/workbench` 与 `.apertureprism/automation`。生产 Compose 给两者配置独立持久卷；不会写进代码目录。

文件提交使用内核锁、临时文件、同步和原子重命名；进程退出后锁自动释放。工作台归档恢复先校验结构、仓库关联和校验和，再由管理员确认。运行租约不会原样复活；归档内的历史审计不会被伪造成当前新事件。

签名会话现在还会核对数据库中的撤销与过期状态。升级前没有落入会话表的旧 OAuth 会话需要重新登录。

## 扩展一类能力

- 审查配置检查：在 `packages/pr-review/src/checks/` 放一个符合检查契约的文件，只对实际读到的内容给出路径、行号和已脱敏证据。
- 审查报告：在 `packages/pr-review/src/formats/` 增加格式；工作台报告使用 `packages/review-workbench/src/formats/`。
- HTTP 业务：在 `apps/api/src/commands/` 声明路由及方法、权限和处理函数。
- 网页：添加页面声明；已有业务调用与表单放在对应主体中。

配置检查是可核查的审阅提醒，不自动升级为已验证漏洞。依赖图和测试影响仅基于明确读取的快照；不完整快照会保留限制说明。

API 与 worker 的构建配置会包含动态模块源码。`npm run verify:runtime` 直接检查最终 app/dist 中的发现结果，避免只在源码测试里可用。

## 验证与离线工具

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm test
npm run verify:runtime
npm --prefix apps/web ci
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
npm --prefix apps/web test
```

数据库回归使用独立的 PostgreSQL 与 pgvector 测试实例：

```bash
APERTUREPRISM_INTEGRATION_DATABASE_URL=postgres://user:password@localhost/review_test npm run test:integration
```

脚本会构建项目、对指定测试库应用迁移、再跑测试。PR CI 也提供独立的 PostgreSQL 与 Redis 服务；不以跳过数据库测试冒充集成验证。

```bash
npm run workbench -- --help
npm run review:evaluate -- --help
npm run review:automate -- --help
```

离线评估不会调用模型。它校验数据集哈希和预测清单，计算发现匹配、precision/recall/F1、严重度加权、费用和延迟，并支持 Bootstrap 差异与回归门禁。示例、输入价格和推导结果都与真实测量区分。具体格式见两个新包的 README。
