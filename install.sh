#!/bin/bash
# Terminal Monitor 一键部署脚本
# 用法: bash install.sh [server|client]
# 示例:
#   bash install.sh server          # 部署服务端，自动在 screen 里启动
#   bash install.sh client          # 部署客户端，自动在 screen 里启动

set -e

MODE=${1:-""}
SCREEN_ARG=${2:-""}
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJ_DIR="$REPO_DIR"

# --- 检查 Node.js ---
check_node() {
    if ! command -v node &>/dev/null; then
        echo "[!] Node.js not found, installing..."
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
    fi
    echo "[OK] Node.js $(node -v)"
}

# --- 部署服务端 ---
deploy_server() {
    echo "=== 部署 Terminal Monitor Server ==="

    read -p "监听端口 [8080]: " PORT
    PORT=${PORT:-8080}

    read -p "浏览器登录密码 [admin]: " PASSWORD
    PASSWORD=${PASSWORD:-admin}

    # Token: 已有则复用，否则新生成
    if [ -f "$PROJ_DIR/config.json" ]; then
        EXISTING_TOKEN=$(grep -oP '"[a-f0-9]{32}"' "$PROJ_DIR/config.json" | head -1 | tr -d '"')
    fi
    if [ -n "$EXISTING_TOKEN" ]; then
        TOKEN="$EXISTING_TOKEN"
        echo ""
        echo "复用已有 Token: $TOKEN"
        echo ""
    else
        TOKEN=$(openssl rand -hex 16)
        echo ""
        echo "生成新 Token: $TOKEN"
        echo "请将此 token 分发给内网机器的 client 配置"
        echo ""
    fi

    read -p "本机公网IP或域名 [$(hostname -I | awk '{print $1}')]: " HOST
    HOST=${HOST:-$(hostname -I | awk '{print $1}')}

    # 写文件
    mkdir -p "$PROJ_DIR/public"
    if [ "$PROJ_DIR" != "$REPO_DIR" ]; then
        cp "$REPO_DIR/server.js" "$PROJ_DIR/"
        cp "$REPO_DIR/supervisor.js" "$PROJ_DIR/"
        cp "$REPO_DIR/client.js" "$PROJ_DIR/"
        cp "$REPO_DIR/public/index.html" "$PROJ_DIR/public/"
    fi

    cat > "$PROJ_DIR/config.json" << EOF
{
  "mode": "server",
  "server": {
    "port": $PORT,
    "password": "$PASSWORD",
    "tokens": {
      "$TOKEN": { "name": "default", "desc": "auto-generated" }
    },
    "supervisor": { "enabled": false, "summaryInterval": 300, "idleTimeout": 600, "webhook": "" }
  },
  "client": {
    "serverUrl": "ws://$HOST:$PORT",
    "token": "$TOKEN",
    "name": "change-me",
    "screen": "main",
    "attrs": {}
  }
}
EOF

    cd "$PROJ_DIR"
    npm install --production 2>&1 | tail -1

    # 在 screen 里启动
    local sn="swt-server"
    if screen -list | grep -q "\.$sn"; then
        echo "[!] screen session '$sn' 已存在，先关闭..."
        screen -S "$sn" -X quit
        sleep 1
    fi
    screen -dmS "$sn" bash -c "cd $PROJ_DIR && node server.js 2>&1 | tee -a $PROJ_DIR/server.log"

    echo ""
    echo "=== 部署完成 ==="
    echo "  访问地址: http://$HOST:$PORT"
    echo "  登录密码: $PASSWORD"
    echo "  Client Token: $TOKEN"
    echo "  配置文件: $PROJ_DIR/config.json"
    echo ""
    echo "  查看: screen -r $sn"
    echo "  停止: screen -S $sn -X quit"
}

