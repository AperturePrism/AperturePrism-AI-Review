# 检查通过自动合并

在「已安装仓库」打开某个仓库的「检查通过自动合并」，选择合并方式和必须出现的检查名称，保存后生效。每个检查名称独占一行；留空表示检查全部已经上报的检查。此功能默认关闭，只有该仓库具有管理权限、且不是只读账号的用户可以修改。全局设置不会替代仓库的明确开启。

开启后，新完成的 PR 审查可以产生一个持久合并请求。已经完成的历史审查不会因为开启开关而自动合并；关闭开关会取消还在等待的请求，再次开启后需要重新审查。

## 什么时候会合并

调度器每十秒检查一次队列。以下条件同时满足时，才会向 GitHub 发出合并请求：

- 当前提交有已完成、已发布的明确批准审查，没有发现、隐藏发现或被抑制的发现，覆盖完整，评估门禁通过。
- 本次结果已交付工作台，当前工作台策略的质量门禁仍通过。
- 配置中指定的检查全部出现，并且所有 GitHub Check Runs 与旧式 Commit Statuses 都成功。排队中、失败、跳过、中性、空检查列表均不会视为通过。
- 审查者没有尚未撤销的修改请求；PR 不是草稿、没有冲突，GitHub 报告可以合并且分支条件已满足。
- PR 的当前 head SHA 与审查的 SHA 一致，审查未被新任务替代。

合并前再次读取 PR。最终 `PUT /repos/{owner}/{repo}/pulls/{number}/merge` 携带审查的 SHA，让 GitHub 拒绝检查后新推送的版本。原有分支保护、必需审批与 GitHub 权限限制继续生效。平台不自动撤销审查、不删除分支，也不会修改分支保护。

合并方式支持 squash、merge、rebase，默认 squash。GitHub App 需要目标仓库的 Contents 写权限、Pull requests 写权限、Checks 与 Commit statuses 读权限；权限不足会显示等待原因并重试，不降级绕过。仓库禁用了所选合并方式时也由 GitHub 拒绝。

## 查看运行状态

同一个面板显示请求历史、PR 编号、审查 SHA、合并方式、状态和原因：

| 状态 | 含义 |
| --- | --- |
| 待处理 | 审查已登记请求，等待调度 |
| 等待中 | CI 尚未完成、必需检查尚未出现，或 GitHub 暂时不可用 |
| 已阻塞 | 审查或质量门禁不通过、检查失败、草稿、冲突或审批条件未满足 |
| 已合并 | GitHub 确认合并，记录合并提交 SHA |
| 已取消 | 开关关闭、PR 关闭、出现新提交或更新的审查 |

暂时阻塞的请求每三十秒重新检查，CI 重跑成功后可以继续。状态保存在 PostgreSQL，服务重启不会丢失。多个调度实例使用数据库锁避免重复执行；合并响应丢失时，通过 GitHub 的已合并状态恢复记录。

## 接口与代码位置

`GET /repositories/:id/auto-merge?limit=20` 读取历史及 `canManage`；`PUT /repositories/:id/auto-merge/settings` 原子保存三个选项：

```json
{"enabled":true,"method":"squash","requiredChecks":["build","test"]}
```

设置仍保存在 `repository_settings`，三个键为 `pr_auto_merge_enabled`、`pr_auto_merge_method`、`pr_auto_merge_required_checks`。检查名称以 JSON 数组保存，可以包含逗号；读取也兼容手写逗号或换行列表。泛用单键设置接口不接受这三个键，避免保存一半配置就执行。

| 修改目标 | 位置 |
| --- | --- |
| 开关、合并方式和检查名称解析 | `packages/config/src/auto-merge.ts` |
| 数据表与合并意图 | `packages/database/src/auto-merge.ts`、迁移 `0024_pull_request_auto_merge.sql` |
| 审查是否允许自动合并 | `packages/pr-review/src/auto-merge.ts` |
| 审查结束后排队、失败重跑撤销 | `apps/analysis-worker/src/auto-merge.ts` |
| 检查与执行、重试和恢复 | `apps/scheduler/src/auto-merge.ts` |
| HTTP 权限、原子配置与历史 | `apps/api/src/commands/auto-merge.ts` |
| 页面表单与历史 | `apps/web/src/components/AutoMergePanel.tsx` |

升级前运行数据库迁移，并确保 API、analysis-worker、scheduler 的 `WORKBENCH_DATA_DIRECTORY` 指向同一工作台目录。生产 Compose 已为调度器挂载该持久卷。
