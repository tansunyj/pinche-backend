#!/bin/sh
# ============================================================
# 构建 pinche-backend Docker 镜像
#
# 用法：
#   sh build.sh             # 常规构建（用层缓存，最快）
#   sh build.sh --no-cache  # 全量重建（不依赖缓存，最干净）
#
# 产物：pinche-backend:latest（与 docker-compose.yml 的 image 同名）
# 前置：Docker 已启动；无需 .env.docker（构建不依赖运行配置）
#
# 兼容性：POSIX sh（dash/bash/sh 均可执行），避免 bash 专属语法。
# ============================================================
set -eu
cd "$(dirname "$0")"

IMAGE="pinche-backend:latest"
ARGS=""

if [ "${1:-}" = "--no-cache" ]; then
  ARGS="--no-cache"
  echo "==> 全量重建（--no-cache）..."
else
  echo "==> 构建镜像 $IMAGE（使用缓存）..."
fi

# 注意：$ARGS 故意不加引号，让 --no-cache 作为独立参数传给 docker build
docker build $ARGS -t "$IMAGE" .

echo ""
echo "✅ 构建完成：$IMAGE"
echo "   查看镜像：docker images pinche-backend"
echo "   部署运行：sh restart.sh"
