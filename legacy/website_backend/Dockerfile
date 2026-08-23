# Silievo Website Backend - 生产镜像（已移除 prisma 依赖，纯 mysql2）
# 构建: 在仓库根目录 docker compose up -d --build（详见 DEPLOY.md）

# ---------- 构建阶段：tsc 编译 ----------
FROM node:20-alpine AS builder
WORKDIR /app
# 国内服务器构建提速：默认走 npmmirror，可用 --build-arg NPM_REGISTRY=... 覆盖
ARG NPM_REGISTRY=https://registry.npmmirror.com
COPY package*.json ./
RUN npm config set registry ${NPM_REGISTRY} && npm ci
COPY tsconfig.json ./
COPY src ./src
COPY post-build.js ./
RUN npm run build

# ---------- 运行阶段 ----------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# 注意：ARG 不跨阶段，runner 阶段需重新声明
ARG NPM_REGISTRY=https://registry.npmmirror.com
COPY package*.json ./
RUN npm config set registry ${NPM_REGISTRY} && npm ci --omit=dev
COPY --from=builder /app/dist ./dist
# 注意：不把 .env.production 嵌入镜像——.dockerignore 已排除，运行时配置由
# compose 的 env_file: ./.env.production 提供（服务器单独放置、可随时更新）。
# 镜像内不得含密钥（见 docker-deploy/README 安全须知）。

EXPOSE 13001
CMD ["node", "dist/index.js"]
