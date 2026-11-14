# API

`src/main.ts` 只负责请求边界、启动和关闭。HTTP 指令按业务放在 `src/commands/`：任务、仓库、审查结果、账号、设置、导出等各有一个文件。每个文件导出 `routes`，启动时按文件位置发现并注册；增加或删除同类接口不需要维护入口中的中央清单。

`src/identity.ts` 持有身份与仓库授权判断，`src/preferences.ts` 持有运行时设置，`src/github.ts` 持有 GitHub App 客户端，`src/events.ts` 持有实时连接。`src/utils/http.ts` 统一处理字节限制、JSON 对象输入和错误回复。数据库中的已有数据格式保持兼容。

## 启动和检查

在仓库根目录运行：

```bash
npm ci
npm run build -w @apertureprism/api
node apps/api/dist/apps/api/src/main.js
npx vitest run apps/api/src
```

`DATABASE_URL`、`REDIS_URL` 是启动连接配置；`WEBUI_API_TOKEN` 或已配置的登录会话保护业务接口。只有健康探针、登录入口、安装状态和需要 GitHub 签名的 webhook 在登录前可访问。

`WORKBENCH_DATA_DIRECTORY` 可指定工作台数据目录（兼容旧的 `APERTURE_WORKBENCH_DATA_DIR`），必须是绝对路径。默认目录为用户目录下的 `.apertureprism/workbench`。部署在可信反向代理之后时，显式设置 `TRUST_PROXY=true` 才会使用 `X-Forwarded-For`；默认按 TCP 对端地址限流。反向代理应覆盖来自公网请求的转发头。

## 任务列表和批次

旧的 `GET /tasks?offset=50&limit=25` 继续可用。需要在任务持续入队时翻页，可改用响应中的 `nextCursor`：

```text
GET /tasks?limit=50&status=failed,retry_wait&taskType=pr_review
GET /tasks?limit=50&cursor=<上一页的nextCursor>
```

还可使用 `repositoryId`、`from`、`to` 和 `q` 过滤。游标由创建时间和 UUID 组成，同一毫秒创建的任务不会跨页跳过；游标不能与非零 `offset` 混用。单页最多 200 条。

`POST /tasks/batch` 接收：

```json
{
  "taskIds": ["00000000-0000-0000-0000-000000000001"],
  "action": "retry",
  "dryRun": true
}
```

`action` 支持 `retry`、`cancel`、`priority`。优先级操作另填 `priority`，范围为 -100 到 100；取消可填 `reason`。一个批次最多 200 个 ID，重复 ID 只计算一次。`dryRun` 返回 `would_update` 而不写任务状态。每个任务仍单独检查仓库管理权限；实际写入使用已有任务引擎的条件事务，状态在预览后发生变化时返回 `skipped`。

## 导出与恢复

```text
GET /exports/tasks?format=jsonl&limit=1000
GET /exports/results?type=pr&format=csv&limit=5000
GET /exports/results?type=issue&stream=sse
```

任务导出只含摘要，不导出任务 payload。任务、结果、JSONL 与 SSE 都沿用当前用户的仓库查看权限。CSV 文本单元格防止被表格软件当作公式执行。

JSONL 每行使用 `{"record": {...}, "cursor": "..."}`，保存最后一行游标后，传 `?cursor=...` 可以从下一条继续。SSE 每条 `record` 事件的 `id` 就是恢复游标；重连可用 `Last-Event-ID` 或 `cursor` 参数。CSV 完成时在 HTTP trailer `x-next-cursor` 提供末尾游标。游标包含导出起始时间，恢复时排除起始时间之后新建的记录；已有记录的字段修改仍以读取时的值为准。每次导出最多 50,000 条，按 200 条一页读取并响应下游背压。

## 队列诊断与接口发现

`GET /repositories/:id/queue` 返回该仓库的排队、执行中、重试和失败数量、过期租约、优先级分布、过去 24 小时的失败类别，以及对应的操作提示。它需要仓库查看权限，不读取任务正文或供应商凭据。

`GET /api/routes` 和 `GET /openapi.json` 由应用实际加载的路由推导。正则与前缀入口保存在 OpenAPI 的 `x-aperture-pattern-routes` 中；旧接口尚未声明字段级 schema 的部分不会被描述成完整字段契约。两个发现接口同样需要登录。

## 实时权限和错误

`GET /events?since=<ISO时间>` 保留原有补发形式。实时与补发任务事件均过滤仓库授权；持续连接每分钟刷新授权范围。慢客户端写缓冲超过 1 MiB 时会断开，由客户端重连补发。

错误回复保留 `status`、`reason`，并带相同的 `x-request-id` 供日志关联。原始请求体默认上限为 32 MiB；超限返回 413，格式错误返回 400，内部故障返回 500。webhook 与 WebUI 分别计数，来源计数器最多保留 10,000 个活跃窗口。
