#!/bin/bash
# Restart Terminal Monitor server/client screen sessions on remote targets.
#
# Usage:
#   bash restart.sh server <target-label>
#   bash restart.sh client <screen-session> <target-label>
#
# Targets use the same format as deploy.sh:
#   label|user|host|port|path

set -u

PROJ_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$PROJ_DIR/deploy.targets.conf"
MODE="${1:-}"
SCREEN_SESSION="${2:-}"
TARGET_LABEL="${3:-}"

if [ "$MODE" != "server" ] && [ "$MODE" != "client" ]; then
  echo "用法: bash restart.sh server <target-label>"
  echo "      bash restart.sh client <screen-session> <target-label>"
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
  config_file="server.js"
  log_file="server.log"
  start_cmd="node server.js"
else
  screen_name="swt-client-$SCREEN_SESSION"
  config_file="config.client-$SCREEN_SESSION.json"
  log_file="client-$SCREEN_SESSION.log"
  start_cmd="node client.js --config=$config_file"
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
  printf -v qlog '%q' "$log_file"
  printf -v qstart '%q' "$start_cmd"
  remote_cmd="cd $qpath && (screen -S $qscreen -X quit 2>/dev/null || true) && screen -dmS $qscreen bash -c \"$qstart 2>&1 | tee -a $qlog\""

  echo "=== Restarting $MODE on $label ($user@$host:$port) ==="
  if ssh -p "$port" "$user@$host" "$remote_cmd"; then
    echo "  [OK] $screen_name restarted"
  else
    echo "  [FAIL] could not restart $screen_name"
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
