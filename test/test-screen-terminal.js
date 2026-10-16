'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const pty = require('node-pty');
const { Terminal } = require('xterm-headless');
const { prepareScreenTerminal, SCREEN_TERM } = require('../screen-terminal');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-screen-style-'));
const session = `swt-screen-style-${process.pid}`;
// Screen uses the account's real home for capability lookup, even when a
// caller supplies a temporary HOME. Install only our uniquely named entry.
const env = { ...process.env, TERM: 'xterm-256color' };
const displays = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i=0;i<100;i++) { if (fn()) return; await delay(50); }
  throw Error('Screen style check timed out');
}
function attach(term) {
  const model = new Terminal({allowProposedApi:true,cols:100,rows:12});
  const child = pty.spawn('screen',['-x',session],{name:term,cols:100,rows:12,env:{...env,TERM:term}});
  const display = {model,child,updates:0,styles:null,raw:''};
  child.onData(raw => {
    display.raw += raw;
    model.write(raw, () => {
      const b=model.buffer.active;
      for (let i=b.baseY;i<b.length;i++) {
        const line=b.getLine(i),text=line.translateToString(true);
        if (!text.includes('Italic') || !text.includes('DONE')) continue;
        display.styles=Object.fromEntries(['Italic','Inverse','Both','Plain'].map(word=>{
          const cell=line.getCell(text.indexOf(word));
          return [word,[!!cell.isItalic(),!!cell.isInverse()]];
        }));
        display.updates++;
      }
    });
  });
  displays.push(display); return display;
}
(async()=>{
  // Create the task before installing the capability entry. The fix must work
  // on an already-running server, without a new screenrc or task restart.
  execFileSync('screen',['-c','/dev/null','-dmS',session,'bash','-c',
    "i=0; while true; do i=$((i+1)); printf '\\033[H\\033[2J\\033[3mItalic\\033[23m \\033[7mInverse\\033[27m \\033[3;7mBoth\\033[0m Plain DONE-%s\\r\\n' \"$i\"; sleep .1; done"],{env});
  const ordinary=attach('xterm-256color');
  await until(()=>ordinary.styles);
  assert.deepStrictEqual(ordinary.styles.Italic,[false,true],'baseline no longer reproduces the Screen 4.x mapping');
  const before=ordinary.updates;
  prepareScreenTerminal(home); // Check atomic installation in a disposable database.
  assert.equal(prepareScreenTerminal(),SCREEN_TERM);
  assert.equal(prepareScreenTerminal(),SCREEN_TERM,'repeated installation failed');
  assert(!fs.readdirSync(path.join(home,'.terminfo')).some(name=>name.startsWith('.tm-web-')));
  const web=attach(SCREEN_TERM);
  await until(()=>web.styles && ordinary.updates>before);
  assert.deepStrictEqual(web.styles,{Italic:[true,false],Inverse:[false,true],Both:[true,true],Plain:[false,false]});
  assert.deepStrictEqual(ordinary.styles.Italic,[false,true],'another display changed rendition');
  console.log('PASS existing Screen: italic, inverse, combined and reset styles; ordinary display unaffected');
  web.child.kill();
  await delay(100);
  const reattached=attach(SCREEN_TERM);
  await until(()=>reattached.styles);
  assert.deepStrictEqual(reattached.styles,web.styles);
  console.log('PASS display reconnect preserves styles without restarting the task');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
  try { execFileSync('screen',['-S',session,'-X','quit'],{env,stdio:'ignore'}); } catch {}
  for (const display of displays) {try {display.child.kill();}catch {}display.model.dispose();}
  fs.rmSync(home,{recursive:true,force:true});
});
