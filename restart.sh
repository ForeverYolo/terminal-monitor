#!/bin/bash
# Restart Terminal Monitor server/client screen sessions on remote targets.
#
# Usage:
#   bash restart.sh server <target-label>
#   bash restart.sh client <screen-session> <target-label> [scope]
#
# scope (client mode only, default: service):
#   service  restart only the swt-client-<session> screen running node client.js
#   real     restart only the real screen session <session> (recreated EMPTY —
#            everything running inside it is killed)
#   all      restart both: service screen is killed first, real screen is
#            recreated, then the service is started so it attaches fresh
#
# Targets use the same format as deploy.sh:
#   label|user|host|port|path

set -u

PROJ_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$PROJ_DIR/deploy.targets.conf"
MODE="${1:-}"
# server mode:  bash restart.sh server <target-label>            → label is $2
# client mode:  bash restart.sh client <screen-session> <label> [scope] → label is $3
if [ "$MODE" = "server" ]; then
  TARGET_LABEL="${2:-}"
else
  SCREEN_SESSION="${2:-}"
  TARGET_LABEL="${3:-}"
  SCOPE="${4:-service}"
fi

if [ "$MODE" != "server" ] && [ "$MODE" != "client" ]; then
  echo "用法: bash restart.sh server <target-label>"
  echo "      bash restart.sh client <screen-session> <target-label> [scope]"
  echo "scope: service(默认, 只重启 swt-client-<session> 服务进程) |"
  echo "       real(只重启真实 <session> screen, 内容会被清空) |"
  echo "       all(两者都重启, 服务进程重新 attach)"
  exit 1
fi

if [ "$MODE" = "client" ] && [ -z "$SCREEN_SESSION" ]; then
  echo "[!] client 模式必须指定 screen session，例如: bash restart.sh client mywork"
  exit 1
fi

if [ "$MODE" = "server" ] && [ -z "$TARGET_LABEL" ]; then
  echo "[!] server 模式必须指定目标标签，例如: bash restart.sh server server"
  exit 1
fi

if [ "$MODE" = "client" ] && [ -z "$TARGET_LABEL" ]; then
  echo "[!] client 模式必须指定目标标签，例如: bash restart.sh client mywork gpu-box"
  exit 1
fi

if [ "$MODE" = "client" ]; then
  case "$SCOPE" in
    service|real|all) ;;
    *)
      echo "[!] 无效 scope: $SCOPE (可选: service | real | all，默认 service)"
      exit 1
      ;;
  esac
fi

if [ ! -f "$CONF" ]; then
  echo "[!] Target config not found: $CONF"
  echo "    Copy deploy.targets.example.conf -> deploy.targets.conf and fill in your hosts."
  exit 1
fi

TARGETS=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%#*}"
  line="$(echo "$line" | xargs)"
  [ -n "$line" ] && TARGETS+=("$line")
done < "$CONF"

