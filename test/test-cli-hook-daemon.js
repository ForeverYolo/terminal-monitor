'use strict';
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn, execFileSync } = require('child_process');
const { createHookReceiver } = require('../cli-hooks');
const { screenProcesses } = require('../cli-process');
const { CliTracker } = require('../cli-tracker');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-hook-daemon-'));
const screens = [], receivers = [], daemons = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await delay(40); } throw Error('daemon hook test timeout'); }
(async () => {
  const project = path.join(temp, 'project'), other = path.join(temp, 'other');
  for (const directory of [project, other, path.join(temp, '.codex')]) fs.mkdirSync(directory);
  const env = { ...process.env, HOME: temp, CODEX_HOME: path.join(temp, '.codex') };
  fs.symlinkSync(process.execPath, path.join(temp, 'codex'));
  const foreground = path.join(temp, 'foreground.js'); fs.writeFileSync(foreground, 'setInterval(()=>{},1000)');
  const received = [];
  async function screen(suffix, cwd, monitored = true, cd = false) {
    const name = `swt-daemon-${process.pid}-${suffix}`; screens.push(name);
    if (monitored) {
      const tracker = new CliTracker();
      receivers.push(await createHookReceiver(name, event => {
        const accepted = tracker.event(event, screenProcesses(name)); received.push({ name, event, accepted }); return accepted;
      }));
    }
    execFileSync('screen', ['-c', '/dev/null', '-dmS', name, path.join(temp, 'codex'), foreground, ...(cd ? ['-C', cwd] : [])], { cwd: cd ? temp : cwd, env });
    await until(() => screenProcesses(name)?.clis.length === 1);
    return name;
  }
  const target = await screen('target', project, true, true), wrong = await screen('wrong', other);
  const runner = path.join(temp, 'app-server'), job = path.join(temp, 'job'), done = path.join(temp, 'done');
  fs.writeFileSync(runner, `const fs=require('fs'),cp=require('child_process');setInterval(()=>{if(!fs.existsSync(${JSON.stringify(job)}))return;const input=fs.readFileSync(${JSON.stringify(job)},'utf8');fs.unlinkSync(${JSON.stringify(job)});cp.execFileSync(${JSON.stringify(process.execPath)},[${JSON.stringify(path.join(root,'cli-hook.js'))},'codex'],{input,env:process.env});fs.writeFileSync(${JSON.stringify(done)},'yes');},20);`);
  // Executable argv[1] must match the real daemon subcommand.
  fs.symlinkSync(runner, path.join(project, 'app-server'));
  const actual = spawn(path.join(temp, 'codex'), ['app-server', '--managed-daemon'], { cwd: project, env: { ...env, STY: wrong }, stdio: 'ignore' }); daemons.push(actual);
  async function send(extra = {}) {
    fs.rmSync(done, { force: true });
    fs.writeFileSync(job, JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'daemon-session', cwd: project, prompt: 'PRIVATE', tool_input: { secret: 'PRIVATE' }, ...extra }));
    await until(() => fs.existsSync(done));
  }
  await send();
  assert.equal(received.length, 1); assert.equal(received[0].name, target); assert(received[0].accepted);
  assert(!JSON.stringify(received).includes('PRIVATE'));
  await send({ agent_id: 'child' }); assert.equal(received.length, 1, 'subagent ignored');
  await send({ cwd: other }); assert.equal(received.length, 1, 'payload cwd must equal execution cwd');
  await send({ cwd: undefined }); assert.equal(received.length, 1, 'missing cwd cannot use stale STY');
  await screen('ambiguous', project, false);
  await send(); assert.equal(received.length, 1, 'even an unmonitored duplicate makes the project ambiguous');
  execFileSync(process.execPath, [path.join(root, 'cli-hook.js'), 'codex'], { cwd: project, env: { ...env, STY: target }, input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'foreign', cwd: project }) });
  assert.equal(received.length, 1, 'ordinary shell cannot use daemon routing');
  console.log('PASS shared daemon → unique foreground Codex; stale STY, -C, ambiguity, subagent and privacy checks');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  for (const daemon of daemons) daemon.kill();
  for (const receiver of receivers) receiver.close();
  for (const name of screens) try { execFileSync('screen', ['-S', name, '-X', 'quit'], { stdio: 'ignore' }); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
