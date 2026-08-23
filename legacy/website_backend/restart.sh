#!/bin/sh

# =================================================================
# Website Backend - 统一部署脚本
# 纯 POSIX 写法：sh / bash / ./ 三种方式执行，行为完全一致
# 用法: sh restart.sh [install|build|start|stop|restart|status|logs]
# 默认: restart (安装依赖 + 构建 + 启动服务)
# =================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="silievo-website-backend"
PORT="${PORT:-13001}"
NEED_BUILD="true"

# 颜色（用 printf 而非 echo -e，兼容 dash/POSIX）
log() { printf '\033[1;34m[%s]\033[0m %s\n' "$(date '+%H:%M:%S')" "$1"; }
success() { printf '\033[1;32m[%s]\033[0m %s\n' "$(date '+%H:%M:%S')" "$1"; }
warn() { printf '\033[1;33m[%s]\033[0m %s\n' "$(date '+%H:%M:%S')" "$1"; }
error() { printf '\033[1;31m[%s]\033[0m %s\n' "$(date '+%H:%M:%S')" "$1"; }

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
    if [ "$NEED_BUILD" = "true" ]; then
        log "构建项目..."
        cd "$SCRIPT_DIR"
        npm run build
        success "构建完成"
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

    # 加载环境变量：优先生产配置 .env.production（NODE_ENV=production），仅当不存在时才退回 .env
    # 注意：不能写成「先 .env.production 再 .env 覆盖」，否则 .env 存在时会用旧的开发配置把生产配置顶掉
    ENV_FILE="$SCRIPT_DIR/.env.production"
    [ -f "$SCRIPT_DIR/.env.production" ] || ENV_FILE="$SCRIPT_DIR/.env"

    if [ -n "$ENV_FILE" ]; then
        log "加载环境: $(basename $ENV_FILE)"
        # 安全加载环境变量：移除 BOM(EF BB BF) 与行尾 CR，过滤注释和空行，只处理 KEY=VALUE
        while IFS= read -r line; do
            # 去除 BOM 与 Windows 换行符（GNU sed 支持 \x 转义，Debian/Ubuntu 可用）
            line=$(printf '%s\n' "$line" | sed 's/^\xef\xbb\xbf//; s/\r$//')
            # 跳过注释和空行
            case "$line" in
                \#*) continue ;;
                '') continue ;;
            esac
            # 只处理 KEY=VALUE 格式
            case "$line" in
                [a-zA-Z_][a-zA-Z0-9_]*=*)
                    KEY="${line%%=*}"
                    VAL="${line#*=}"
                    # 剥离值两侧的成对引号（单/双）：export 不会做引号移除，
                    # 若直接 export "$line"，带引号的值会残留字面引号导致连接串解析失败（如 "localhost"）
                    case "$VAL" in
                        \"*\") VAL="${VAL#\"}"; VAL="${VAL%\"}" ;;
                        \'*\') VAL="${VAL#\'}"; VAL="${VAL%\'}" ;;
                    esac
                    export "$KEY=$VAL" 2>/dev/null || true
                    ;;
            esac
        done < "$ENV_FILE"
    fi

    export NODE_ENV=production

    # 确定入口文件 (TypeScript 构建后)
    ENTRY="dist/index.js"
    if [ ! -f "$SCRIPT_DIR/$ENTRY" ]; then
        error "未找到构建产物: $ENTRY，请先执行 build"
        exit 1
    fi

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
