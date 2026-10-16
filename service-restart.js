'use strict';
const path = require('path');
const { spawn } = require('child_process');

function launch(script, args) {
  const child = spawn('bash', ['-c', script, 'swt-self-restart', ...args.map(String)], {
    detached: true, stdio: 'ignore', env: { ...process.env }
  });
  child.on('error', error => console.error('[restart]', error.message));
  child.unref();
}
function restartClient({ root, node, configFile, screenName, pid }) {
  launch(`set -euo pipefail
root="$1"; node_bin="$2"; config="$3"; task="$4"; old_pid="$5"
source "$root/service-runtime.sh"
sleep 2
kill -TERM "$old_pid" 2>/dev/null || true
sleep 2
stop_screen "swt-client-$task"
if [ -f "$config.stop" ]; then
  if screen_exists "$task"; then rm -f "$config.stop"; else exit 0; fi
fi
start_service_screen "swt-client-$task" "$root" "$node_bin" client.js "$config" "$root/client-$task.log"
`, [root, node, path.resolve(configFile), screenName, pid]);
}
function restartServer({ root, node, configFile, backup }) {
  launch(`set -euo pipefail
root="$1"; node_bin="$2"; config="$3"; backup="$4"
source "$root/service-runtime.sh"
sleep 1
stop_screen swt-server
start_service_screen swt-server "$root" "$node_bin" server.js "$config" "$root/server.log"
sleep 5
if ! screen_exists swt-server; then
  echo '[self-update] relaunch failed, restoring backup and retrying once' >> "$root/server.log"
  for file in "$backup"/*; do
    [ -f "$file" ] || continue
    relative="$(basename "$file")"; relative="\${relative//__//}"
    mkdir -p "$root/$(dirname "$relative")"
    cp -f -- "$file" "$root/$relative"
  done
  start_service_screen swt-server "$root" "$node_bin" server.js "$config" "$root/server.log"
fi
`, [root, node, path.resolve(configFile), backup]);
}
module.exports = { restartClient, restartServer };
