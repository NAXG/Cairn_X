# Cairn_X 控制端镜像。
#
# server target 不含 Docker CLI；dispatcher target 才含 Docker CLI，并配合
# Docker Socket 管理 Worker 容器。构建上下文必须是仓库根目录：
#   docker build -f cairn-x/Dockerfile --target server -t cairn-x-server .
#   docker build -f cairn-x/Dockerfile --target dispatcher -t cairn-x-dispatcher .

FROM node:24-alpine AS web-build
WORKDIR /app
COPY cairn-x/package.json cairn-x/package-lock.json ./
RUN npm ci --ignore-scripts
COPY cairn-x/src/web ./src/web
COPY cairn-x/src/contracts ./src/contracts
COPY cairn-x/src/shared ./src/shared
COPY cairn-x/vite.config.ts cairn-x/tsconfig.web.json ./
RUN npm run build:web

FROM node:24-alpine AS runtime-base
WORKDIR /app

# better-sqlite3 在 musl 下使用包内预编译产物；跳过安装脚本，避免引入编译工具链。
COPY cairn-x/package.json cairn-x/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
	&& npm cache clean --force

COPY cairn-x/src ./src
COPY cairn-x/tsconfig.json ./
COPY --from=web-build /app/dist-web ./dist-web
COPY cairn-x/src/web/THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md

EXPOSE 8000

FROM runtime-base AS server

CMD ["node_modules/.bin/tsx", "src/cli.ts", "serve", "--host", "0.0.0.0", "--db-path", "/data/cairn.db"]

FROM runtime-base AS dispatcher

# 只有 Dispatcher 需要 Docker CLI；Server 直接使用 /data/uploads 文件目录。
RUN sed -i 's#dl-cdn.alpinelinux.org#mirrors.cloud.tencent.com#g' /etc/apk/repositories \
	&& apk add --no-cache docker-cli git openssh-client

CMD ["node_modules/.bin/tsx", "src/cli.ts", "dispatch", "--config", "/app/dispatch.yaml", "--data-root", "/data"]
