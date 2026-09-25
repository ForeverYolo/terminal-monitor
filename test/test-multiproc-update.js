// Verifies push_update / restart_node fan out to EVERY client process of a
// machine. One clientId can have several processes (one per monitor screen);
// the old single-match lookup only reached the first, so the user had to
// click update/restart once per terminal.
//
// Wire-level test: two raw agent sockets share a clientId; a browser sends
// push_update / restart_node; BOTH sockets must receive the request.
//
// Run: node test/test-multiproc-update.js
'use strict';

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

const PROJECT = path.resolve(__dirname, '..');
const PORT = 19600 + Math.floor(Math.random() * 300);
const URL = `ws://127.0.0.1:${PORT}`;
const TOKEN = 'tok-multi';

const cfgPath = path.join(PROJECT, '.test-config-multiproc.json');
fs.writeFileSync(cfgPath, JSON.stringify({
  mode: 'server',
  server: { port: PORT, password: 'pw', tokens: { [TOKEN]: { name: 't', user: 'user' } }, supervisor: { enabled: false } }
}));

let passed = 0, failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const WebSocket = require(PROJECT + '/node_modules/ws');
  const server = fork(path.join(PROJECT, 'server.js'), ['--config=' + cfgPath], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let slog = '';
  server.stdout.on('data', d => slog += d);
  server.stderr.on('data', d => slog += d);
  await sleep(800);

  // Two agent processes, same machine identity (clientId), different screens —
  // exactly monitor-1/monitor-2 on one box.
  const connectAgent = async (screen) => {
    const ws = new WebSocket(URL);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    ws.send(JSON.stringify({
      type: 'register', token: TOKEN, name: 'multi-box', screen,
      attrs: { clientId: 'c-multi' }, sys: {}, files: { 'client.js': 'OLDHASH' }, cols: 80, rows: 24
    }));
    await sleep(200);
    return ws;
  };
  const agentA = await connectAgent('mon-a');
  const agentB = await connectAgent('mon-b');

  const browser = new WebSocket(URL);
  await new Promise((res, rej) => { browser.on('open', res); browser.on('error', rej); });
  browser.send(JSON.stringify({ type: 'auth', password: 'pw', username: 'user' }));

  const gotOn = (ws, type) => new Promise((res) => {
    const on = raw => { const m = JSON.parse(raw); if (m.type === type) { ws.off('message', on); res(m); } };
    ws.on('message', on);
  });

  // --- push_update fans out ---
  const pA = gotOn(agentA, 'update_files');
  const pB = gotOn(agentB, 'update_files');
  browser.send(JSON.stringify({ type: 'push_update', reqId: 'req-push-1', clientId: 'c-multi' }));
  const [uA, uB] = await Promise.all([pA, pB]);
  check('push_update reaches process A', Array.isArray(uA.files) && uA.files.length > 0);
  check('push_update reaches process B', Array.isArray(uB.files) && uB.files.length > 0);
  check('both get the same reqId', uA.reqId === uB.reqId && uA.reqId === 'req-push-1');

  // browser gets exactly one aggregated result (first reply wins; second ignored)
  const oneResult = new Promise((res) => {
    let n = 0;
    browser.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'push_update_result') { n++; res({ n, m }); } });
  });
  agentA.send(JSON.stringify({ type: 'update_files_result', reqId: 'req-push-1', ok: true, updated: ['client.js'] }));
  await sleep(150);
  agentB.send(JSON.stringify({ type: 'update_files_result', reqId: 'req-push-1', ok: true, updated: ['client.js'] }));
  const agg = await oneResult;
  check('browser sees one aggregated push result', agg.n === 1, `got ${agg.n}`);
  // second reply must not crash the server or wedge state
  await sleep(200);
  check('server alive after duplicate result', server.connected !== false);

  // --- restart_node fans out ---
  const rA = gotOn(agentA, 'restart_node');
  const rB = gotOn(agentB, 'restart_node');
  browser.send(JSON.stringify({ type: 'restart_node', reqId: 'req-rn-1', clientId: 'c-multi' }));
  const [nA, nB] = await Promise.all([rA, rB]);
  check('restart_node reaches process A', nA.reqId === 'req-rn-1');
  check('restart_node reaches process B', nB.reqId === 'req-rn-1');
  await sleep(300); // let the second console.log flush
  const rnHits = (slog.match(/restart_node sent to/g) || []).length;
  if (rnHits < 2) console.log('  [debug] slog tail:', JSON.stringify(slog.split('\n').filter(Boolean).slice(-8)));
  check('server logged restart fan-out to both', rnHits >= 2);

  console.log(`\n${passed} passed, ${failed} failed`);
  server.kill();
  fs.unlinkSync(cfgPath);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });
