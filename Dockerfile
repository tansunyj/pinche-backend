# ============================================================
# pinche-backend 生产镜像（多阶段构建）
#   builder：npm ci + tsc 编译出 dist/
#   runner ：只装生产依赖，非 root 用户运行 node dist/index.js
# 依赖均纯 JS（bcryptjs/mysql2/ioredis），无需 build 工具链，node:20-slim 足够。
# ============================================================
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim AS runner
ENV NODE_ENV=production
WORKDIR /app
# 只装生产依赖，保证镜像最小
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# 仅拷贝编译产物；业务源码与密钥文件均不进 runner 层
COPY --from=build /app/dist ./dist
RUN chown -R node:node /app
USER node

EXPOSE 14001

# 轻量健康检查：node 内建 fetch（Node 18+），无需 curl/wget
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:14001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
