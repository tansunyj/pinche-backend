#!/bin/bash

# =================================================================
# Silievo Admin Backend - 统一部署脚本
# 用法: sh restart.sh [install|build|start|stop|restart|status|logs]
# 默认: restart (安装依赖 + 启动服务)
# =================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="silievo-admin-backend"
PORT="${PORT:-3001}"
NEED_BUILD="false"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLUE}[$(date '+%H:%M:%S')]${NC} $1"; }
success() { echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} $1"; }
warn() { echo -e "${YELLOW}[$(date '+%H:%M:%S')]${NC} $1"; }
error() { echo -e "${RED}[$(date '+%H:%M:%S')]${NC} $1"; }

# 安装依赖
cmd_install() {
    log "安装依赖..."
    if [ ! -f "$SCRIPT_DIR/package.json" ]; then
        error "未找到 package.json"
        exit 1
    fi
    cd "$SCRIPT_DIR" && npm install
    success "依赖安装完成"
}

# 构建项目
cmd_build() {
    if [ "$NEED_BUILD" = "true" ] && [ -f "$SCRIPT_DIR/package.json" ]; then
        log "构建项目..."
        cd "$SCRIPT_DIR"
        if npm run-script --silent build 2>/dev/null; then
            success "构建完成"
        else
            warn "无需构建或构建脚本不存在"
        fi
    fi
}

# 停止服务
cmd_stop() {
    log "停止服务..."
    if pm2 describe "$SERVICE_NAME" >/dev/null 2>&1; then
        pm2 stop "$SERVICE_NAME" && pm2 delete "$SERVICE_NAME"
        success "PM2 服务已停止"
    fi

    PID=$(lsof -t -i:$PORT 2>/dev/null || true)
    if [ -n "$PID" ]; then
        kill -9 $PID 2>/dev/null || true
        success "已清理端口 $PORT"
    fi
}

# 启动服务
cmd_start() {
    log "启动服务..."
    cd "$SCRIPT_DIR"

    # 加载环境变量
    ENV_FILE=""
    [ -f "$SCRIPT_DIR/.env.production" ] && ENV_FILE="$SCRIPT_DIR/.env.production"
    [ -f "$SCRIPT_DIR/.env" ] && ENV_FILE="$SCRIPT_DIR/.env"

    if [ -n "$ENV_FILE" ]; then
        log "加载环境: $(basename $ENV_FILE)"
        # 安全加载环境变量：过滤注释和空行
        while IFS= read -r line || [ -n "$line" ]; do
            # 跳过注释和空行
            case "$line" in
                \#*) continue ;;
            esac
            [ -z "$line" ] && continue
            # 移除 Windows 换行符
            line="${line%$'\r'}"
            # 只处理 KEY=VALUE 格式
            case "$line" in
                [a-zA-Z_]*=*)
                    key="${line%%=*}"
                    val="${line#*=}"
                    # 去掉值两边的双引号
                    case "$val" in
                        \"*) val="${val#\"}"; val="${val%\"}" ;;
                    esac
                    # 去掉值两边的单引号
                    case "$val" in
                        \'*) val="${val#\'}"; val="${val%\'}" ;;
                    esac
                    export "$key=$val"
                    ;;
            esac
        done < "$ENV_FILE"
    fi

    export NODE_ENV=production

    # 确定入口文件
    ENTRY="index.js"
    [ -f "$SCRIPT_DIR/dist/index.js" ] && ENTRY="dist/index.js"

    pm2 start "$ENTRY" \
        --name "$SERVICE_NAME" \
        --cwd "$SCRIPT_DIR" \
        --log-date-format "YYYY-MM-DD HH:mm:ss" \
        --restart-delay 3000 \
        --max-restarts 5

    success "服务已启动 (端口: $PORT)"
}

# 查看状态
cmd_status() {
    pm2 status "$SERVICE_NAME" 2>/dev/null || pm2 status
}

# 查看日志
cmd_logs() {
    pm2 logs "$SERVICE_NAME" --lines 100
}

# 完整部署
cmd_deploy() {
    cmd_install
    cmd_build
    cmd_stop
    cmd_start
    pm2 save
    echo ""
    success "部署完成!"
    cmd_status
}

# 主流程
COMMAND="${1:-restart}"

case "$COMMAND" in
    install)
        cmd_install
        ;;
    build)
        cmd_build
        ;;
    start)
        cmd_start
        ;;
    stop)
        cmd_stop
        ;;
    restart|deploy)
        cmd_deploy
        ;;
    status)
        cmd_status
        ;;
    logs)
        cmd_logs
        ;;
    *)
        echo "用法: sh restart.sh [命令]"
        echo ""
        echo "命令:"
        echo "  install    安装依赖"
        echo "  build      构建项目 (如需)"
        echo "  start      启动服务"
        echo "  stop       停止服务"
        echo "  restart    完整部署 (默认)"
        echo "  status     查看状态"
        echo "  logs       查看日志"
        echo ""
        exit 1
        ;;
esac
