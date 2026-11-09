'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');
const { createHookReceiver, socketPath } = require('../cli-hooks');
const { screenProcesses } = require('../cli-process');
const { CliTracker } = require('../cli-tracker');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-cli-hooks-'));
const screen = `swt-hooks-${process.pid}`;
const tracker = new CliTracker();
const events = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await delay(80); } throw Error('hook test timeout'); }
let receiver;
(async () => {
  receiver = await createHookReceiver(screen, event => { const accepted = tracker.event(event, screenProcesses(screen)); events.push({event, accepted}); return accepted; });
  assert.equal(fs.statSync(receiver.socket).mode & 0o777, 0o600);
  assert.equal(socketPath('123.' + screen), receiver.socket);
  await assert.rejects(createHookReceiver(screen, () => true), /Another monitor/);
  // A disposable CLI process invokes the REAL generated hook command in GNU
  // Screen. No model calls; exercises ancestry, STY, /proc and socket transport.
  fs.symlinkSync(process.execPath, path.join(temp, 'codex'));
  const script = path.join(temp, 'fixture.js');
  fs.writeFileSync(script, `const fs=require('fs'),cp=require('child_process');\nconst events=['SessionStart','UserPromptSubmit','PermissionRequest','PostToolUse','Stop'];\nfor(const name of events){cp.execFileSync(${JSON.stringify(process.execPath)},[${JSON.stringify(path.join(root,'cli-hook.js'))},'codex'],{input:JSON.stringify({hook_event_name:name,session_id:'socket-session',turn_id:name==='SessionStart'?undefined:'turn-1',prompt:'PRIVATE MUST NOT LEAVE HOOK',tool_input:{secret:'PRIVATE'}})});}\nfs.writeFileSync(${JSON.stringify(path.join(temp,'ready'))},'yes');setInterval(()=>{},1000);`);
  execFileSync('screen', ['-c', '/dev/null', '-dmS', screen, path.join(temp, 'codex'), script]);
  await until(() => fs.existsSync(path.join(temp, 'ready')));
  assert.equal(events.length, 5);
  assert(events.every(e => e.accepted), JSON.stringify(events));
  assert(!JSON.stringify(events).includes('PRIVATE'), 'hook must not forward prompt/tool inputs');
  assert.equal(tracker.state.app, 'codex'); assert.equal(tracker.state.source, 'hooks');
  assert.equal(tracker.state.status, 'unknown', 'Stop waits for final screen');
  const result = await new Promise(resolve => {
    const client = net.createConnection(receiver.socket, () => client.write(JSON.stringify({...events[0].event,pid:1})+'\n'));
    client.on('data', d => resolve(JSON.parse(d).ok)); client.on('error', e => {throw e;});
  });
  assert.equal(result, false, 'foreign ancestry rejected');
  // Closing one screen cannot mutate another monitor's state.
  execFileSync('screen', ['-S', screen, '-X', 'quit']);
  tracker.screen([], screenProcesses(screen) || {clis: []});
  assert.equal(tracker.state.isCodeCli, false);
  const staging = path.join(temp,'terminal-monitor-staging'), sandbox = path.join(staging,'runtime/sandbox');
  fs.mkdirSync(path.join(staging,'runtime/codex-home'),{recursive:true});
  fs.mkdirSync(path.join(sandbox,'.claude'),{recursive:true});
  fs.symlinkSync(root,path.join(staging,'current'));
  fs.writeFileSync(path.join(staging,'runtime/codex-command.json'),JSON.stringify(['env','CODEX_HOME='+path.join(staging,'runtime/codex-home'),'codex','resume','fixture','-C',sandbox]));
  const local = path.join(sandbox,'.claude/settings.local.json');
  fs.writeFileSync(local,JSON.stringify({env:{KEEP:'yes'},hooks:{UserPromptSubmit:[{hooks:[{type:'command',command:'echo keep-existing-hook'}]}]}}));
  for(let i=0;i<2;i++) execFileSync(process.execPath,[path.join(root,'infra/staging/enable-state-hooks.js'),staging]);
  const installed = JSON.parse(fs.readFileSync(local));
  assert.equal(installed.env.KEEP,'yes');
  assert.equal(installed.hooks.UserPromptSubmit.length,2,'scoped setup preserves existing hooks and is idempotent');
  assert.equal(installed.hooks.UserPromptSubmit[0].hooks[0].command,'echo keep-existing-hook');
  console.log('PASS real Screen → command hook → private socket → bound tracker; privacy, ownership and exit');
  console.log('PASS scoped staging hook setup preserves settings and existing hooks without duplicate registrations');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  if (receiver) receiver.close();
  try { execFileSync('screen', ['-S', screen, '-X', 'quit'], {stdio:'ignore'}); } catch {}
  fs.rmSync(temp, {recursive:true,force:true});
});
