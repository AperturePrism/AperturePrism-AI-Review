# AperturePrism production images. The workspace compiles each app with its
# package sources inlined under <app>/dist (relative deep imports), so the
# runtime images only need root node_modules plus the app's dist tree.
# (No `# syntax=` line: Docker >= 23 ships the dockerfile:1 frontend built-in,
# avoiding a network fetch of docker/dockerfile:1 on every build — important
# behind flaky registry mirrors.)
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/analysis-worker ./apps/analysis-worker
COPY apps/index-worker ./apps/index-worker
COPY apps/scheduler ./apps/scheduler
COPY apps/qq-bot ./apps/qq-bot
COPY apps/scan-worker ./apps/scan-worker
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json tsconfig.package.json eslint.config.mjs ./
RUN npm run build

FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
# 工作台的跨进程文件锁由内核持有，容器退出时自动释放。
RUN apk add --no-cache util-linux
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json

FROM base AS api
COPY --from=build /app/apps/api/dist ./apps/api/dist
# docker CLI + compose plugin so the api can drive online updates (docker.sock is mounted by compose).
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
# curl 供 update.sh 做健康检查与 nginx 层探测（alpine 默认不含）。
RUN apk add --no-cache curl
COPY scripts ./scripts
RUN chmod +x scripts/update.sh scripts/botctl.sh
COPY docker/docker-compose.prod.yml ./docker/docker-compose.prod.yml
COPY docker/compose.verify.yml ./docker/compose.verify.yml
COPY docker/docker-compose.dev.yml ./docker/docker-compose.dev.yml
EXPOSE 30001
CMD ["node", "apps/api/dist/apps/api/src/main.js"]

FROM base AS analysis-worker
COPY --from=build /app/apps/analysis-worker/dist ./apps/analysis-worker/dist
CMD ["node", "apps/analysis-worker/dist/apps/analysis-worker/src/main.js"]

FROM base AS index-worker
COPY --from=build /app/apps/index-worker/dist ./apps/index-worker/dist
CMD ["node", "apps/index-worker/dist/apps/index-worker/src/main.js"]

FROM base AS scheduler
COPY --from=build /app/apps/scheduler/dist ./apps/scheduler/dist
CMD ["node", "apps/scheduler/dist/apps/scheduler/src/main.js"]

FROM base AS scan-worker
COPY --from=build /app/apps/scan-worker/dist ./apps/scan-worker/dist
CMD ["node", "apps/scan-worker/dist/apps/scan-worker/src/main.js"]

FROM base AS qq-bot
COPY --from=build /app/apps/qq-bot/dist ./apps/qq-bot/dist
CMD ["node", "apps/qq-bot/dist/apps/qq-bot/src/main.js"]

# One-shot database migration. drizzle-kit + the migrations tree are carried
# here so a fresh deployment can apply schema before app containers start.
FROM base AS migrate
COPY scripts ./scripts
COPY packages/database/drizzle.config.ts ./packages/database/drizzle.config.ts
COPY packages/database/migrations ./packages/database/migrations
CMD ["node", "scripts/migrate.mjs"]

# --- web: Vite SPA built independently (apps/web is not a root workspace) ---
FROM node:22-alpine AS web-build
WORKDIR /app/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --no-audit --no-fund
# 保留工作区相对路径，网页只引用共享数据契约，生产包不引入 Node 主体。
COPY packages /app/packages
COPY apps/web ./
RUN npm run build

FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
