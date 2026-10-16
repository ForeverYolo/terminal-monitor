#!/usr/bin/env bash
set -euo pipefail
STAGING_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGING_NODE="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["node"])' "$STAGING_ROOT/runtime/settings.json")"
export PATH="$(dirname "$STAGING_NODE"):/usr/local/bin:/usr/bin:/bin"
export LANG=C.UTF-8 LC_ALL=C.UTF-8
cd "$STAGING_ROOT/current"
while [ ! -f "$STAGING_ROOT/runtime/stopped" ]; do
  "$STAGING_NODE" "$STAGING_ROOT/current/client.js" --config="$STAGING_ROOT/runtime/client.json" >> "$STAGING_ROOT/runtime/client.log" 2>&1 || true
  sleep 3
done
