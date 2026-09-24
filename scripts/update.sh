#!/bin/sh
# AperturePrism in-container online update.
# Runs inside the api container (which has docker CLI + compose + docker.sock).
# Steps: pull -> migrate -> up --force-recreate -> health poll -> rollback on fail.
# Outputs one JSON line per step: {"level":"info|warn|error","message":"..."}
set -u

TARGET="latest"
PROJECT="apertureprism-ai-review"
API_URL="http://127.0.0.1:30001"
BACKUP=0
DRY_RUN=0
BASE_DIR="/app/docker"
COMPOSE_FILE="$BASE_DIR/docker-compose.prod.yml"
ENV_FILE="$BASE_DIR/.env.production"

log() { echo "{\"level\":\"$1\",\"message\":\"$2\"}"; }
stage() { echo "{\"level\":\"stage\",\"stage\":\"$1\",\"message\":\"$2\"}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --api) API_URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --backup) BACKUP=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) shift ;;
  esac
done

case "$TARGET" in
  v[0-9]*.[0-9]*.[0-9]*|latest|stable) ;;
  *) log error "invalid target: $TARGET"; exit 1 ;;
esac

OLD_TAG="${IMAGE_TAG:-latest}"
log info "update target=$TARGET current=$OLD_TAG project=$PROJECT"

# Rebuild the compose env file from the container environment so the script
# (and any nested `env_file:` in compose) has every production variable.
# 注意：前缀类变量（POSTGRES_/GITHUB_/EMBEDDING_/QQ_）不能带尾随 `=`，
# 否则 `GITHUB_APP_ID=` 这类变量永远匹配不上，重建出的容器会丢失凭据。
# AP_VERIFY 必须保留：丢了它，下次在线更新就不叠加 compose.verify.yml，
# 服务会建到默认网络，web 解析不到 api 导致 502（NAS 实测网络分裂事故）。
# OAUTH_REDIRECT_URI 同样必须保留，否则 OAuth 登录回调会失效。
env | grep -E '^(DATABASE_URL|REDIS_URL|WEBUI_API_TOKEN|MODEL_PROVIDER_BASE_URLS|DEFAULT_LLM_MODEL|CREDENTIAL_MASTER_KEY|INDEX_INTERVAL_MS|API_PORT|WEB_PORT|HOST|PORT|LOG_LEVEL|NODE_ENV|AP_VERIFY|OAUTH_REDIRECT_URI)=|^(POSTGRES_|GITHUB_|EMBEDDING_|QQ_)' > "$ENV_FILE" || true
echo "IMAGE_TAG=$TARGET" >> "$ENV_FILE"

# Compose runs from the api container's cwd (/app), so reference the compose
# files by absolute path under BASE_DIR to avoid "no such file or directory".
COMPOSE_FILES="-f $BASE_DIR/docker-compose.prod.yml"
if [ "${AP_VERIFY:-0}" = "1" ] && [ -f "$BASE_DIR/compose.verify.yml" ]; then
  COMPOSE_FILES="-f $BASE_DIR/docker-compose.prod.yml -f $BASE_DIR/compose.verify.yml"
fi

# Preflight: fail loudly with an actionable hint instead of a cryptic
# "open ...: no such file or directory" from docker compose. Images before
# v1.0.7 baked the update.sh with relative paths and cannot self-update; they
# must be upgraded once manually (see README「升级」).
if [ ! -f "$BASE_DIR/docker-compose.prod.yml" ]; then
  log error "缺少 compose 文件 $BASE_DIR/docker-compose.prod.yml"
  log error "当前镜像版本过旧（< v1.0.7）无法在线自更新，请手动升级一次："
  log error "  编辑部署目录 docker/.env.production 中 IMAGE_TAG=vX.Y.Z 后执行："
  log error "  docker compose -f docker/docker-compose.prod.yml --env-file docker/.env.production pull"
  log error "  docker compose -f docker/docker-compose.prod.yml --env-file docker/.env.production up -d"
  exit 1
fi
compose() { docker compose --project-name "$PROJECT" $COMPOSE_FILES --env-file "$ENV_FILE" "$@"; }

# 只更新应用自身镜像（ghcr.io）：postgres/redis 来自 docker.io，NAS 上
# registry-1.docker.io 常 TLS 超时，且它们版本固定无需每次拉取。
APP_SERVICES="web api analysis-worker index-worker scheduler scan-worker migrate"
PROFILE_ARG=""
if docker ps --format '{{.Names}}' | grep -q '^apertureprism-ai-review-qq-bot-1$'; then
  PROFILE_ARG="--profile qq"
  APP_SERVICES="$APP_SERVICES qq-bot"
fi

if [ "$DRY_RUN" = "1" ]; then
  log info "dry-run: would pull $TARGET, run migrate, then up -d --force-recreate"
  exit 0
fi

if [ "$BACKUP" = "1" ] && [ -f /app/scripts/backup.mjs ]; then
  stage backup "备份配置"
  log info "backing up configuration…"
  if node /app/scripts/backup.mjs >/dev/null 2>&1; then
    log info "backup ok"
  else
    log warn "backup failed (continuing)"
  fi
fi

