# AperturePrism 运维手册（Runbook）

本手册覆盖 M11 生产加固的可操作部分：启动、迁移、备份/恢复、健康检查、常见故障与告警。

## 1. 组件与端口

| 组件 | 进程 | 说明 |
| --- | --- | --- |
| `api` | `node apps/api/dist/apps/api/src/main.js` | HTTP / webhook / SSE，端口 `API_PORT`（默认 30001） |
| `analysis-worker` | 同上（analysis-worker） | 领取并执行 Issue/PR 任务 |
| `index-worker` | 同上（index-worker） | 定时索引仓库 Issue（内容哈希去重） |
| `scan-worker` | 同上（scan-worker） | 定时扫描已安装仓库并自动建分析任务（WebUI「仓库扫描」） |
| `scheduler` | 同上（scheduler） | 每 10s 回收过期 lease、释放到期 retry |
| `postgres` | pgvector/pgvector:pg16 | 业务数据 + `issue_documents` 向量 |
| `redis` | redis:7-alpine | SSE 广播与任务事件分发 |

进程之间通过 `DATABASE_URL` / `REDIS_URL` 协作；AI 凭据由 worker 用 `CREDENTIAL_MASTER_KEY` 解密 `provider_accounts`。

## 2. 首次部署

```bash
# 1. 准备环境文件（密钥不入库）
cp .env.example .env.production
#    填好 DATABASE_URL / REDIS_URL / CREDENTIAL_MASTER_KEY / GITHUB_* / EMBEDDING_*

# 2. 应用迁移（先于应用启动）
DATABASE_URL=... node scripts/migrate.mjs

# 3. 启动
docker compose -f docker/docker-compose.prod.yml --env-file .env.production up -d

# 4. 健康检查
curl http://<host>:30001/health/live
curl http://<host>:30001/health/ready   # 200 才代表 DB+Redis 均就绪
```

## 3. 迁移发布流程

1. 新增 schema 变更后生成正式迁移：
   ```bash
   DATABASE_URL=... npx drizzle-kit generate --config packages/database/drizzle.config.ts
   ```
   （已提交的 `0007`、`0008` 为手工维护的增量 SQL，同样追加到 `migrations/meta/_journal.json`。）
2. 应用迁移使用自研执行器 `node scripts/migrate.mjs`：按 `_journal.json` 顺序直接执行 `<tag>.sql`
   并记录到 `drizzle.__drizzle_migrations`。不要用 `drizzle-kit migrate` 应用——它对无 snapshot
   的手写迁移会静默失败（NAS 真机实测发现并已修复）。
3. 先在隔离测试库执行：`DATABASE_URL=<test> node scripts/migrate.mjs`。
4. 生产发布：停应用容器 → 执行 `node scripts/migrate.mjs` → 启动新镜像。
5. 迁移可重入（记录已执行版本），失败后修复再跑即可。

## 4. 备份与恢复

```bash
# 备份（compose 方式，输出到 ./backups/<iso>.sql）
node scripts/backup.mjs

# 恢复（示例）
docker compose -f docker/docker-compose.prod.yml exec -T postgres \
  psql -U apertureprism -d apertureprism < backups/<iso>.sql
```

建议：每日备份 + 保留 N 份；`issue_documents` 可由 index-worker 重建，恢复后可选择重建而非依赖其备份。

## 5. 运维操作

- **手动触发索引**：`POST /index/run`（WebUI 向量页「开始索引」）。
- **重建索引**：`POST /index/rebuild`（清空 `issue_documents` 并触发全量重扫）。
- **查看索引健康**：`GET /index/status`（最近轮次 summary + 挂起触发）。
- **只读 RAG 召回**：`GET /index/related?title=...&body=...`；可加 `repositoryFullName=owner/name`
  把召回限制在同一仓库内，避免跨项目“相关”Issue（worker 分析默认已按仓库过滤）。
- **同步 GitHub App 安装仓库**：`POST /repositories/sync`（管理员；单安装失败自动重试一次，
  返回 `details` 失败明细，WebUI「已安装仓库」页也会每 12 小时自动拉取）。

> **重要：只有安装/授权了 GitHub App 的仓库才会被分析。** GitHub 只向已安装该 App 的仓库推送
> webhook，未安装/未授权的仓库提交 issue/PR 不会触发 AperturePrism 分析、也不会出现在「已安装仓库」
> 列表里（排查 #38 时确认：`repositories` 表仅含已授权安装的仓库）。
>
> 安装步骤（WebUI「GitHub 接入」页）：
> 1. 点击「安装 GitHub Apps ↗」按钮，跳转到 GitHub 的 App 安装页；
> 2. 选择要授权的仓库或「全部仓库」，确认安装（安装目标仓库需其管理员授权）；
> 3. 回到系统的「安装/授权仓库」面板，点击「安装 GitHub Apps 并选择仓库 ↗」可进一步筛选授权仓库；
> 4. 触发一次仓库同步（「已安装仓库」页的「同步仓库」），新仓库即纳入分析范围。
>
> 常见排查：某个仓库提交 issue 后 bot 无「正在分析」评论 → 先确认该仓库是否已在此系统被安装授权
> （在「已安装仓库」页可见）；若不在，则需先安装 App 到该仓库。这与分析阶段失败（如模型 401 /
> handler_error）是两类不同问题。
- **一键撤回已发布分析**：`POST /repos/revoke`（管理员；body `{"repositoryFullName","number","type"}`，
  删除评论 / 撤销 PR Review / 移除建议标签，best-effort）。WebUI 结果页提供单条与批量撤回。
