// End-to-end test for the stable-terminal scrollback + incremental resume.
// Runs a real server on a random port and drives raw WebSocket clients that
// mimic agent.js and the browser. No PTY/screen needed — the "agent" sends
// synthetic data chunks.
//
// Scenario coverage:
//  1. agent registers, data flows, seq increments
//  2. agent reconnects → new agentId → SAME scrollback (stable key)
//  3. browser resume with sinceSeq → only chunks after the position (delta)
//  4. browser resume with stale sinceSeq (older than buffer head) → full mode
//  5. browser id-rotation path: watch old agentId, agents broadcast arrives,
//     client follows the new id via the stable key (browser-level logic is
//     mirrored here by design — the wire behaviour is what we can test here)
//  6. disconnect gap: data sent while no agent connected is queued client-side
//     and replayed on reconnect (verified by re-subscribing and checking the
//     buffered bytes contain the gap data)
const os = require('os');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

const PORT = 18234;
const URL = `ws://127.0.0.1:${PORT}`;
const TOKEN = 'test-token';

// Minimal config for the server under test
const cfgPath = path.join(__dirname, '..', '.test-config.json');
fs.writeFileSync(cfgPath, JSON.stringify({
  mode: 'server',
  server: {
    port: PORT,
    password: 'testpw',
    tokens: { [TOKEN]: { name: 't', user: 'user' } },
    supervisor: { enabled: false }
  }
}, null, 2));

const server = fork(path.join(__dirname, '..', 'server.js'), ['--config=' + cfgPath], {
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: { ...process.env, SWT_TEST: '1' }
});
let serverLog = '';
server.stdout.on('data', d => { serverLog += d.toString(); });
server.stderr.on('data', d => { serverLog += d.toString(); });

let WebSocket;
function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
function send(ws, obj) { ws.send(JSON.stringify(obj)); }
function next(ws, pred, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
    const onMsg = (raw) => {
      const m = JSON.parse(raw);
      if (pred(m)) { clearTimeout(timer); ws.off('message', onMsg); resolve(m); }
      else if (m.type === 'error') { clearTimeout(timer); ws.off('message', onMsg); reject(new Error('server error: ' + m.message)); }
    };
    ws.on('message', onMsg);
  });
}
async function collect(ws, until, timeoutMs = 8000) {
  // Collect messages until `until(m)` returns true; returns all matched 'data' payloads
  const datas = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout collecting')), timeoutMs);
    const onMsg = (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'data') datas.push(m);
      if (until(m)) { clearTimeout(timer); ws.off('message', onMsg); resolve(datas); }
    };
    ws.on('message', onMsg);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

