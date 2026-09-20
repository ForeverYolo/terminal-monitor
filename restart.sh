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

# Build a safely quoted remote command. The remote install layout is the one
# created by install.sh: server uses swt-server; clients use swt-client-<session>.
if [ "$MODE" = "server" ]; then
  screen_name="swt-server"
  log_file="server.log"
  start_cmd="node server.js"
  scope="service"
else
  screen_name="swt-client-$SCREEN_SESSION"
  config_file="config.client-$SCREEN_SESSION.json"
  log_file="client-$SCREEN_SESSION.log"
  start_cmd="node client.js --config=$config_file"
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
  # NOTE: qstart must NOT be %q-escaped — it is a full command line (spaces and
  # all), not a single argument. %q would turn its spaces into "\ " and the
  # remote bash would then treat the whole string as one command name
  # ("command not found"). It is safely embedded inside double quotes below.
  qstart="$start_cmd"

  # Piece together the remote command from the requested scope:
  #   - service part: quit the swt-client-<session> screen, then (unless the
  #     real screen alone is requested) recreate it running node client.js.
  #   - real part: quit the real <session> screen and recreate it empty with a
  #     shell. Anything running inside it (shells, jobs) is killed — that is
  #     the point of "real" scope. The recreated session is left DETACHED so
  #     the client service can attach via `screen -x`.
  # sleep 1 after each quit lets the old session's pty die before anything
  # reattaches; the trailing pgrep verifies the node process actually came up.
  svc_quit="(screen -S $qscreen -X quit 2>/dev/null || true)"
  svc_start="screen -dmS $qscreen bash -c \"cd $qpath && $qstart 2>&1 | tee -a $qlog\""
  real_quit="(screen -S $qreal -X quit 2>/dev/null || true)"
  real_start="screen -dmS $qreal bash"

  case "$scope" in
    service)
      remote_cmd="cd $qpath && $svc_quit && sleep 1 && $svc_start && sleep 3 && pgrep -f \"$qstart\" > /dev/null"
      verify_desc="$screen_name restarted (process verified)"
      ;;
    real)
      remote_cmd="$real_quit && sleep 1 && $real_start && sleep 1 && screen -list | grep -q \"[.]$qreal\""
      verify_desc="real screen $SCREEN_SESSION recreated empty (was killed)"
      ;;
    all)
      remote_cmd="cd $qpath && $svc_quit && $real_quit && sleep 1 && $real_start && sleep 1 && $svc_start && sleep 3 && pgrep -f \"$qstart\" > /dev/null"
      verify_desc="$screen_name + real screen $SCREEN_SESSION restarted (process verified)"
      ;;
  esac

  echo "=== Restarting $MODE on $label ($user@$host:$port) [scope: $scope] ==="
  if ssh -p "$port" "$user@$host" "$remote_cmd"; then
    echo "  [OK] $verify_desc"
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