stage pull "拉取镜像"
# 每轮更新拉新 latest 后旧镜像会失去引用但不会自动删除，累积多轮后可能占满磁盘
# （实测有环境累积 76 个镜像、24GB 可回收，导致 containerd 写入 ingest 失败）。
# 拉取前先按可用空间决定是否提前回收，避免拉到一半因 no space 失败。
AVAIL_MB=$(df -Pm /var/lib/docker 2>/dev/null | awk 'NR==2 {print $4}')
if [ -n "$AVAIL_MB" ]; then
  log info "disk available: ${AVAIL_MB}MB"
  if [ "$AVAIL_MB" -lt 8192 ]; then
    log warn "low disk space, reclaiming dangling images before pull"
    # 只删无标签的悬空镜像，不动当前在用或已打标签的镜像。
    docker image prune -f >/dev/null 2>&1 || true
    AVAIL_MB=$(df -Pm /var/lib/docker 2>/dev/null | awk 'NR==2 {print $4}')
    log info "disk available after prune: ${AVAIL_MB}MB"
  fi
fi

log info "pulling $TARGET…"
if ! compose $PROFILE_ARG pull $APP_SERVICES 2>&1; then
  log error "pull failed"
  exit 1
fi
log info "pull ok"

stage migrate "执行数据库迁移"
log info "applying migrations…"
# -T 强制非交互：api 容器内由 Node spawn 执行时 stdin 非 TTY，缺 -T 时
# compose run 可能在创建 migrate 容器后挂起（无法分配 TTY）。
if ! compose run --rm -T migrate 2>&1; then
  log error "migrate failed"
  exit 1
fi
log info "migrate ok"

stage up "重建并启动容器"
log info "recreating service containers…"
# Recreate every service EXCEPT api: recreating the api container from inside
# the api container would kill this updater mid-run (see the api stage below).
# --no-deps 防止 web 的 depends_on 把 api 也带进来重建（会杀掉本脚本）。
# migrate 是已执行的一次性服务，不进 up 列表。
SERVICES=""
for svc in $APP_SERVICES; do
  case "$svc" in
    api|migrate) ;;
    *) SERVICES="$SERVICES $svc" ;;
  esac
done
if ! compose $PROFILE_ARG up -d --force-recreate --no-deps $SERVICES 2>&1; then
  log error "up failed"
  exit 1
fi
log info "up ok"

stage health "等待服务健康检查"
attempt=0
while [ "$attempt" -lt 12 ]; do
  attempt=$((attempt + 1))
  code=$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/health/ready" 2>/dev/null)
  if [ "$code" = "200" ]; then
    log info "health ok (attempt $attempt)"
    break
  fi
  log info "health pending ($code, attempt $attempt/12)"
  sleep 5
done

if [ "$attempt" -ge 12 ]; then
  log error "health check failed; rolling back to $OLD_TAG"
  sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=$OLD_TAG/" "$ENV_FILE"
  if compose $PROFILE_ARG up -d --force-recreate --no-deps $SERVICES 2>&1; then
    log info "rolled back to $OLD_TAG"
  else
    log error "rollback failed; manual intervention required"
  fi
  exit 1
fi

# 容器重建后，nginx 解析到新 api 容器 IP 有一小段传播窗口；先经 nginx 层
# 做一次端到端探测并停留几秒，确保各服务已就绪，再安排 api 自身的重启。
log info "waiting for web layer (nginx -> api)…"
web_attempt=0
while [ "$web_attempt" -lt 8 ]; do
  web_attempt=$((web_attempt + 1))
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://web/health/live" 2>/dev/null)
  if [ "$code" = "200" ]; then
    log info "web layer ok (attempt $web_attempt)"
    break
  fi
  log info "web layer pending ($code, attempt $web_attempt/8)"
  sleep 2
done
sleep 2

# Recreate the api container LAST via a detached one-shot helper that runs
# outside the api container. Recreating api from inside itself kills this
# updater before the recreate finishes (the api dies mid-`compose up`, leaving
# the stack half-updated). The helper reuses the api image (has docker CLI +
# compose + the compose files + docker.sock) and survives the api restart; it
# waits a few seconds so the final "done" SSE event flushes to the WebUI first.
stage api "重启 API 容器"
log info "scheduling api restart…"
API_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$(hostname)" 2>/dev/null || echo "ghcr.io/apertureprism/apertureprism-ai-review/api:$TARGET")"
ENV_B64="$(base64 "$ENV_FILE" | tr -d '\n')"
if docker run -d --rm --name "aprism-api-recreate-$(date +%s)" \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  "$API_IMAGE" \
  /bin/sh -c "echo '$ENV_B64' | base64 -d > /app/docker/.env.production && sleep 3 && docker compose --project-name '$PROJECT' $COMPOSE_FILES --env-file /app/docker/.env.production up -d --no-deps api && sleep 5 && docker image prune -f" \
  >/dev/null 2>&1; then
  log info "api restart scheduled; the page will reload automatically"
else
  log warn "api restart scheduling failed; restart api manually: docker compose -f docker/docker-compose.prod.yml --env-file docker/.env.production up -d --force-recreate api"
fi

stage done "更新完成"
log info "更新完成；API 正在重启，请稍等几秒再刷新页面"
exit 0
