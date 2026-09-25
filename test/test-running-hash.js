// Verifies the RUNNING-VERSION hash semantics introduced with the badge fix:
//   R (register)  = process-startup disk snapshot, frozen across reconnects
//   A (query_files) = fresh disk state at query time
// Scenario mirrors the field bug: deploy new client.js to disk, force a
// reconnect (server restart), badge must show 待应用 (R old, A new) — not 最新.
//
// Uses a REAL server + REAL client.js with a fake `screen` (no real screen).
// Run: node test/test-running-hash.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork, spawn } = require('child_process');

const PROJECT = path.resolve(__dirname, '..');
const PORT = 19400 + Math.floor(Math.random() * 400);
const URL = `ws://127.0.0.1:${PORT}`;
const TOKEN = 'tok-hash';
const SCREEN_NAME = 'fake-hash';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-hash-'));
const fakeScreen = path.join(tmpDir, 'screen');
fs.writeFileSync(fakeScreen, `#!/bin/bash\nwhile true; do sleep 1; done\n`, { mode: 0o755 });

const serverCfg = path.join(tmpDir, 'server-cfg.json');
fs.writeFileSync(serverCfg, JSON.stringify({
  mode: 'server',
  server: { port: PORT, password: 'pw', tokens: { [TOKEN]: { name: 't', user: 'user' } }, supervisor: { enabled: false } }
}));

// Client config: clientId is persisted INTO this file by client.js on first
// run, so re-running the client from the same config keeps a stable identity —
// exactly like production.
const clientCfg = path.join(tmpDir, 'client-cfg.json');
fs.writeFileSync(clientCfg, JSON.stringify({
  mode: 'client',
  client: { serverUrl: URL, token: TOKEN, name: 'hash-box', screen: SCREEN_NAME, attrs: {}, screenMode: 'reattach' }
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
function startClient() {
  const c = spawn(process.execPath, [path.join(PROJECT, 'client.js'), '--config=' + clientCfg], {
    cwd: PROJECT,
    env: { ...process.env, PATH: tmpDir + ':' + process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  c.logs = '';
  c.stdout.on('data', d => c.logs += d);
  c.stderr.on('data', d => c.logs += d);
  return c;
}

async function getAgentState(WebSocket, label, screen = SCREEN_NAME) {
  const ws = new WebSocket(URL);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ type: 'auth', password: 'pw', username: 'user' }));
  const a = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(label + ': no auth_ok')), 8000);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'auth_ok') {
        clearTimeout(t);
        res(m.agents.find(x => x.screen === screen) || null);
      }
    });
  });
  ws.close();
  return a;
}

