#!/bin/bash
# Restart the local installation, or a remote target from deploy.targets.conf.
#   bash restart.sh --help
#   bash restart.sh server [target-label|--local]
#   bash restart.sh client <screen-session> [target-label|--local] [scope]
# Omitting the target means local. Client scope defaults to service; real/all
# recreate the task Screen and terminate everything running inside it.
set -uo pipefail

PROJ_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$PROJ_DIR/deploy.targets.conf"
MODE="${1:-}"
SCREEN_SESSION=""
SCOPE="service"
usage() {
  echo '用法: bash restart.sh server [目标标签|--local]'
  echo '      bash restart.sh client <会话名> [目标标签|--local] [service|real|all]'
  echo '不指定目标时直接重启本机，无需 deploy.targets.conf。'
  echo '指定目标标签时，从 deploy.targets.conf 读取目标并通过 SSH 重启。'
  echo 'service(默认): 只重启监控；real/all: 重建任务 Screen，终止其中的任务。'
  echo '示例: bash restart.sh client monitor-1                    # 本机监控'
  echo '      bash restart.sh server                              # 本机服务端'
  echo '      bash restart.sh client monitor-1 gpu-box             # 远程监控'
  echo '      bash restart.sh client monitor-1 --local service     # 显式本机'
  echo '帮助: bash restart.sh --help（也支持 -h 和 help）'
}
for argument in "$@"; do
  case "$argument" in -h|--help) usage; exit 0 ;; esac
done
if [ "$MODE" = help ]; then usage; exit 0; fi
case "$MODE" in
  server)
    [ "$#" -le 2 ] || { usage; exit 1; }
    TARGET_LABEL="${2:-}"
    ;;
  client)
    SCREEN_SESSION="${2:-}"
    TARGET_LABEL="${3:-}"
    SCOPE="${4:-service}"
    [ "$#" -le 4 ] || { usage; exit 1; }
    [[ "$SCREEN_SESSION" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$ ]] || {
      echo '[!] 请指定有效的 Screen 会话名（字母、数字、下划线、点或连字符）'; exit 1;
    }
    case "$SCOPE" in
      service|real|all) ;;
      *) echo "[!] 无效 scope: $SCOPE（可选 service、real、all）"; exit 1 ;;
    esac
    ;;
  *) usage; exit 1 ;;
esac

LOCAL=0
TARGETS=()
if [ -z "$TARGET_LABEL" ] || [ "$TARGET_LABEL" = '--local' ]; then
  LOCAL=1
  TARGETS=("local|$(id -un)|localhost|0|$PROJ_DIR")
else
  [ -f "$CONF" ] || { echo "[!] Target config not found: $CONF"; exit 1; }
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    TARGETS+=("$line")
  done < "$CONF"
fi

