'use strict';
// An unknown executable, real Screen and the real monitor. No hooks/model calls.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync, spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { screenProcesses } = require('../cli-process');
const root = path.resolve(__dirname, '..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-generic-cli-'));
const name = 'swt-generic-' + process.pid, states = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await delay(100); } throw Error('generic CLI test timeout'); }
let client, server, log = '';
(async () => {
  const executable = path.join(temp, 'starlight'), fixture = path.join(temp, 'fixture.js'), phase = path.join(temp, 'phase');
  fs.symlinkSync(process.execPath, executable);
  fs.writeFileSync(phase, 'plain');
  fs.writeFileSync(fixture, `const fs=require('fs');let previous;setInterval(()=>{const phase=fs.readFileSync(${JSON.stringify(phase)},'utf8');if(phase===previous)return;previous=phase;if(phase==='exit')process.exit(0);const lines=phase==='plain'?['Ordinary application output']:['',phase==='working'?'⠋ Processing... (esc to cancel, 2s)':'','Enter to submit · Esc to cancel','====================','» Build a project','====================','model: example-v1 | context 38%'];process.stdout.write(${JSON.stringify('\x1b[2J\x1b[H')}+lines.join(${JSON.stringify('\r\n')}));},100);`);
  const runner = path.join(temp, 'run.sh');
  // The shell remains in the Screen after the disposable unknown CLI exits.
  fs.writeFileSync(runner, '#!/bin/bash\n"$1" "$2"\nexec bash --noprofile --norc\n');
  execFileSync('screen', ['-U', '-c', '/dev/null', '-dmS', name, 'bash', runner, executable, fixture], {cwd: temp});
  await until(() => screenProcesses(name)?.foreground.length === 1);
  const processes = screenProcesses(name);
  assert.equal(processes.clis.length, 0); assert.equal(processes.foreground[0].appName, 'starlight');
  server = new WebSocketServer({port: 0, host: '127.0.0.1'}); await new Promise(r => server.on('listening', r));
  server.on('connection', ws => ws.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'cli_state') states.push(m.state); if (m.type === 'register') ws.send(JSON.stringify({type: 'release_registered'})); if (m.type === 'ping') ws.send(JSON.stringify({type: 'pong'})); }));
  const config = path.join(temp, 'config.json'); fs.writeFileSync(config, JSON.stringify({client: {serverUrl: 'ws://127.0.0.1:' + server.address().port, token: 'fixture', name: 'Generic CLI fixture', screen: name}}), {mode: 0o600});
  const env = {...process.env}; for (const k of ['SWT_WORKER', 'SWT_INSTALL_ROOT', 'SWT_RELEASE_ID']) delete env[k];
  client = spawn(process.execPath, [path.join(root, 'client.js'), '--config=' + config], {cwd: root, env});
  client.stdout.on('data', d => log += d); client.stderr.on('data', d => log += d);
  await until(() => states.length); assert(!states.at(-1).isCodeCli, 'unknown process alone is insufficient');
  fs.writeFileSync(phase, 'working');
  await until(() => states.at(-1)?.status === 'working');
  assert.equal(states.at(-1).app, 'generic'); assert.equal(states.at(-1).appName, 'starlight'); assert.equal(states.at(-1).source, 'screen');
  fs.writeFileSync(phase, 'idle'); await until(() => states.at(-1)?.status === 'idle');
  assert(!states.at(-1).hookSetup, 'an unknown CLI has no specialized hooks setup');
  fs.writeFileSync(phase, 'exit'); await until(() => !states.at(-1)?.isCodeCli);
  assert(screenProcesses(name), 'return to shell preserves the task Screen');
  console.log('PASS unknown process alone hidden → generic UI detected → process name applied → working/idle → shell hidden');
})().catch(e => { console.error(e, log.slice(-2000)); process.exitCode = 1; }).finally(() => {
  client?.kill(); if (server) { for (const ws of server.clients) ws.terminate(); server.close(); }
  try { execFileSync('screen', ['-S', name, '-X', 'quit'], {stdio: 'ignore'}); } catch {}
  fs.rmSync(temp, {recursive: true, force: true});
});
