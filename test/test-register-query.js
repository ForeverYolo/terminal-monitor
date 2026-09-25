// Verifies the post-register query_files kick: register上报的 fileHashes 是
// 进程启动时的磁盘快照，机器是版本源（或磁盘刚被改过）时 A 会滞后最长一个
// 60s 的 query_files 周期，徽章在此窗口误报 待更新。服务器必须在注册后几秒
// 内主动补发一次 query_files，把 A 拉到真实磁盘状态。
//
// Wire-level: 一个 raw agent socket 注册后，应在 ~5s 内收到 query_files。
// Run: node test/test-register-query.js
'use strict';

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

const PROJECT = path.resolve(__dirname, '..');
const PORT = 19700 + Math.floor(Math.random() * 300);
const URL = `ws://127.0.0.1:${PORT}`;
const TOKEN = 'tok-regq';

const cfgPath = path.join(PROJECT, '.test-config-regq.json');
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
  await sleep(800);

  const ws = new WebSocket(URL);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

  // 注册后立刻计时——修复要求 query_files 在几秒内到达，而不是等 60s 心跳。
  const t0 = Date.now();
  let qfAt = null, hbAt = null;
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type === 'query_files' && qfAt === null) {
      // 第一个到的可能是别的时机触发的；记录时间戳即可
      if (Date.now() - t0 < 30000) qfAt = Date.now() - t0;
    }
  });

  ws.send(JSON.stringify({
    type: 'register', token: TOKEN, name: 'regq-box', screen: 'scr',
    attrs: { clientId: 'c-regq' }, sys: {}, files: { 'client.js': 'OLDHASH' }, cols: 80, rows: 24
  }));

  await sleep(6000);
  check('query_files arrives shortly after register', qfAt !== null && qfAt < 5000, `at=${qfAt}ms`);

  console.log(`\n${passed} passed, ${failed} failed`);
  server.kill();
  fs.unlinkSync(cfgPath);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });
