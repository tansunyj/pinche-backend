#!/bin/sh
# ============================================================
# 重建并重启 pinche-backend 容器
#
# 用法：
#   sh restart.sh          # 用最新代码重建镜像 → 重建容器 → 等健康检查通过
#
# 做三件事：
#   1. 自动探测 compose 命令（docker compose v2 / docker-compose v1）
#   2. 校验 .env.docker 存在 + compose 配置合法
#   3. docker compose up -d --build（重建镜像 + 重建容器）并等健康检查通过
#
# 前置：Docker 已启动；server/ 下已有 .env.docker（cp .env.docker.example 填真实值）
#
# 兼容性：POSIX sh（dash/bash/sh 均可执行），避免 bash 专属语法（pipefail 等）。
# ============================================================
set -eu
cd "$(dirname "$0")"

CONTAINER="pinche-backend"
COMPOSE_FILE="docker-compose.yml"
TIMEOUT_SEC=90
POLL_INTERVAL=3

# ---- 1. 探测 compose 命令 ----
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif docker-compose --version >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "❌ 未找到 docker compose（v2）或 docker-compose（v1）。"
  echo "   请先安装："
  echo "     apt-get install docker-compose-plugin   # Docker v2 插件"
  echo "     或 apt-get install docker-compose        # 独立 v1 二进制"
  exit 1
fi
echo "==> 使用 compose 命令：$COMPOSE"

# ---- 2. 校验配置文件 ----
if [ ! -f ".env.docker" ]; then
  echo "❌ 缺少 .env.docker（生产真实配置）。"
  echo "   请先执行：cp .env.docker.example .env.docker 并填入真实密钥。"
  exit 1
fi

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "❌ 找不到 $COMPOSE_FILE，请在 server/ 目录下执行本脚本。"
  exit 1
fi

echo "==> 校验 compose 配置..."
$COMPOSE config -q
echo "    ✓ 配置合法"

# ---- 3. 重建镜像并重启容器 ----
echo "==> 重建镜像并重启容器..."
$COMPOSE up -d --build

# ---- 4. 等待健康检查通过 ----
echo "==> 等待容器健康（最多 ${TIMEOUT_SEC}s）..."
elapsed=0
status="starting"

while [ "$elapsed" -lt "$TIMEOUT_SEC" ]; do
  status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$CONTAINER" 2>/dev/null || echo "starting")
  if [ "$status" = "healthy" ]; then
    echo "    ✓ 容器 healthy（耗时 ${elapsed}s）"
    break
  elif [ "$status" = "starting" ]; then
    echo "    ... starting（${elapsed}s）"
  else
    # unhealthy / no-healthcheck / 其他异常：直接失败并打印日志
    echo "    ✗ 容器状态异常：$status"
    echo "    —— 最近日志 ——"
    docker logs --tail 50 "$CONTAINER" 2>/dev/null || true
    exit 1
  fi
  sleep "$POLL_INTERVAL"
  elapsed=$((elapsed + POLL_INTERVAL))
done

# 超时未 healthy → 失败
if [ "$status" != "healthy" ]; then
  echo "❌ 等待 ${TIMEOUT_SEC}s 后容器仍未 healthy（当前：$status）。"
  echo "   查看日志：docker logs -f $CONTAINER"
  exit 1
fi

echo ""
echo "✅ 部署完成。"
echo "   健康检查：curl http://localhost:14001/api/health"
echo "   容器状态：$COMPOSE ps"
echo "   实时日志：$COMPOSE logs -f backend"
