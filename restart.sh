#!/usr/bin/env bash
# ============================================================
# 重建并重启 pinche-backend 容器
#
# 用法：
#   ./restart.sh          # 用最新代码重建镜像 → 重建容器 → 等健康检查通过
#
# 做三件事：
#   1. 校验 .env.docker 存在（真实配置，缺失直接拒绝）
#   2. docker compose up -d --build（重建镜像 + 重建容器）
#   3. 轮询容器健康状态直到 healthy（最多 90s）
#
# 前置：Docker 已启动；server/ 下已有 .env.docker（cp .env.docker.example 填真实值）
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

CONTAINER="pinche-backend"
COMPOSE_FILE="docker-compose.yml"
TIMEOUT_SEC=90
POLL_INTERVAL=3

# ---- 1. 校验配置文件 ----
if [ ! -f ".env.docker" ]; then
  echo "❌ 缺少 .env.docker（生产真实配置）。"
  echo "   请先执行：cp .env.docker.example .env.docker 并填入真实密钥。"
  exit 1
fi

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "❌ 找不到 $COMPOSE_FILE，请在 server/ 目录下执行本脚本。"
  exit 1
fi

# ---- 2. 重建镜像并重启容器 ----
echo "==> 校验 compose 配置..."
docker compose config --quiet
echo "    ✓ 配置合法"

echo "==> 重建镜像并重启容器..."
docker compose up -d --build

# ---- 3. 等待健康检查通过 ----
echo "==> 等待容器健康（最多 ${TIMEOUT_SEC}s）..."
elapsed=0
while [ "$elapsed" -lt "$TIMEOUT_SEC" ]; do
  status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$CONTAINER" 2>/dev/null || echo "starting")
  case "$status" in
    healthy)
      echo "    ✓ 容器 healthy（耗时 ${elapsed}s）"
      ;;
    starting)
      echo "    ... $status（${elapsed}s）"
      ;;
    *)
      # unhealthy / no-healthcheck / 其他：直接失败，让用户看日志
      echo "    ✗ 容器状态异常：$status"
      echo "    —— 最近日志 ——"
      docker logs --tail 50 "$CONTAINER" || true
      exit 1
      ;;
  esac

  [ "$status" = "healthy" ] && break
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
echo "   容器状态：docker compose ps"
echo "   实时日志：docker compose logs -f backend"
