'use strict';
// Explicit opt-in: sends ONE short, tool-free model prompt per selected CLI.
// All sessions/configuration are disposable. Never runs in npm test/test:all.
if (process.env.RUN_LIVE_CLI_HOOK_TEST !== '1') {
  console.log('SKIP live CLI hooks; set RUN_LIVE_CLI_HOOK_TEST=1 to make model requests'); process.exit(0);
}
const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const pty = require('node-pty');
const { TerminalState } = require('../terminal-state');
const { CliTracker } = require('../cli-tracker');
const { createHookReceiver } = require('../cli-hooks');
const { screenProcesses } = require('../cli-process');
const { prepareScreenTerminal } = require('../screen-terminal');
const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 90000) { const end = Date.now()+ms; while(Date.now()<end) { if(fn())return; await delay(150); } throw Error('live CLI hook timeout'); }
async function verify(app) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-live-hooks-'));
  const screen = `swt-live-${app}-${process.pid}`;
  let receiver, display, term, timer;
  let diagnostics = () => ({});
  try {
    const cwd = path.join(temp, 'sandbox'); fs.mkdirSync(cwd); execFileSync('git', ['init','-q',cwd]);
    const hookConfig = JSON.parse(execFileSync(process.execPath, [path.join(root,'cli-hook.js'),app,'--print-config'], {encoding:'utf8'}));
    const env = {...process.env,LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TERM:'xterm-256color',COLORTERM:'truecolor'};
    delete env.NO_COLOR;
    let args;
    if (app === 'codex') {
      args = require('./fixtures/codex-history')(path.join(temp,'codex-home'),cwd);
      args.splice(4,0,'--dangerously-bypass-hook-trust');
      fs.writeFileSync(path.join(temp,'codex-home','hooks.json'),JSON.stringify(hookConfig),{mode:0o600});
    } else {
      // Copy provider/auth environment only; never load user hooks/plugins or
      // print credentials. Nothing from this scoped file enters test artifacts.
      const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(),'.claude/settings.json')));
      for (const [key,value] of Object.entries(settings.env || {})) if (/^(?:ANTHROPIC_|CLAUDE_CODE_(?:USE_|EFFORT_|DISABLE_))/.test(key)) env[key] = String(value);
      if (typeof settings.apiKeyHelper === 'string') hookConfig.apiKeyHelper = settings.apiKeyHelper;
      const localDir = path.join(cwd,'.claude');fs.mkdirSync(localDir);
      fs.writeFileSync(path.join(localDir,'settings.local.json'),JSON.stringify({hooks:hookConfig.hooks}),{mode:0o600});
      const scoped = path.join(temp,'settings.json');fs.writeFileSync(scoped,JSON.stringify({apiKeyHelper:hookConfig.apiKeyHelper}),{mode:0o600});
      delete env.COLORTERM;
      args = ['env','TERM=screen-256color','claude','--setting-sources','project,local','--settings',scoped,'--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools',''];
    }
    const tracker = new CliTracker(), events = [], transitions = [];
    diagnostics = () => ({ state: tracker.state, events, transitions, viewport: term?.readScreen().filter(l=>l.trim()).slice(-12).map(l=>l.replaceAll(temp,'<test-dir>')) });
    let lastProcessAt = 0, procs = null;
    const sample = () => {
      if (!term || term.pending || term.blocked) return;
      if (Date.now()-lastProcessAt>500) {procs=screenProcesses(screen);lastProcessAt=Date.now();}
      const state=tracker.screen(term.readScreen(),procs);
      if (transitions.at(-1)?.status!==state.status || transitions.at(-1)?.source!==state.source) transitions.push({status:state.status,source:state.source});
    };
    receiver = await createHookReceiver(screen, event => {
      const accepted = tracker.event(event,screenProcesses(screen));
      events.push({event:event.event,accepted});sample();return accepted;
    });
    execFileSync('screen',['-U','-c','/dev/null','-dmS',screen,...args],{cwd,env});
    const name = prepareScreenTerminal();display=pty.spawn('screen',['-x',screen],{cwd,env:{...env,TERM:name},name,cols:120,rows:40});
    term=new TerminalState(120,40,()=>{});term.term.onData(d=>display.write(d));display.onData(d=>term.write(d));timer=setInterval(sample,150);
    let trusted=false;
    await until(()=>{
      const frame=term.readScreen().join('\n');
      if (!trusted && /Trust folder|Yes, I trust this folder|Yes, proceed/.test(frame)) {display.write('\r');trusted=true;return false;}
      return tracker.state.isCodeCli && (tracker.state.status==='idle' || (app==='claude' && /Not logged in/.test(frame) && /\? for shortcuts/.test(frame)));
    },30000);
    display.write('Reply with exactly CLI_HOOK_OK. Do not use any tools.');await delay(250);display.write('\r');
    await until(()=>events.some(e=>e.event==='Stop'&&e.accepted));
    await until(()=>tracker.state.status==='idle'&&tracker.state.source==='hooks',15000);
    assert(events.some(e=>e.event==='UserPromptSubmit'&&e.accepted));
    assert(transitions.some(s=>s.status==='working'&&s.source==='hooks'));
    assert.equal(tracker.state.app,app);
    if(app==='claude') {
      const b=term.term.buffer.active;let colored=0;
      for(let y=0;y<term.term.rows;y++)for(let x=0;x<term.term.cols;x++){const c=b.getLine(b.baseY+y)?.getCell(x);if(c?.getChars() && !c.isFgDefault())colored++;}
      assert(colored>0,'Claude must render ANSI colour when NO_COLOR is removed');
      console.log('PASS Claude project-local hooks and 256-colour rendering', {coloredCells:colored});
    }
    console.log('PASS live '+app+' hooks → working → Stop → parsed idle',JSON.stringify({events,transitions}));
  } catch (error) {
    console.error(app, JSON.stringify(diagnostics())); throw error;
  } finally {
    clearInterval(timer);if(receiver)receiver.close();if(display)display.kill();if(term)term.dispose();
    try{execFileSync('screen',['-S',screen,'-X','quit'],{stdio:'ignore'});}catch{}
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
(async()=>{for(const app of process.argv.slice(2).length?process.argv.slice(2):['codex','claude'])await verify(app);})().catch(e=>{console.error(e.message);process.exitCode=1;});