async function main() {
  const WebSocket = require('ws');
  let server = startServer();
  await sleep(800);

  let client = startClient();
  await sleep(2500); // register with pre-edit disk hashes

  const before = await getAgentState(WebSocket, 'first');
  check('client registered', !!before);
  const R1 = before && before.runningHashes ? before.runningHashes['client.js'] : null;
  const A1 = before && before.fileHashes ? before.fileHashes['client.js'] : null;
  check('register R == disk A before any edit', R1 && A1 && R1 === A1);

  // --- deploy a local edit to client.js on disk (like a pull target machine) ---
  // Touch a COPY of the project so we don't mutate the real source tree.
  // Instead of copying the whole project, simulate by writing a scratch file
  // into FETCHABLE coverage? FETCHABLE files all live in PROJECT. Mutating the
  // real client.js during the test is too risky — instead append then restore,
  // with a try/finally guard, in a throwaway clone:
  const cloneDir = path.join(tmpDir, 'proj');
  fs.mkdirSync(cloneDir);
  for (const f of ['client.js', 'claude-detector.js', 'spawn-validator.js', 'config-loader.js', 'server.js', 'supervisor.js']) {
    fs.copyFileSync(path.join(PROJECT, f), path.join(cloneDir, f));
  }
  fs.mkdirSync(path.join(cloneDir, 'public'));
  for (const f of ['index.html', 'guide.html', 'favicon.svg']) {
    fs.copyFileSync(path.join(PROJECT, 'public', f), path.join(cloneDir, 'public', f));
  }
  // Clone needs ws/node-pty — symlink the real node_modules (read-only use).
  fs.symlinkSync(path.join(PROJECT, 'node_modules'), path.join(cloneDir, 'node_modules'));
  // Run the SECOND client from the clone with a local edit applied to client.js.
  // Its config is fresh (new clientId) so the two clients coexist cleanly.
  const cloneCfg = path.join(tmpDir, 'clone-cfg.json');
  fs.writeFileSync(cloneCfg, JSON.stringify({
    mode: 'client',
    client: { serverUrl: URL, token: TOKEN, name: 'clone-box', screen: 'clone-scr', attrs: {}, screenMode: 'reattach' }
  }));
  // Simulate an already-RUNNING old process: we cannot easily fake "process
  // started before the edit" with a fresh spawn — so instead we patch the
  // clone's client.js AFTER first computing its startup hashes: pre-seed the
  // runningFileHashes cache is not possible externally. The practical proxy:
  // edit clone's client.js on disk, then start clone. R (startup snapshot) and
  // A (query) will both be the EDITED file → equal. Then we EDIT AGAIN; A must
  // change while R stays frozen at the previous edit. That validates exactly
  // the freeze-vs-refresh split.
  fs.appendFileSync(path.join(cloneDir, 'client.js'), '\n// edit-1\n');
  const clone = spawn(process.execPath, [path.join(cloneDir, 'client.js'), '--config=' + cloneCfg], {
    cwd: cloneDir,
    env: { ...process.env, PATH: tmpDir + ':' + process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  clone.logs = '';
  clone.stdout.on('data', d => clone.logs += d);
  clone.stderr.on('data', d => clone.logs += d);
  await sleep(2500);

  const st1 = await getAgentState(WebSocket, 'clone-1', 'clone-scr');
  const R2 = st1 && st1.runningHashes ? st1.runningHashes['client.js'] : null;
  check('clone registered with edit-1 as R', !!R2);

  // --- edit-2 on disk, WITHOUT restart; query_files must see it, R must not ---
  fs.appendFileSync(path.join(cloneDir, 'client.js'), '\n// edit-2\n');
  // query_files fires every 60s server-side; poll state for up to 70s until A reflects edit-2.
  let st2 = null;
  for (let i = 0; i < 14; i++) {
    await sleep(5000);
    st2 = await getAgentState(WebSocket, 'clone-2', 'clone-scr');
    const A2 = st2 && st2.fileHashes ? st2.fileHashes['client.js'] : null;
    if (A2 && R2 && A2 !== R2) break;
  }
  const A2 = st2 && st2.fileHashes ? st2.fileHashes['client.js'] : null;
  const R2b = st2 && st2.runningHashes ? st2.runningHashes['client.js'] : null;
  check('A (query_files) sees edit-2 on disk', A2 && R2 && A2 !== R2, `A2=${A2 && A2.slice(0,8)} R2=${R2 && R2.slice(0,8)}`);
  check('R (register snapshot) frozen despite disk edit', R2b === R2);

  // --- reconnect: server restart. R must STILL be edit-1 (process never restarted) ---
  server.kill();
  await sleep(1500);
  server = startServer();
  await sleep(6000); // client reconnects + re-registers
  const st3 = await getAgentState(WebSocket, 'clone-3', 'clone-scr');
  const R3 = st3 && st3.runningHashes ? st3.runningHashes['client.js'] : null;
  check('R survives reconnect (still edit-1, not disk edit-2)', R3 === R2, `R3=${R3 && R3.slice(0,8)} expected R2=${R2 && R2.slice(0,8)}`);
  check('badge inputs now show 待应用 shape (R!=A, A fresh)', R3 && A2 && R3 !== A2);

  console.log(`\n${passed} passed, ${failed} failed`);
  clone.kill();
  client.kill();
  server.kill();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });
