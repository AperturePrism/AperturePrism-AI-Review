# AperturePrism 在线更新（Online Update）落地计划

> 版本：v1.0.15 · 状态：**P1–P4 已实现（v1.0.7 起完整可用，v1.0.13 增加阶段进度）** · 关联：[总体设计](APERTUREPRISM_AI_REVIEW_PROJECT_DESIGN.md) · [运维手册](RUNBOOK.md)
>
> 实现记录（v1.0.1）：
> - `GET /update/status`：GHCR Registry 匿名查询 tags/digest，对比当前版本（`UPDATE_VERSION` 注入）
> - `POST /update/apply`：管理员，SSE 流式日志，容器内执行 `scripts/update.sh`（pull→migrate→up→health→回滚）
> - `GET /update/history`：`system_settings.update_history` 持久化
> - 执行通道：api 镜像内置 docker CLI + compose 插件，compose 挂载 `docker.sock:ro`；`AP_VERIFY=1` 时叠加 `compose.verify.yml`（NAS 地址池耗尽场景）
> - 前端：系统配置页「版本与更新」区块（UpdatePanel.tsx：检查/更新/日志/历史）
>
> 修复记录（v1.0.3）：
> - nginx / Vite 补 `/update` 反向代理，修复 WebUI 版本显示「未知」与 `Unexpected token '<'` JSON 解析错误（此前 `/update` 请求被 SPA 兜底返回 HTML）
> - `currentVersion()` 增加镜像内 `package.json` 版本兜底：未注入 `IMAGE_TAG`/`UPDATE_VERSION` 时也显示真实版本
>
> 增强记录（v1.0.13）：
> - `scripts/update.sh` 输出 `stage` 阶段标记（backup/pull/migrate/up/health/done），后端转为独立 `stage` SSE 事件
> - UpdatePanel 增加阶段进度条、日志折叠（默认收起）、更新完成倒计时自动刷新页面

## 1. 背景与目标

AperturePrism 通过 Docker Compose + GHCR 镜像分发，每个部署者当前需手动执行
`docker compose pull && docker compose up -d --force-recreate`（以及手动跑 `migrate`）才能升级。

**目标**：把升级链路内建为产品能力——任何部署者在 WebUI 即可：

1. 查看「当前版本 / 最新版本 / 是否可更新」（只读）
2. 一键执行更新：拉取新镜像 → 迁移数据库 → 滚动重建 → 健康确认 → 失败自动回滚
3. 查看更新过程日志与历史

适用对象：所有以 Docker Compose 方式部署的用户（含本项目 NAS 生产实例）。

## 2. 非目标

- 不做后台静默/强制推送更新（默认用户手动触发；可后续加「自动检查」开关）
- 不做多主机/多实例编排与灰度
- 不替代容器健康检查与备份机制（复用现有 `/health/ready`、`scripts/backup.mjs`）

## 3. 总体架构

```text
WebUI（版本与更新区块） ──> apps/api (/update/*) ──> scripts/update.sh（容器内）
                                                        │
                                                        ├─ docker compose pull（GHCR，匿名可拉）
                                                        ├─ docker compose run --rm migrate
                                                        ├─ docker compose up -d --force-recreate
                                                        └─ 轮询 http://<api>/health/ready → 失败回滚
版本对比数据源：ghcr.io Registry HTTP API（公开，无需 token）
```

关键前提：

- api 容器挂载 `/var/run/docker.sock:/var/run/docker.sock:ro`，镜像内置 `docker` CLI + `docker compose` 插件（或更新脚本由独立 `docker:cli` 容器执行，二选一，见 §8）
- 更新操作只允许作用于 `COMPOSE_PROJECT_NAME=apertureprism-ai-review`（本项目），防止越权操作主机上其他容器
- 所有 `/update/*` 写操作需管理员并写入审计日志

## 4. 接口定义

### 4.1 `GET /update/status`（任意已登录用户可读；含版本对比）

用于 WebUI 展示「当前 / 最新 / 可更新」。

请求：`GET /update/status`

响应 `200`：

