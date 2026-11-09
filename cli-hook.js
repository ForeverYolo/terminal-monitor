#!/usr/bin/env node
'use strict';
// Non-blocking, observe-only command hook. Never emits model context or makes
// an approval decision. Payload text/tool inputs are deliberately not sent.
const net = require('net');
const path = require('path');
const { socketPath } = require('./cli-hooks');
const { readProcess, processApp } = require('./cli-process');
const { EVENTS } = require('./cli-tracker');

const app = process.argv[2];
if (!['codex', 'claude'].includes(app)) { process.stderr.write('Usage: node cli-hook.js codex|claude [--print-config]\n'); process.exit(1); }
if (process.argv.includes('--print-config')) {
  const events = app === 'codex'
    ? ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd']
    : ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Stop', 'Notification', 'SessionEnd'];
  const quote = s => "'" + s.replace(/'/g, "'\\''") + "'";
  const command = [process.execPath, path.resolve(process.argv[1]), app].map(quote).join(' ');
  process.stdout.write(JSON.stringify({ hooks: Object.fromEntries(events.map(event => [event, [{ hooks: [{ type: 'command', command, timeout: 2 }] }]])) }, null, 2) + '\n');
  process.exit(0);
}
let input = '', bytes = 0;
const timeout = setTimeout(() => process.exit(0), 1200);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes > 1024 * 1024) process.exit(0); input += chunk; });
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(input);
    if (!EVENTS.has(payload.hook_event_name) || typeof payload.session_id !== 'string' || payload.agent_id) return;
    let cli = null, ancestor = readProcess(process.ppid);
    for (let i = 0; ancestor && i < 32; i++, ancestor = readProcess(ancestor.ppid)) if (processApp(ancestor.pid) === app) cli = ancestor;
    if (!cli) return;
    const screen = process.env.STY;
    if (!screen) return;
    const event = {
      app, pid: cli.pid, start: cli.start, sessionId: payload.session_id,
      turnId: typeof payload.turn_id === 'string' ? payload.turn_id : null,
      event: payload.hook_event_name, notificationType: payload.notification_type,
      toolName: typeof payload.tool_name === 'string' ? payload.tool_name.slice(0, 120) : null,
      sentAt: Date.now()
    };
    const c = net.createConnection(socketPath(screen), () => c.write(JSON.stringify(event) + '\n'));
    c.setTimeout(800, () => c.destroy());
    c.on('data', () => c.end());
    c.on('error', () => {});
    c.on('close', () => { clearTimeout(timeout); process.exit(0); });
  } catch { /* monitoring must never interrupt the CLI */ }
});
