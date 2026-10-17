#!/usr/bin/env bash
set -euo pipefail
STAGING_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ ! -f "$STAGING_ROOT/runtime/stopped" ] || exit 0
exec 9>"$STAGING_ROOT/runtime/ensure.lock"
flock -n 9 || exit 0
[ ! -f "$STAGING_ROOT/runtime/stopped" ] || exit 0
STAGING_NODE="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["node"])' "$STAGING_ROOT/runtime/settings.json")"
export PATH="$(dirname "$STAGING_NODE"):/usr/local/bin:/usr/bin:/bin"
export LANG=C.UTF-8 LC_ALL=C.UTF-8
source "$STAGING_ROOT/current/service-runtime.sh"
if ! screen -ls | grep -qE '[.]swt-staging-codex[[:space:]]'; then
  start_managed_screen swt-staging-codex -U -L -Logfile "$STAGING_ROOT/runtime/codex-screen.log" -- python3 "$STAGING_ROOT/bin/run-task.py" 9>&-
fi
if ! screen -ls | grep -qE '[.]swt-staging-client[[:space:]]'; then
  start_managed_screen swt-staging-client -U -- bash "$STAGING_ROOT/bin/run-client.sh" 9>&-
fi