```jsonc
{
  "current": {
    "version": "v1.0.0",                 // 运行版本（来自 compose 注入 env UPDATE_VERSION 或镜像 label）
    "composeProject": "apertureprism-ai-review",
    "web": { "image": "ghcr.io/apertureprism/apertureprism-ai-review/web:v1.0.0", "digest": "sha256:…" },
    "api":  { "image": "…/api:v1.0.0",     "digest": "sha256:…" }
  },
  "latest": {
    "tags": ["v1.0.0", "latest", "main"],  // GHCR 上可用的版本标签（过滤 stable/语义化版本）
    "webDigest": "sha256:…",                // 最新 stable 或 latest 的 digest
    "publishedAt": "2026-08-21T…"
  },
  "updateAvailable": false,                // current 与 latest digest 是否不一致
  "updateChannel": "latest"                // 当前跟随的更新通道（stable | latest | 固定版本）
}
```

错误：

- `401`：未登录
- `503`：GHCR 查询失败（网关问题），`body: { "status":"error", "reason":"registry_unreachable", "degraded": true }`

### 4.2 `POST /update/apply`（仅管理员，写审计）

触发一次更新。响应为 **SSE 流式日志**，前端滚动展示。

请求：`POST /update/apply`

```jsonc
{
  "target": "latest",        // 可选；合法值：语义化版本 vX.Y.Z | latest | stable；默认 latest
  "backupBefore": true       // 可选；默认 true，更新前执行 scripts/backup.mjs
}
```

响应：`200`，`content-type: text/event-stream`（每个事件）：

```text
event: log
data: {"seq":1,"level":"info","message":"backup OK (settings=8 policies=6)"}

event: log
data: {"seq":2,"level":"info","message":"pulling web:latest api:latest …"}

event: log
data: {"seq":3,"level":"info","message":"migrate done"}

event: log
data: {"seq":4,"level":"info","message":"recreate ok"}

event: done
data: {"ok":true,"previous":"v1.0.0","applied":"latest","digest":"sha256:…"}
```

失败/回滚时：

```text
event: log
data: {"seq":5,"level":"error","message":"health check failed (12/12)"}
event: log
data: {"seq":6,"level":"warn","message":"rolling back to v1.0.0 …"}
event: done
data: {"ok":false,"reason":"health_check_timeout","rolledBackTo":"v1.0.0"}
```

状态码：

- `400`：`target` 不合法（不满足 `^v?\d+\.\d+\.\d+$|^latest$|^stable$`）
- `401` / `403`：未登录 / 非管理员
- `409`：已有更新任务在运行
- `500`：脚本启动失败

### 4.3 `GET /update/history`（仅管理员）

返回最近更新记录（来源：审计日志或独立 `update_logs` 表）。

```jsonc
{ "items": [ { "at":"…", "from":"v1.0.0", "to":"latest", "ok":true, "digest":"sha256:…" } ] }
```

## 5. 更新脚本 `scripts/update.sh`

幂等、参数化、可回滚；dry-run 模式用于验证。

```bash
scripts/update.sh \
  --target latest \
  --compose-file docker/docker-compose.prod.yml \
  --env-file /path/.env.production \
  --project apertureprism-ai-review \
  --api http://127.0.0.1:3300 \
  --token "$WEBUI_API_TOKEN" \
  [--backup] [--dry-run]
```

流程（任一步失败且 `--rollback-on-fail` 默认开启则回滚）：

1. `--dry-run` 则仅打印将执行命令，退出
2. （可选）备份：`node scripts/backup.mjs`
3. 校验 `target` 合法性（同 §4.2 正则）；记录 `previous` 版本（当前镜像 tag）
4. `docker compose pull`（目标 tag 全服务）
5. `docker compose run --rm migrate`
6. `docker compose up -d --force-recreate`
7. 轮询 `<api>/health/ready`（默认 12 次 × 5s），全部通过则成功
8. 失败：`docker compose up -d --force-recreate` 切回 `previous` tag，再次健康检查
9. 输出 `done`（成功/回滚）并写审计

约束：

- 脚本内只允许对 `$PROJECT` 指定的 compose 项目操作（防越权）
- 输出每行 `JSON` 日志（`seq/level/message`），由 API 转 SSE
- 所有路径/凭据来自 `--env-file`，不硬编码

