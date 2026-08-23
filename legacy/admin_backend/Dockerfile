# Silievo Admin Backend - 生产镜像（纯 JS，无需编译）
# 构建: 在仓库根目录 docker compose up -d --build（详见 DEPLOY.md）

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# 国内服务器构建提速：默认走 npmmirror，可用 --build-arg NPM_REGISTRY=... 覆盖
ARG NPM_REGISTRY=https://registry.npmmirror.com

# 复制依赖清单并安装生产依赖
COPY package.json package-lock.json* ./
RUN npm config set registry ${NPM_REGISTRY} && (npm ci --omit=dev || npm install --omit=dev)

# 复制源码（含 cron/ 目录，部署包完整性由 git 保证，不再依赖 deploy.js 的 dist）
COPY index.js ./
COPY routes ./routes
COPY middleware ./middleware
COPY services ./services
COPY repositories ./repositories
COPY db ./db
COPY utils ./utils
COPY cron ./cron
COPY schema ./schema
# 注意：不复制 data/（MySQL 迁移前的遗留 SQLite + 备份，含真实业务数据，运行时代码零引用）。
# 若确实需要空目录，用 RUN mkdir -p data 而不是 COPY。

# 注意：不复制 .env*（由 docker-compose 的环境变量注入，避免密钥进镜像）
# 不复制 node_modules 本地目录（以容器内 npm ci 结果为准）

EXPOSE 3001
CMD ["node", "index.js"]
