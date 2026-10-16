#!/usr/bin/env bash
set -euo pipefail
STAGING_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec 9>"$STAGING_ROOT/runtime/ensure.lock"
flock 9
# Hold the same lock as the watchdog so it cannot start a worker during stop.
touch "$STAGING_ROOT/runtime/stopped"
for STAGING_SESSION in swt-staging-client swt-staging-codex; do
  if screen -ls | grep -qE "[.]${STAGING_SESSION}[[:space:]]"; then
    screen -S "$STAGING_SESSION" -X quit
  fi
done
# Screen's quit request is asynchronous. Do not let a following start race
# with sessions that are still shutting down.
for ((STAGING_ATTEMPT=0; STAGING_ATTEMPT<150; STAGING_ATTEMPT++)); do
  if ! screen -ls | grep -qE '[.]swt-staging-(client|codex)[[:space:]]'; then
    exit 0
  fi
  sleep 0.1
done
echo 'Staging Screen sessions did not stop within 15 seconds' >&2
exit 1