## 6. 前端 UI「版本与更新」区块

位置：`系统配置`页新增「版本与更新」卡片（或 `关于`页）。

内容：

- 当前版本徽标（`v1.0.0`）+ 更新时间通道（latest/stable/固定）
- 「检查更新」按钮 → `GET /update/status`，显示 最新版本 / 更新时间 / `updateAvailable` 状态徽章
- 「更新到最新」按钮（仅管理员）→ 二次确认 → `POST /update/apply` → SSE 日志滚动框（成功绿 / 失败红 + 回滚提示）
- 更新历史列表（`GET /update/history`）

交互细节：

- 更新进行中禁用按钮并显示进度
- 失败后显示回滚结果与「查看日志」入口
- 文案：`当前 v1.0.0 · 可更新到 latest` / `正在更新…` / `更新成功，已回滚到 v1.0.0`

## 7. 部署形态变化（向后兼容）

对现有 `docker/docker-compose.prod.yml` 的最小改动：

```yaml
services:
  api:
    # …现有配置不变…
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro   # 新增：供在线更新调用 docker/compose
    environment:
      UPDATE_VERSION: ${IMAGE_TAG:-latest}              # 新增：运行版本注入（API 读取）
```

配套：

- 镜像（api/web 基础镜像或独立 updater）需内置 `docker` CLI 与 `docker compose` 插件；或在 compose 中新增 `updater` 服务（`docker:cli` 镜像 + sock + 挂载脚本目录）由 API 调用
- `.env.production` 增加 `IMAGE_TAG` 语义说明（跟随哪个 tag 视为"当前版本"）
- 更新脚本随镜像分发（`/app/scripts/update.sh`）或挂载

## 8. 安全设计

| 风险 | 缓解 |
|---|---|
| docker.sock 越权 | 只读挂载（`:ro`）；容器内受限用户；脚本对 `$PROJECT` 白名单校验；命令参数化、禁用 shell 拼接 |
| 非管理员触发更新 | `/update/*` 写操作要求管理员 + `isAdminRequest`；审计 `update.apply` |
| target 注入 | 语义化版本 / `latest` / `stable` 白名单正则 |
| 更新过程崩溃 | 脚本幂等 + `previous` 记录 + 自动回滚 + 健康轮询 |
| 镜像拉取异常 | 失败不进入 migrate/up，直接回滚 |
| 审计缺失 | 每次 apply 写 `audit` 条目，`/update/history` 可回溯 |

## 9. 实施计划

| 阶段 | 任务 | 改动文件 | 依赖 |
|---|---|---|---|
| **P1 检查更新** | Registry API 封装（tags/digest 对比）；`GET /update/status`；前端「版本与更新」只读区块 | `packages/github-adapter` 或新 `packages/update-check`、`apps/api`、`apps/web` | 无 |
| **P2 更新脚本** | `scripts/update.sh`（dry-run/幂等/回滚/JSON 日志）；本地与 NAS 先 dry-run 再真跑 | `scripts/update.sh`、`docker/docker-compose.prod.yml`（挂 sock）、`docker/Dockerfile`（内置 docker CLI 或 updater 服务） | P1 的版本读取 |
| **P3 执行端点** | `POST /update/apply`（校验/SSE 转发/审计/并发锁）；`GET /update/history`；前端更新按钮+日志流 | `apps/api`、`apps/web` | P2 脚本 |
| **P4 打磨** | 自动检查开关（可选）、备份前置、更新历史持久化、文案与空态 | 前端/API | P3 |

## 10. 验收清单

### P1（检查更新）

- [ ] `GET /update/status` 在已登录下返回 `current/latest/updateAvailable`，字段齐全
- [ ] 当前为 `v1.0.0` 且 GHCR 无更新时 `updateAvailable=false`
- [ ] 模拟 GHCR 新 tag（推送测试 `v1.1.0-rc.1`）后 `updateAvailable=true` 且 `latest.tags` 含该 tag
- [ ] GHCR 不可达时返回 `503 degraded:true`，前端显示「暂无法检查」而非报错
- [ ] 未登录 `401`；前端「版本与更新」区块正常渲染当前/最新版本
- [ ] `typecheck` + `build` 通过；CI 全绿

