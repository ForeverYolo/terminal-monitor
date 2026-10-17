#!/usr/bin/env bash
# Shared shell primitives. This file has no startup side effects when sourced.
screen_exists() {
  local name tail output
  output=$(screen -ls 2>/dev/null || true)
  while read -r name tail; do
    if [[ "$name" = *.* && "${name#*.}" = "$1" ]]; then return 0; fi
  done <<< "$output"
  return 1
}
stop_screen() {
  if screen_exists "$1"; then
    screen -S "$1" -X quit
    for ((i=0; i<30; i++)); do
      screen_exists "$1" || return 0
      sleep 0.1
    done
    echo "[restart] Screen did not stop: $1" >&2
    return 1
  fi
}
resolve_service_node() {
  local root="$1" entry="$2" requires="${3:-}" candidate
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node /usr/local/bin/node /usr/bin/node node; do
    if [ "$candidate" = node ]; then candidate=$(command -v node || true); fi
    if [ -n "$candidate" ] && [ -x "$candidate" ] &&
       "$candidate" --check "$root/$entry" 2>/dev/null &&
       (cd "$root" && "$candidate" -e "$requires") 2>/dev/null; then
      NODE_BIN="$candidate"
      return 0
    fi
  done
  echo '[restart] no working node found' >&2
  return 1
}
# start_managed_screen NAME [Screen options...] -- COMMAND [args...]
# Keep environment/width defaults in one place for web, restart and staging.
start_managed_screen() {
  local name="$1"
  shift
  local options=()
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do
    options+=("$1")
    shift
  done
  [ "$#" -gt 1 ] || { echo '[screen] expected -- COMMAND' >&2; return 1; }
  shift
  (
    unset COLORTERM
    screen "${options[@]}" -dmS "$name" sh -c \
      'screen -S "$STY" -X cjkwidth off || exit; exec "$@"' \
      tm-screen "$@"
  )
}
start_service_screen() {
  local name="$1" root="$2" node_bin="$3" entry="$4" config="$5" log="$6"
  screen_exists "$name" && return 0
  start_managed_screen "$name" -- bash -c \
    'cd "$1" && exec "$2" "$3" --config="$4" 2>&1 | tee -a "$5"' \
    _ "$root" "$node_bin" "$entry" "$config" "$log"
}