# One worker is executed directly by local bash, or sent to remote bash over
# SSH. Quote only the parameter declarations; keep the worker body literal.
worker=$(cat <<'WORKER'
set -euo pipefail
cd "$RESTART_DIR"
ROOT="$PWD"
entry="$MODE.js"
if [ "$MODE" = client ]; then
  screen_name="swt-client-$SCREEN_SESSION"
  log_file="client-$SCREEN_SESSION.log"
  config="config.client-$SCREEN_SESSION.json"
else
  screen_name='swt-server'
  log_file='server.log'
  config='config.json'
fi
source "$ROOT/service-runtime.sh"
if [ "$SCOPE" != real ]; then
  if [ "$MODE" = client ] && [ -f "$config.stop" ]; then
    echo '[restart] .stop marker present — node was terminated, skipping relaunch'
    exit 0
  fi
  [ -f "$config" ] || { echo "[restart] config not found: $ROOT/$config" >&2; exit 1; }
  if [ "$MODE" = client ]; then
    check_require='require("./terminal-state"); require("node-pty")'
  else
    check_require='require("ws")'
  fi
  # Probe the runtime before stopping anything. Nvm is not loaded by SSH;
  # parsing the entry alone also misses incompatible terminal dependencies.
  resolve_service_node "$ROOT" "$entry" "$check_require"
  "$NODE_BIN" -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$config"
  stop_screen "$screen_name"
  # A node-pty client can survive Screen's SIGHUP. Match the exact project,
  # entry and configuration, rather than pkill patterns that hit siblings.
  pids=$("$NODE_BIN" - "$ROOT" "$entry" "$config" <<'NODE'
const fs = require('fs'), path = require('path');
const [root, entry, config] = process.argv.slice(2);
for (const pid of fs.readdirSync('/proc').filter(x => /^\d+$/.test(x))) {
  try {
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    if (!['node', 'nodejs'].includes(path.basename(args[0])) || !args[1]) continue;
    const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    if (path.resolve(cwd, args[1]) !== path.resolve(root, entry)) continue;
    let configured = args.find(x => x.startsWith('--config='))?.slice(9);
    const index = args.indexOf('--config');
    if (!configured && index >= 0) configured = args[index + 1];
    if (path.resolve(cwd, configured || path.join(root, 'config.json')) !== path.join(root, config)) continue;
    process.kill(Number(pid), 'SIGTERM');
    console.log(pid);
  } catch (error) {
    if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error;
  }
}
NODE
)
  for pid in $pids; do
    for ((i=0; i<30; i++)); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "[restart] process $pid did not stop; refusing to start a duplicate" >&2
      exit 1
    fi
  done
fi
if [ "$SCOPE" = real ] || [ "$SCOPE" = all ]; then
  stop_screen "$SCREEN_SESSION"
  start_managed_screen "$SCREEN_SESSION" -- bash
  screen_exists "$SCREEN_SESSION" || { echo '[restart] task Screen did not come up' >&2; exit 1; }
fi
if [ "$SCOPE" != real ]; then
  start_service_screen "$screen_name" "$ROOT" "$NODE_BIN" "$entry" "$config" "$ROOT/$log_file"
  sleep 1
  screen_exists "$screen_name" || { echo "[restart] Screen did not come up, check $log_file" >&2; exit 1; }
fi
WORKER
)

failed=0
matched=0
for target in "${TARGETS[@]}"; do
  IFS='|' read -r label user host port directory <<< "$target"
  if [ "$LOCAL" = 0 ] && [ "$label" != "$TARGET_LABEL" ]; then continue; fi
  matched=$((matched + 1))
  if [ -z "$label" ] || [ -z "$user" ] || [ -z "$host" ] || [ -z "$directory" ] || ! [[ "$port" =~ ^[0-9]+$ ]]; then
    echo '[!] Invalid target (expected label|user|host|port|path)'
    failed=$((failed + 1))
    continue
  fi
  printf -v declarations 'RESTART_DIR=%q\nMODE=%q\nSCREEN_SESSION=%q\nSCOPE=%q\n' "$directory" "$MODE" "$SCREEN_SESSION" "$SCOPE"
  script="$declarations$worker"
  if [ "$LOCAL" = 1 ]; then
    echo "=== Restarting $MODE locally [scope: $SCOPE] ==="
    if bash -s <<< "$script"; then result=0; else result=$?; fi
  else
    echo "=== Restarting $MODE on $label ($user@$host:$port) [scope: $SCOPE] ==="
    if ssh -p "$port" "$user@$host" 'bash -s' <<< "$script"; then result=0; else result=$?; fi
  fi
  if [ "$result" = 0 ]; then
    echo '  [OK] restart completed'
  else
    echo '  [FAIL] could not restart'
    failed=$((failed + 1))
  fi
done
[ "$matched" -gt 0 ] || { echo "[!] Target label not found: $TARGET_LABEL"; exit 1; }
[ "$failed" -eq 0 ] || { echo "Done with $failed target(s) failed."; exit 1; }
echo 'All targets restarted successfully.'