### P2（更新脚本）

- [ ] `--dry-run` 只打印命令不执行任何 docker 操作
- [ ] 合法/非法 `target`（`v1.1.0` vs `abc;rm -rf`）分别成功/拒绝
- [ ] 更新到测试 tag：pull → migrate → up 顺序正确，健康轮询通过，`done ok`
- [ ] 人为制造迁移失败：脚本检测到后**不**继续 up，执行回滚到 `previous`，输出 `rolledBackTo`
- [ ] 日志为合法 JSON 行（`seq/level/message`）
- [ ] 只操作 `$PROJECT` 项目；对主机其他容器无任何影响

### P3（执行端点）

- [ ] `POST /update/apply` 仅管理员可调用（普通用户 403）
- [ ] 响应为 SSE：含 `log` 与 `done` 事件，`done` 携带 `ok/applied/previous`
- [ ] 并发调用第二个 apply 返回 `409`
- [ ] 更新成功后 `/update/history` 出现记录；审计写入 `update.apply`
- [ ] 前端：更新按钮二次确认、日志滚动、成功后按钮恢复、失败显示回滚结果

### P4（打磨）

- [ ] 「自动检查更新」开关（默认关）持久化并可热更新
- [ ] 更新前备份默认开启；备份失败则中止更新
- [ ] 历史记录持久化（跨重启保留），支持分页
- [ ] 文案、空态、错误态齐全；浅色/深色主题下展示正常

### 整体

- [ ] 在测试环境（本地或 NAS 副本）完整走一遍：v1.0.0 → 更新到测试 tag → 数据完整（10 任务不丢）→ 回滚验证
- [ ] README 增加「在线更新」使用说明（含权限与回滚）
- [ ] 文档更新：运维手册（RUNBOOK）补充更新章节

## 11. 风险与回滚

- 迁移破坏性：migrate 设计为幂等（现有约定），更新前备份兜底
- docker.sock 是权限敏感点：只读 + 白名单 + 管理员三重收敛；若无法接受，可退化为「仅 SSH/命令行触发脚本」，UI 只做检查与引导
- GHCR 抖动：Registry API 查询失败降级为"暂无法检查"，不阻塞主功能
- 回滚覆盖度：仅镜像回滚；DB 迁移后若需降级需人工介入（文档提示）

## 11.5 关联功能：安装仓库同步（已实现）

在线更新的前置能力是「WebUI 能反映 GitHub App 的安装仓库」。此功能已实现：

- **接口**：`POST /repositories/sync`（管理员）——按 `repositories.installation_id` 去重遍历已知安装，调 GitHub API
  `GET /installation/repositories` 拉取仓库并按 `github_id` upsert 入库；审计 `repositories.sync`。
- **自动同步**：API 启动后 `setInterval` 每 **12 小时**执行一次（`REPOSITORY_SYNC_INTERVAL_MS`），并发互斥（`repositorySyncRunning`），
  单个安装失败不影响其他安装。
- **前端**：WebUI「已安装仓库」页新增「同步仓库」按钮，展示同步结果（安装数 / 同步数 / 失败数），成功后刷新列表。
- **实现文件**：`packages/github-adapter/src/client.ts`（`listInstallationRepositories`）、
  `packages/database/src/webhooks.ts`（`upsertInstalledRepositories`）、
  `apps/api/src/main.ts`（`syncInstallations` / `handleRepositorySync` / 定时任务）、
  `apps/web/src/pages/ReposPage.tsx` + `apps/web/src/lib/api.ts`。
- **说明**：仓库来源仍以 Webhook 事件为准（实时），同步用于兜底「授权后未产生事件」的仓库；GitHub App 无 `installation_repositories`
  webhook 事件订阅时，此同步是让新授权仓库出现在 WebUI 的唯一途径。

## 12. 参考资料

- GHCR Registry HTTP API（匿名 tags/manifests）：`https://ghcr.io/v2/apertureprism/apertureprism-ai-review/<svc>/tags/list`
- 现有健康检查：`apps/api` 的 `/health/live` `/health/ready`
- 现有备份：`scripts/backup.mjs`；现有迁移：`docker-compose.prod.yml` 的 `migrate` 服务
