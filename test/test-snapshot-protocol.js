'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const WebSocket = require('ws');
const { Terminal } = require('xterm-headless');
const { TerminalState } = require('../terminal-state');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-snapshot-'));
const port = 19000 + Math.floor(Math.random() * 1000);
const cfg = path.join(dir, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ mode: 'server', server: {
  port, password: 'pw', tokens: { token: { user: 'user' } }, supervisor: { enabled: false }
}}));
const server = fork(path.resolve(__dirname, '..', 'server.js'), ['--config=' + cfg], {stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
let serverLog = '';
server.stdout.on('data', x => serverLog += x);
server.stderr.on('data', x => serverLog += x);
const url = `ws://127.0.0.1:${port}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const send = (ws, msg) => ws.send(JSON.stringify(msg));
function connect() { return new Promise((resolve, reject) => {
  const ws = new WebSocket(url); ws.on('open', () => resolve(ws)); ws.on('error', reject);
}); }
function until(ws, predicate) { return new Promise((resolve, reject) => {
  const timer = setTimeout(() => { ws.off('message', receive); reject(new Error('timeout: ' + serverLog.slice(-500))); }, 6000);
  function receive(raw) { const msg = JSON.parse(raw); if (predicate(msg)) { clearTimeout(timer); ws.off('message', receive); resolve(msg); } }
  ws.on('message', receive);
}); }
function collect(ws, trigger) { return new Promise((resolve, reject) => {
  const messages = [];
  const timer = setTimeout(() => { ws.off('message', receive); reject(new Error('timeout: ' + serverLog.slice(-500))); }, 6000);
  function receive(raw) {
    const msg = JSON.parse(raw); messages.push(msg);
    if (msg.type === 'scrollback_end') { clearTimeout(timer); ws.off('message', receive); resolve(messages); }
  }
  ws.on('message', receive); trigger();
}); }
function write(term, data) { return new Promise(resolve => term.write(data, resolve)); }
function contents(term) { const b = term.buffer.active; return Array.from({length: b.length}, (_, i) => b.getLine(i).translateToString(true)); }

(async () => {
  await sleep(500);
  const agent = await connect();
  const model = new TerminalState(40, 8, payload => send(agent, {type: 'data', payload, filtered: true}));
  agent.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.type === 'terminal_snapshot_request') {
      model.write('raced-before-anchor\r\n');
      model.snapshot(snapshot => send(agent,
        {type: 'terminal_snapshot_result', reqId: msg.reqId, ...snapshot}));
    }
  });
  send(agent, {type: 'register', token: 'token', name: 'box', screen: 's', attrs: {clientId: 'c'},
    sys: {}, files: {}, snapshotV1: true});
  for (let i = 0; i < 60; i++) model.write(`line-${i}\r\n`);
  model.write('\x1b[3A\x1b[2K\x1b[5CX');
  await sleep(300);

  const browser = await connect();
  send(browser, {type: 'auth', password: 'pw', username: 'user'});
  const auth = await until(browser, m => m.type === 'auth_ok');
  const id = auth.agents[0].id;
  const receivedData = [];
  browser.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.type === 'data') receivedData.push(Buffer.from(msg.payload, 'base64').toString());
  });
  const first = await collect(browser, () => send(browser, {type: 'connect', agentId: id}));
  const snap = first.find(m => m.type === 'terminal_snapshot');
  assert(snap, 'fresh connect did not receive snapshot');
  assert(!first.some(m => m.type === 'data'), 'fresh connect replayed raw chunks');
  await sleep(100);
  assert(!receivedData.some(s => s.includes('raced-before-anchor')), 'anchor output was duplicated after snapshot');
  const restored = new Terminal({allowProposedApi: true, cols: snap.cols, rows: snap.rows, scrollback: 5000});
  await write(restored, Buffer.from(snap.payload, 'base64'));
  assert(contents(restored).some(s => s.includes('line-5')), 'history was cut off');
  assert.deepStrictEqual(contents(restored), contents(model.term));

  const live = until(browser, m => m.type === 'data' && m.agentId === id);
  model.write('\x1b[2A\x1b[8Ctail');
  const frame = await live;
  assert(frame.filtered);
  await write(restored, Buffer.from(frame.payload, 'base64'));
  await new Promise(resolve => model.term.write('', resolve));
  assert.deepStrictEqual(contents(restored), contents(model.term));

  browser.close();
  await sleep(100);
  model.write('delta\r\n');
  const resumed = await connect();
  send(resumed, {type: 'auth', password: 'pw', username: 'user'});
  await until(resumed, m => m.type === 'auth_ok');
  const delta = await collect(resumed, () => send(resumed, {type: 'connect', agentId: id, resume: true, sinceSeq: frame.seq}));
  assert(delta.some(m => m.type === 'data'), 'continuous resume did not send delta');
  assert(!delta.some(m => m.type === 'terminal_snapshot'), 'continuous resume used snapshot');
  const stale = await collect(resumed, () => send(resumed, {type: 'connect', agentId: id, resume: true, sinceSeq: 1}));
  assert(stale.some(m => m.type === 'terminal_snapshot'), 'gap did not trigger snapshot');
  assert(!stale.some(m => m.type === 'data'), 'gap appended raw tail');
  console.log('snapshot, live continuation, delta resume, and gap recovery passed');
  resumed.close(); agent.close(); restored.dispose(); model.dispose();
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  server.kill(); fs.rmSync(dir, {recursive: true, force: true});
});