- **批量重跑失败/取消任务**：`POST /tasks/rerun`（管理员；body `{"taskIds":[...]}`，把
  `failed`/`canceled` 任务重置回 `queued` 并清零尝试数，可立即被 worker 领取）。
- **仓库扫描**：`GET /scans/config`（全局开关 + 逐仓库配置）、`PUT /scans/config`（管理员修改）、
  `POST /scans/run`（管理员手动触发一轮）、`GET /scans/runs`（扫描历史）。
- **在线更新**：`GET /update/status`（版本对比）、`POST /update/apply`（管理员，SSE 阶段日志 +
  自动回滚）、`GET /update/history`（历史）。WebUI 更新完成后会倒计时自动刷新页面。
- **运行时配置热更新**：`PUT /settings`（`webui_api_token` / `github_webhook_secret` /
  `github_webhook_enabled` / `log_level` / `pr_check_run` / `pr_auto_review`，约 8s 生效）。

### 5.1 Docker 部署 override（NAS 等受限环境）

生产环境默认用 `docker/docker-compose.prod.yml`。以下两个 override 文件按需叠加：

- **`docker/images-mirror.yml`（镜像站）**：当 NAS 无法直连 `ghcr.io`（Docker Go TLS 握手超时）时，
  用国内镜像站重写各服务镜像，如 `ghcr.nju.edu.cn/apertureprism/apertureprism-ai-review/*`。新增容器服务时
  需同步在该文件补对应镜像重写条目，否则 pull 会直连 ghcr 失败。
- **`docker/compose.verify.yml`（external 网络）**：当 Docker 地址池耗尽（bridge 网络创建失败）时，
  将全部服务挂到 external 网络 `apnet`（`apertureprism-verify`），并设 `AP_VERIFY=1` 让在线更新器
  使用同一组文件。

组合命令示例（NAS 生产）：

```bash
docker compose \
  --env-file .env.production \
  -f docker/docker-compose.prod.yml \
  -f docker/compose.verify.yml \
  -f docker/images-mirror.yml \
  pull
docker compose --env-file .env.production -f docker/docker-compose.prod.yml \
  -f docker/compose.verify.yml -f docker/images-mirror.yml \
  run --rm migrate
docker compose --env-file .env.production -f docker/docker-compose.prod.yml \
  -f docker/compose.verify.yml -f docker/images-mirror.yml \
  up -d
```

> 注意：NAS 上 compose 文件位于 `/root/ap-verify/docker/`，env 为 `/root/ap-verify/.env.production`；
> 升级前显式 `docker compose pull` 确保拉取最新镜像（避免复用旧 tag 缓存）。

## 6. 告警清单

| 信号 | 建议动作 |
| --- | --- |
| `/health/ready` 非 200 | 检查 DB/Redis 容器健康与连接串 |
| index-worker 日志出现 `repo index failed` | 检查 GitHub installation token / 限流 |
| 任务持续 `retry_wait` 不恢复 | 确认 scheduler 存活（lease/retry 由它释放） |
| webhook 401 | 校验 `GITHUB_WEBHOOK_SECRET` 与签名 |
| worker `authentication_failed` | 校验 `CREDENTIAL_MASTER_KEY` 与 `provider_accounts` 密文 |
| SSE 无心跳 | 确认 redis 可达、`/events` 客户端仍在 |

## 7. 故障恢复

- **Worker 崩溃**：lease 在 `lease_duration_ms`（默认 60s）后过期，由 scheduler 回收回 `queued`，无需人工介入。
- **Redis 故障**：API 的 SSE 中继降级为只心跳，任务数据不丢失（PostgreSQL 为准）；恢复后自动重连。
- **GitHub 限流**：`github-adapter` 已对 `authentication_failed` 做一次性重试；429/5xx 由 worker 重试策略处理。
- **索引过旧**：分析评论中的相关 Issue 段落会因索引不可用自动跳过，主流程不阻塞。

## 8. 安全要点

- `CREDENTIAL_MASTER_KEY`、`GITHUB_APP_PRIVATE_KEY`、`EMBEDDING_API_KEY`、OAuth 凭据只放 `.env.production`，绝不入库/入日志。
- `provider_accounts.encrypted_credential` 为 AES-GCM 密文；轮换 = 更新该表 + 重启 worker。
- 私有仓库内容隔离在 `issue_documents.repository_id` 权限域内；`/index/related` 等只读接口需 WebUI token。
