#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd "$SCRIPT_DIR/.." && pwd)
NODE=${NODE:-node}
HOST=${HOST:-0.0.0.0}
PORT=${PORT:-8787}
PID_FILE="$SCRIPT_DIR/.local-workbench.pid"
LOG_FILE="$SCRIPT_DIR/.local-workbench.log"

usage() {
  cat <<USAGE
用法: $0 <start|stop|restart|help>

命令:
  start    后台启动本地工作台，已运行时不重复启动
  stop     静默停止本地工作台
  restart  静默停止后重新启动本地工作台
  help     显示帮助

环境变量:
  NODE     Node.js 命令，默认: node
  HOST     监听地址，默认: 0.0.0.0
  PORT     监听端口，默认: 8787

访问地址: http://$HOST:$PORT
根目录:   $ROOT_DIR
日志文件: $LOG_FILE
USAGE
}

pid_is_workbench() {
  [ -f "$PID_FILE" ] || return 1
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$pid" 2>/dev/null || return 1
  command=$(ps -p "$pid" -o command= 2>/dev/null || true)
  case "$command" in
    *"$SCRIPT_DIR/server.js"*) return 0 ;;
    *) return 1 ;;
  esac
}

stop_server() {
  if ! pid_is_workbench; then
    rm -f "$PID_FILE"
    return 0
  fi

  pid=$(cat "$PID_FILE")
  kill "$pid" 2>/dev/null || true
  i=0
  while pid_is_workbench && [ "$i" -lt 20 ]; do
    sleep 0.1
    i=$((i + 1))
  done
  if pid_is_workbench; then
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
}

print_server_info() {
  state=$1
  pid=$(cat "$PID_FILE")
  access_host=$HOST
  case "$access_host" in
    0.0.0.0|::) access_host=127.0.0.1 ;;
  esac
  printf '%s\n' "local-workbench $state"
  printf '%s\n' "PID: $pid"
  printf '%s\n' "访问地址: http://$access_host:$PORT"
  printf '%s\n' "监听地址: http://$HOST:$PORT"
  printf '%s\n' "根目录: $ROOT_DIR"
  printf '%s\n' "日志文件: $LOG_FILE"
}

start_server() {
  if pid_is_workbench; then
    print_server_info '已在运行'
    return 0
  fi
  rm -f "$PID_FILE"

  HOST="$HOST" "$NODE" "$SCRIPT_DIR/server.js" --root "$ROOT_DIR" --port "$PORT" \
    >>"$LOG_FILE" 2>&1 < /dev/null &
  pid=$!
  printf '%s\n' "$pid" > "$PID_FILE"
  sleep 0.2
  if ! pid_is_workbench; then
    echo "local-workbench 启动失败，详见: $LOG_FILE" >&2
    rm -f "$PID_FILE"
    return 1
  fi
  print_server_info '已启动'
}

case "${1:-help}" in
  start)
    start_server
    ;;
  stop)
    stop_server
    ;;
  restart)
    stop_server
    start_server
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "未知指令: $1" >&2
    usage >&2
    exit 1
    ;;
esac