async function main() {
  await sleep(800); // let server boot
  WebSocket = require('ws');

  // --- 1. agent registers and sends data ---
  const agent1 = await wsConnect(URL);
  send(agent1, { type: 'register', token: TOKEN, name: 'testbox', screen: 'mon', attrs: { clientId: 'c-test' }, sys: {}, files: {}, cols: 80, rows: 24 });
  await sleep(300);

  const chunk = (text) => Buffer.from(text).toString('base64');
  for (let i = 1; i <= 5; i++) send(agent1, { type: 'data', payload: chunk(`L${i}\n`) });
  await sleep(300);

  // --- browser A connects fresh, gets full replay ---
  const bA = await wsConnect(URL);
  send(bA, { type: 'auth', password: 'testpw', username: 'user' });
  const authOk = await next(bA, m => m.type === 'auth_ok');
  check('1a. browser sees agent', authOk.agents.length === 1);
  const agentId1 = authOk.agents[0].id;

  send(bA, { type: 'connect', agentId: agentId1 });
  const framesA = await collect(bA, m => m.type === 'scrollback_end' && m.agentId === agentId1);
  const lastFrame = framesA[framesA.length - 1];
  check('1b. full replay has 5 chunks', framesA.length === 5, `got ${framesA.length}`);
  check('1c. replay frames carry seq', typeof lastFrame.seq === 'number');
  const lastSeq1 = lastFrame.seq;

  // --- 2. agent reconnects: new id, same buffer ---
  agent1.close();
  await sleep(400);
  const agent2 = await wsConnect(URL);
  send(agent2, { type: 'register', token: TOKEN, name: 'testbox', screen: 'mon', attrs: { clientId: 'c-test' }, sys: {}, files: {}, cols: 80, rows: 24 });
  await sleep(300);
  for (let i = 6; i <= 8; i++) send(agent2, { type: 'data', payload: chunk(`L${i}\n`) });
  await sleep(300);

  const bB = await wsConnect(URL);
  send(bB, { type: 'auth', password: 'testpw', username: 'user' });
  const authOk2 = await next(bB, m => m.type === 'auth_ok');
  const agentId2 = authOk2.agents.find(a => a.id !== agentId1).id;
  check('2a. reconnect yields a NEW agentId', agentId2 !== agentId1);

  send(bB, { type: 'connect', agentId: agentId2 });
  const framesB = await collect(bB, m => m.type === 'scrollback_end' && m.agentId === agentId2);
  check('2b. buffer SURVIVED reconnect (8 chunks)', framesB.length === 8, `got ${framesB.length}`);
  const textB = framesB.map(f => Buffer.from(f.payload, 'base64').toString()).join('');
  check('2c. full history L1..L8', textB.includes('L1') && textB.includes('L8'));

  // --- 3. incremental resume from position 5 ---
  const pos5 = framesA[4].seq;
  const bC = await wsConnect(URL);
  send(bC, { type: 'auth', password: 'testpw', username: 'user' });
  await next(bC, m => m.type === 'auth_ok');
  send(bC, { type: 'connect', agentId: agentId2, resume: true, sinceSeq: pos5 });
  const framesC = await collect(bC, m => m.type === 'scrollback_end' && m.agentId === agentId2);
  const textC = framesC.map(f => Buffer.from(f.payload, 'base64').toString()).join('');
  const infoC = framesC.find(f => false); // infos not collected by collect() (data-only) — infer from text
  check('3a. delta replay only sends chunks after sinceSeq', textC === 'L6\nL7\nL8\n', JSON.stringify(textC));

  // --- 4. stale sinceSeq (older than buffer head) → tail append, NO clear ---
  // Fill enough data to push L1 out? Not needed: buffer starts at L1, ask from before L1.
  const bD = await wsConnect(URL);
  send(bD, { type: 'auth', password: 'testpw', username: 'user' });
  await next(bD, m => m.type === 'auth_ok');
  let modeD = null;
  bD.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'scrollback_info' && m.agentId === agentId2) modeD = m.mode; });
  send(bD, { type: 'connect', agentId: agentId2, resume: true, sinceSeq: 1 });
  const framesD = await collect(bD, m => m.type === 'scrollback_end' && m.agentId === agentId2);
  const textD = framesD.map(f => Buffer.from(f.payload, 'base64').toString()).join('');
  // tail mode: the browser keeps its own history and we append what we still
  // have. A raw socket has no local history, so the appended window (L1..L8)
  // must be intact — and the mode must be 'tail', not the history-erasing 'full'.
  check('4a. stale position falls back to TAIL (append, no clear)', modeD === 'tail', `mode=${modeD}`);
  check('4b. tail window content intact', textD.includes('L1') && textD.includes('L8'), JSON.stringify(textD.slice(0, 40)));

  // --- 4c. server-restart shape: resume against an EMPTY buffer → tail, zero
  // data. The browser's local history is the only copy left; sending a full
  // clear here (old behaviour) erased it — the "history is gone" field bug.
  const agentEmpty = await wsConnect(URL);
  send(agentEmpty, { type: 'register', token: TOKEN, name: 'testbox', screen: 'mon-empty', attrs: { clientId: 'c-test' }, sys: {}, files: {}, cols: 80, rows: 24 });
  await sleep(300);
  const bG = await wsConnect(URL);
  send(bG, { type: 'auth', password: 'testpw', username: 'user' });
  await next(bG, m => m.type === 'auth_ok');
  const emptyId = (await next(bG, m => m.type === 'agents' && m.agents.some(a => a.screen === 'mon-empty'))).agents.find(a => a.screen === 'mon-empty').id;
  let modeG = null, infoGTotal = null;
  bG.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'scrollback_info' && m.agentId === emptyId) { modeG = m.mode; infoGTotal = m.total; } });
  send(bG, { type: 'connect', agentId: emptyId, resume: true, sinceSeq: 999999 });
  await collect(bG, m => m.type === 'scrollback_end' && m.agentId === emptyId);
  check('4c. resume on empty buffer → tail, sends nothing (history preserved)', modeG === 'tail' && infoGTotal === 0, `mode=${modeG} total=${infoGTotal}`);

  // --- 5. agents broadcast carries the stable key resolution data ---
  const bE = await wsConnect(URL);
  send(bE, { type: 'auth', password: 'testpw', username: 'user' });
  const authOk5 = await next(bE, m => m.type === 'auth_ok');
  const a5 = authOk5.agents.find(a => a.id === agentId2);
  check('5a. agents list has clientId+screen for stable key', a5 && a5.attrs.clientId === 'c-test' && a5.screen === 'mon');

  // --- 6. gap data: close agent, keep sending client-side impossible without client.js; instead verify queue replay via raw socket ---
  // Simulate the client offline queue: agent disconnects, data produced offline
  // can't reach the server; on reconnect the CLIENT replays it. That is client
  // behaviour tested in test-local; here we verify the server accepts data
  // right after register (queue drain works server-side by design — same
  // 'data' handler).
  agent2.close();
  await sleep(400);
  const agent3 = await wsConnect(URL);
  send(agent3, { type: 'register', token: TOKEN, name: 'testbox', screen: 'mon', attrs: { clientId: 'c-test' }, sys: {}, files: {}, cols: 80, rows: 24 });
  await sleep(200);
  // immediate data right after register (like queue drain)
  send(agent3, { type: 'data', payload: chunk('GAP1\n') });
  await sleep(400);
  const bF = await wsConnect(URL);
  send(bF, { type: 'auth', password: 'testpw', username: 'user' });
  await next(bF, m => m.type === 'auth_ok');
  const agentId3 = (await next(bF, m => (m.type === 'auth_ok' || m.type === 'agents') && m.agents.some(a => a.screen === 'mon'), 12000)).agents.find(a => a.screen === 'mon').id;
  send(bF, { type: 'connect', agentId: agentId3, resume: true, sinceSeq: lastSeq1 });
  const framesF = await collect(bF, m => m.type === 'scrollback_end' && m.agentId === agentId3);
  const textF = framesF.map(f => Buffer.from(f.payload, 'base64').toString()).join('');
  check('6a. post-reconnect data (queue drain) is buffered & replayable', textF.includes('L6') && textF.includes('GAP1'), JSON.stringify(textF.slice(-30)));

  // --- live forwarding still works after replay ---
  let liveReceived = null;
  const onLive = (raw) => { const m = JSON.parse(raw); if (m.type === 'data' && m.agentId === agentId3) liveReceived = Buffer.from(m.payload, 'base64').toString(); };
  bF.on('message', onLive);
  send(agent3, { type: 'data', payload: chunk('LIVE!\n') });
  await sleep(500);
  bF.off('message', onLive);
  check('7a. live forwarding works post-replay', liveReceived === 'LIVE!\n', JSON.stringify(liveReceived));

  console.log(`\n${passed} passed, ${failed} failed`);
  server.kill();
  fs.unlinkSync(cfgPath);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('TEST ERROR:', e.message);
  console.error('--- server log ---\n' + serverLog.slice(-2000));
  server.kill();
  process.exit(1);
});