# --- 部署客户端 ---
deploy_client() {
    # 尝试读取已有配置作为默认值
    local DEFAULT_URL="" DEFAULT_TOKEN="" DEFAULT_NAME="" DEFAULT_SCREEN=""
    # 先读全局 config.json，再读 session 专属配置覆盖
    for cfgfile in "$PROJ_DIR/config.json" "$PROJ_DIR/config.client.json"; do
        if [ -f "$cfgfile" ]; then
            [ -z "$DEFAULT_URL" ] && DEFAULT_URL=$(node -e "try{console.log(require('$cfgfile').client.serverUrl)}catch{}" 2>/dev/null)
            [ -z "$DEFAULT_TOKEN" ] && DEFAULT_TOKEN=$(node -e "try{console.log(require('$cfgfile').client.token)}catch{}" 2>/dev/null)
            [ -z "$DEFAULT_NAME" ] && DEFAULT_NAME=$(node -e "try{console.log(require('$cfgfile').client.name)}catch{}" 2>/dev/null)
            [ -z "$DEFAULT_SCREEN" ] && DEFAULT_SCREEN=$(node -e "try{console.log(require('$cfgfile').client.screen)}catch{}" 2>/dev/null)
        fi
    done

    echo "=== 部署 Terminal Monitor Client ==="

    read -p "服务器地址${DEFAULT_URL:+ [$DEFAULT_URL]}: " SERVER_URL
    SERVER_URL=${SERVER_URL:-$DEFAULT_URL}
    if [ -z "$SERVER_URL" ]; then
        echo "[!] 服务器地址不能为空"
        exit 1
    fi
    [[ "$SERVER_URL" != ws://* && "$SERVER_URL" != wss://* ]] && SERVER_URL="ws://$SERVER_URL"

    read -p "Token${DEFAULT_TOKEN:+ [$DEFAULT_TOKEN]}: " TOKEN
    TOKEN=${TOKEN:-$DEFAULT_TOKEN}
    if [ -z "$TOKEN" ]; then
        echo "[!] Token 不能为空"
        exit 1
    fi

    read -p "本机名称${DEFAULT_NAME:+ [$DEFAULT_NAME]}: " NAME
    NAME=${NAME:-${DEFAULT_NAME:-$(hostname)}}

    # 列出本机 screen sessions 供选择
    echo ""
    echo "当前 screen sessions:"
    screen -list 2>/dev/null | grep -oP '\d+\.\K\S+' | sed 's/^/  /' || echo "  (无)"
    echo ""

    if [ -n "$SCREEN_ARG" ]; then
        SCREEN_SESSION="$SCREEN_ARG"
        echo "使用命令行指定的 session: $SCREEN_SESSION"
    else
        read -p "要监控的 Screen session 名称${DEFAULT_SCREEN:+ [$DEFAULT_SCREEN]}: " SCREEN_SESSION
        SCREEN_SESSION=${SCREEN_SESSION:-${DEFAULT_SCREEN:-main}}
    fi

    read -p "备注标签，逗号分隔 (如 gpu,dev) []: " TAGS
    TAGS_JSON="[]"
    if [ -n "$TAGS" ]; then
        TAGS_JSON=$(echo "$TAGS" | tr ',' '\n' | xargs -I{} printf '"{}",' | sed 's/,$//' | awk '{print "["$0"]"}')
    fi

    # 写文件 - 每个 session 独立配置
    local CFG_NAME="config.client-${SCREEN_SESSION}.json"
    mkdir -p "$PROJ_DIR/public"
    if [ "$PROJ_DIR" != "$REPO_DIR" ]; then
        cp "$REPO_DIR/server.js" "$PROJ_DIR/"
        cp "$REPO_DIR/supervisor.js" "$PROJ_DIR/"
        cp "$REPO_DIR/client.js" "$PROJ_DIR/"
        cp "$REPO_DIR/public/index.html" "$PROJ_DIR/public/"
    fi

    cat > "$PROJ_DIR/$CFG_NAME" << EOF
{
  "mode": "client",
  "server": {
    "port": 8080,
    "password": "unused"
  },
  "client": {
    "serverUrl": "$SERVER_URL",
    "token": "$TOKEN",
    "name": "$NAME",
    "screen": "$SCREEN_SESSION",
    "attrs": {
      "tags": $TAGS_JSON
    }
  }
}
EOF

    cd "$PROJ_DIR"
    npm install --production 2>&1 | tail -1

    # 在 screen 里启动，用 screen session 名做后缀避免冲突
    local sn="swt-client-${SCREEN_SESSION}"
    if screen -list | grep -q "\.$sn"; then
        echo "[!] screen session '$sn' 已存在，先关闭..."
        screen -S "$sn" -X quit
        sleep 1
    fi
    screen -dmS "$sn" bash -c "cd $PROJ_DIR && node client.js --config=$CFG_NAME 2>&1 | tee -a $PROJ_DIR/client-${SCREEN_SESSION}.log"

    echo ""
    echo "=== 部署完成 ==="
    echo "  机器名称: $NAME"
    echo "  监控 Screen: $SCREEN_SESSION"
    echo "  配置文件: $PROJ_DIR/$CFG_NAME"
    echo ""
    echo "  查看: screen -r $sn"
    echo "  停止: screen -S $sn -X quit"
}

# --- 本地调试模式 ---
deploy_debug() {
    echo "=== Terminal Monitor Debug Mode ==="
    echo ""

    cd "$PROJ_DIR"

    # Check npm dependencies
    if [ ! -d "node_modules" ]; then
        echo "[*] Installing dependencies..."
        npm install --production 2>&1 | tail -1
    fi

    # Auto-detect local IP
    LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    LOCAL_IP=${LOCAL_IP:-"127.0.0.1"}

    read -p "监听端口 [8080]: " PORT
    PORT=${PORT:-8080}

    PASSWORD="debug"
    TOKEN=$(openssl rand -hex 16)

    # List screen sessions
    echo ""
    echo "当前 screen sessions:"
    screen -list 2>/dev/null | grep -oP '\d+\.\K\S+' | sed 's/^/  /' || echo "  (无)"
    echo ""

    if [ -n "$SCREEN_ARG" ]; then
        SCREEN_SESSION="$SCREEN_ARG"
        echo "使用指定的 session: $SCREEN_SESSION"
    else
        read -p "要监控的 Screen session [main]: " SCREEN_SESSION
        SCREEN_SESSION=${SCREEN_SESSION:-main}
    fi

    # Write debug server config
    cat > "$PROJ_DIR/config.debug-server.json" << EOF
{
  "mode": "server",
  "server": {
    "port": $PORT,
    "password": "$PASSWORD",
    "tokens": {
      "$TOKEN": { "name": "debug", "desc": "debug mode" }
    },
    "supervisor": { "enabled": false, "summaryInterval": 300, "idleTimeout": 600, "webhook": "" }
  }
}
EOF

    # Write debug client config
    cat > "$PROJ_DIR/config.debug-client.json" << EOF
{
  "mode": "client",
  "server": { "port": $PORT, "password": "unused" },
  "client": {
    "serverUrl": "ws://127.0.0.1:$PORT",
    "token": "$TOKEN",
    "name": "$(hostname)-debug",
    "screen": "$SCREEN_SESSION",
    "screenMode": "auto",
    "cols": 200,
    "rows": 50,
    "attrs": { "tags": ["debug"] }
  }
}
EOF

    # Cleanup function
    cleanup_debug() {
        echo ""
        echo "[*] Stopping debug mode..."
        kill $SERVER_PID $CLIENT_PID 2>/dev/null
        wait $SERVER_PID $CLIENT_PID 2>/dev/null
        rm -f "$PROJ_DIR/config.debug-server.json" "$PROJ_DIR/config.debug-client.json"
        echo "[*] Debug mode stopped. Config files cleaned up."
        exit 0
    }
    trap cleanup_debug SIGINT SIGTERM

    # Start server
    echo ""
    echo "[*] Starting server on 0.0.0.0:$PORT ..."
    node "$PROJ_DIR/server.js" --config=config.debug-server.json &
    SERVER_PID=$!
    sleep 1

    if ! kill -0 $SERVER_PID 2>/dev/null; then
        echo "[!] Server failed to start. Check for port conflicts."
        exit 1
    fi

    # Start client
    echo "[*] Starting client (screen: $SCREEN_SESSION) ..."
    node "$PROJ_DIR/client.js" --config=config.debug-client.json &
    CLIENT_PID=$!
    sleep 1

    if ! kill -0 $CLIENT_PID 2>/dev/null; then
        echo "[!] Client failed to start."
        kill $SERVER_PID 2>/dev/null
        rm -f "$PROJ_DIR/config.debug-server.json" "$PROJ_DIR/config.debug-client.json"
        exit 1
    fi

    echo ""
    echo "========================================="
    echo "  Debug mode running!"
    echo "  URL:      http://$LOCAL_IP:$PORT"
    echo "  Password: $PASSWORD"
    echo "  Screen:   $SCREEN_SESSION"
    echo "  Server PID: $SERVER_PID"
    echo "  Client PID: $CLIENT_PID"
    echo "========================================="
    echo ""
    echo "  Press Ctrl+C to stop"
    echo ""

    # Wait for either process to exit
    wait -n $SERVER_PID $CLIENT_PID 2>/dev/null || wait $SERVER_PID $CLIENT_PID 2>/dev/null
    echo "[!] One process exited unexpectedly."
    cleanup_debug
}

# --- 主流程 ---
echo "Terminal Monitor 一键部署"
echo ""

check_node

if [ "$MODE" = "server" ]; then
    deploy_server
elif [ "$MODE" = "client" ]; then
    deploy_client
elif [ "$MODE" = "debug" ]; then
    deploy_debug
else
    echo "用法: bash install.sh [server|client|debug] [screen-session]"
    echo ""
    echo "  server [port]       - 部署到公网服务器"
    echo "  client [session]    - 部署到内网机器，可指定 screen session"
    echo "  debug  [session]    - 本地调试：同时启动 server + client"
    echo ""
    echo "示例:"
    echo "  bash install.sh server"
    echo "  bash install.sh client          # 交互式选择 screen session"
    echo "  bash install.sh client claude   # 直接指定 screen session"
    echo "  bash install.sh debug           # 本地调试，交互选择 screen"
    echo "  bash install.sh debug claude    # 本地调试，指定 screen session"
    exit 1
fi
