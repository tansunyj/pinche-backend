#!/bin/sh
# ============================================================
#  Silievo Website Backend - 服务器本地构建（不推任何镜像仓库）
#  用法: ./docker-build.sh [TAG]    默认 TAG=local
#        local 与 docker-compose.yml 的 image 保持一致，
#        构建后直接 docker compose up -d 即可复用，不会重复构建。
#  回滚: git checkout <旧commit> && ./docker-build.sh && docker compose up -d
# ============================================================
set -e

# ---- 可配置项 ----
TAG="${1:-local}"
IMAGE="silievo-website-backend:${TAG}"

echo "[1/2] 构建镜像: ${IMAGE}"
docker build -t "${IMAGE}" -f Dockerfile .

echo "[2/2] 构建完成！"
echo "  移除:   docker-compose down"
echo "  启动:   docker-compose up -d"
echo "  重建:   docker-compose up -d --build（不经 docker-build.sh 的一步重建）"