if [ ${#TARGETS[@]} -eq 0 ]; then
  echo "[!] No targets defined in $CONF"
  exit 1
fi

# Remote install layout is the one created by install.sh:
#   server  → swt-server, server.js
#   client  → swt-client-<session>, client.js --config=config.client-<session>.json
if [ "$MODE" = "server" ]; then
  screen_name="swt-server"
  log_file="server.log"
  node_args="server.js"
  scope="service"
else
  screen_name="swt-client-$SCREEN_SESSION"
  log_file="client-$SCREEN_SESSION.log"
  node_args="client.js --config=config.client-$SCREEN_SESSION.json"
  scope="$SCOPE"
fi

failed=0
matched=0
for target in "${TARGETS[@]}"; do
  IFS='|' read -r label user host port path <<< "$target"
  if [ -z "${label:-}" ] || [ -z "${user:-}" ] || [ -z "${host:-}" ] || [ -z "${port:-}" ] || [ -z "${path:-}" ]; then
    echo "[!] Invalid target (expected label|user|host|port|path): $target"
    failed=$((failed + 1))
    continue
  fi
  if [ "$label" != "$TARGET_LABEL" ]; then
    continue
  fi
  matched=$((matched + 1))

  printf -v qpath '%q' "$path"
  printf -v qscreen '%q' "$screen_name"
  printf -v qreal '%q' "$SCREEN_SESSION"
  printf -v qlog '%q' "$log_file"

  # The remote script is piped to `bash -s` via stdin instead of spliced into
  # one giant `ssh host "..."` string. The node probe below is full of quotes;
  # nesting those inside bash -c "..." inside ssh "..." produces quoting bugs
  # ('client.js: command not found'). Via stdin there is no nesting.
  #
  # Node resolution: some hosts (2080-server) have an ancient system node (v12)
  # that can't parse the app's optional-chaining syntax, with the real runtime
  # in nvm. Non-interactive SSH doesn't load nvm (see NODE_RESOLVE comment), so
  # bare `node` there means v12 → instant SyntaxError crash loop. The probe
  # picks the first candidate that can actually parse the entry file
  # (`node --check <file>` — evidence-based, not version guessing). NOTE the
  # argument order: `node <file> --check` passes --check to the SCRIPT.
  # NODE_RESOLVE is single-quoted: it must expand on the REMOTE side.
  NODE_RESOLVE='NODE_BIN=""
for P in "$HOME"/.nvm/versions/node/*/bin/node /usr/local/bin/node /usr/bin/node node; do
  if [ "$P" = "node" ]; then
    if command -v node >/dev/null 2>&1 && node --check client.js 2>/dev/null; then NODE_BIN=node; fi
  elif [ -x "$P" ] && "$P" --check client.js 2>/dev/null; then
    NODE_BIN="$P"
  fi
  [ -n "$NODE_BIN" ] && break
done
[ -n "$NODE_BIN" ] || { echo "[restart] no working node found" >&2; exit 1; }
# Must EXPORT: plain shell variables are not inherited by the bash -c child
# that screen spawns, and an empty $NODE_BIN there fails as `exec: : not found`.
export NODE_BIN'

  remote_script="cd $qpath || exit 1"
  do_service=1; do_real=0
  [ "$scope" = "real" ] && do_service=0
  [ "$scope" = "all" ] && do_real=1
  [ "$scope" = "real" ] && do_real=1

  # --- service part: quit swt screen, resolve node, relaunch via screen ---
  if [ "$do_service" = 1 ]; then
    remote_script+="
(screen -S $qscreen -X quit 2>/dev/null || true) && sleep 1"
    remote_script+="
$NODE_RESOLVE"
    remote_script+="
screen -dmS $qscreen bash -c 'cd $qpath && exec \"\$NODE_BIN\" $qpath/$node_args 2>&1 | tee -a $qpath/$qlog'
sleep 3
screen -ls | grep -q \"[.]$qscreen\" || { echo '[restart] screen did not come up, check $qlog' >&2; exit 1; }"
  fi

  # --- real part: quit the real screen, recreate it EMPTY with a shell ---
  if [ "$do_real" = 1 ]; then
    remote_script+="
(screen -S $qreal -X quit 2>/dev/null || true) && sleep 1
screen -dmS $qreal bash
sleep 1
screen -ls | grep -q \"[.]$qreal\" || { echo '[restart] real screen did not come up' >&2; exit 1; }"
  fi

  echo "=== Restarting $MODE on $label ($user@$host:$port) [scope: $scope] ==="
  if ssh -p "$port" "$user@$host" "bash -s" <<< "$remote_script"; then
    echo "  [OK] restarted (scope: $scope, screen session verified)"
  else
    echo "  [FAIL] could not restart (scope: $scope, see $log_file on target)"
    failed=$((failed + 1))
  fi
done

if [ "$matched" -eq 0 ]; then
  echo "[!] Target label not found: $TARGET_LABEL"
  exit 1
fi

if [ "$failed" -gt 0 ]; then
  echo "Done with $failed target(s) failed."
  exit 1
fi
echo "All targets restarted successfully."
