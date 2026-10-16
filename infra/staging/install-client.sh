#!/usr/bin/env bash
set -euo pipefail
STAGING_ROOT="$1"
STAGING_RELEASE="$2"
STAGING_NODE="$3"
export PATH="$(dirname "$STAGING_NODE"):/usr/local/bin:/usr/bin:/bin"
cd "$STAGING_ROOT/releases/$STAGING_RELEASE"
"$(dirname "$STAGING_NODE")/npm" ci --omit=dev
mkdir -p "$STAGING_ROOT/bin" "$STAGING_ROOT/runtime/sandbox"
cp infra/staging/{ensure-client.sh,stop-client.sh,run-client.sh,run-task.py} "$STAGING_ROOT/bin/"
chmod 755 "$STAGING_ROOT/bin/"*
ln -sfn "$STAGING_ROOT/releases/$STAGING_RELEASE" "$STAGING_ROOT/current.next"
mv -Tf "$STAGING_ROOT/current.next" "$STAGING_ROOT/current"
if [ ! -d "$STAGING_ROOT/runtime/sandbox/.git" ]; then
  git -C "$STAGING_ROOT/runtime/sandbox" init -q
fi
# Preserve the fixture id and credentials across code deployments.
if [ ! -f "$STAGING_ROOT/runtime/codex-command.json" ]; then
  "$STAGING_NODE" - "$STAGING_ROOT" <<'JS'
const fs=require('fs'),path=require('path');
const root=process.argv[2];
const settings=JSON.parse(fs.readFileSync(path.join(root,'runtime/settings.json')));
process.env.CODEX_BIN=path.join(path.dirname(settings.node),'codex');
const prepare=require(path.join(root,'current/test/fixtures/codex-history.js'));
const args=prepare(path.join(root,'runtime/codex-home'),path.join(root,'runtime/sandbox'));
fs.writeFileSync(path.join(root,'runtime/codex-command.json'),JSON.stringify(args),{mode:0o600});
JS
fi
python3 - "$STAGING_ROOT" <<'PY'
import subprocess,sys
root=sys.argv[1]
r=subprocess.run(['crontab','-l'],capture_output=True,text=True)
if r.returncode and 'no crontab' not in r.stderr.lower(): raise RuntimeError(r.stderr)
start='# BEGIN terminal-monitor-staging';end='# END terminal-monitor-staging'
s=r.stdout
if start in s:
 before,rest=s.split(start,1)
 if end not in rest:raise RuntimeError('incomplete managed cron block')
 s=before+rest.split(end,1)[1]
cmd=f'{root}/bin/ensure-client.sh >> {root}/runtime/watchdog.log 2>&1'
s=s.rstrip()+f'\n{start}\n@reboot {cmd}\n* * * * * {cmd}\n{end}\n'
subprocess.run(['crontab','-'],input=s,text=True,check=True)
PY
rm -f "$STAGING_ROOT/runtime/stopped"
# Restart only the test monitor; preserve the user's running test Codex.
if screen -ls | grep -qE '[.]swt-staging-client[[:space:]]'; then
  screen -S swt-staging-client -X quit
fi
bash "$STAGING_ROOT/bin/ensure-client.sh"
