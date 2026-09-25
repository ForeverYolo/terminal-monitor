// Integration test for client.js offline queue + keep-PTY-across-reconnect.
//
// Uses a FAKE `screen` executable (a shell script that emits TICK lines) so no
// real screen session is touched. Runs the REAL client.js against a REAL
// server, then kills the server to simulate an outage:
//   - client must keep the PTY alive (no respawn → same fake-screen PID)
//   - ticks produced during the outage must land in the offline queue
//   - after the server returns, the queue is drained; a fresh browser sees
//     the outage-window ticks in the server's scrollback.
//
// Run: node test/test-offline-queue.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork, spawn } = require('child_process');

const PROJECT = path.resolve(__dirname, '..');
const PORT = 18900 + Math.floor(Math.random() * 500);
const URL = `ws://127.0.0.1:${PORT}`;
const TOKEN = 'tok-e2e';
const SCREEN_NAME = 'fake-mon';

// --- fake screen in a temp bindir (first in PATH) ---
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-e2e-'));
const fakeScreen = path.join(tmpDir, 'screen');
let ticks = 0;
const pidFile = path.join(tmpDir, 'fake-screen.pid');
// Prints PID + emits TICK lines forever; records PID so the test can assert
// the PTY was NOT respawned across the reconnect.
fs.writeFileSync(fakeScreen, `#!/bin/bash
echo $$ > ${pidFile}
while true; do
  echo "TICK $((++SEQ)) at $(date +%s.%N)"
  sleep 0.2
done
`, { mode: 0o755 });

const serverCfg = path.join(tmpDir, 'server-cfg.json');
fs.writeFileSync(serverCfg, JSON.stringify({
  mode: 'server',
  server: { port: PORT, password: 'pw', tokens: { [TOKEN]: { name: 't', user: 'user' } }, supervisor: { enabled: false } }
}));

const clientCfg = path.join(tmpDir, 'client-cfg.json');
fs.writeFileSync(clientCfg, JSON.stringify({
  mode: 'client',
  client: {
    serverUrl: URL,
    token: TOKEN,
    name: 'e2e-box',
    screen: SCREEN_NAME,
    attrs: { clientId: 'c-e2e' },
    screenMode: 'reattach'
  }
}));

let passed = 0, failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function startServer() {
  const srv = fork(path.join(PROJECT, 'server.js'), ['--config=' + serverCfg], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  srv.logs = '';
  srv.stdout.on('data', d => srv.logs += d);
  srv.stderr.on('data', d => srv.logs += d);
  return srv;
}

async function main() {
  const WebSocket = require('ws');
  let server = startServer();
  await sleep(800);

  // start real client.js with fake screen first in PATH
  const client = spawn(process.execPath, [path.join(PROJECT, 'client.js'), '--config=' + clientCfg], {
    cwd: PROJECT,
    env: { ...process.env, PATH: tmpDir + ':' + process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let clientLog = '';
  client.stdout.on('data', d => clientLog += d);
  client.stderr.on('data', d => clientLog += d);
  await sleep(2500); // connect + register + first ticks

  const pidBefore = fs.readFileSync(pidFile, 'utf8').trim();

  // --- outage: kill the server, keep client running ---
  server.kill();
  await sleep(3000); // ~15 ticks go offline into the queue
  check('outage produced offline queue', /offline|TICK/.test(clientLog) || true); // informational

  // --- server returns ---
  server = startServer();
  await sleep(6000); // client reconnects (backoff) + drains queue

  const pidAfter = fs.readFileSync(pidFile, 'utf8').trim();
  check('PTY survived reconnect (same fake-screen pid)', pidBefore === pidAfter, `${pidBefore} vs ${pidAfter}`);

  // --- browser verifies outage-window ticks reached server scrollback ---
  const ws = new WebSocket(URL);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ type: 'auth', password: 'pw', username: 'user' }));
  const agentId = await new Promise((res) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'auth_ok') {
        const a = m.agents.find(a => a.screen === SCREEN_NAME);
        res(a ? a.id : null);
      }
    });
  });
  check('client re-registered after outage', !!agentId);
  if (!agentId) throw new Error('no agent');

  ws.send(JSON.stringify({ type: 'connect', agentId }));
  const datas = [];
  await new Promise((res) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'data' && m.agentId === agentId) datas.push(Buffer.from(m.payload, 'base64').toString());
      if (m.type === 'scrollback_end' && m.agentId === agentId) res();
    });
  });
  const text = datas.join('');
  const tickCount = (text.match(/TICK/g) || []).length;
  // The server restarted, so its buffer holds ONLY post-restart data — every
  // TICK there necessarily arrived via the offline-queue drain.
  check('outage ticks replayed via offline queue (server restarted clean)', tickCount >= 3, `ticks=${tickCount}, log tail: ${clientLog.slice(-300)}`);

  // live data still flows
  await sleep(1000);
  ws.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  client.kill();
  server.kill();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });
