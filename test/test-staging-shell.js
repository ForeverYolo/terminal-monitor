'use strict';
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const {execFileSync}=require('child_process');
const pty=require('node-pty');
const {TerminalState}=require('../terminal-state');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'swt-staging-shell-'));
const session=`swt-shell-${process.pid}`;
let attachment;
const term=new TerminalState(120,30,()=>{},{nativeTui:true});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const view=()=>new Promise(r=>term.snapshot(()=>{const b=term.term.buffer.active;r(Array.from({length:b.length},(_,i)=>b.getLine(i).translateToString(true)));}));
async function until(fn){const end=Date.now()+10000;while(Date.now()<end){if(await fn())return;await delay(100);}throw Error('timeout');}
(async()=>{
 fs.mkdirSync(path.join(root,'bin'));fs.mkdirSync(path.join(root,'runtime/sandbox'),{recursive:true});
 fs.copyFileSync(path.resolve(__dirname,'../infra/staging/run-task.py'),path.join(root,'bin/run-task.py'));
 fs.writeFileSync(path.join(root,'runtime/settings.json'),JSON.stringify({node:process.execPath}));
 const fake=path.join(root,'exit.py');fs.writeFileSync(fake,"import time,sys\ntime.sleep(1)\nprint('CHILD-EXIT',flush=True)\nsys.exit(42)\n");
 // Include resume metadata, as the real launch command does.
 fs.writeFileSync(path.join(root,'runtime/codex-command.json'),JSON.stringify(['python3',fake,'resume','fixture-id']));
 execFileSync('screen',['-U','-dmS',session,'python3',path.join(root,'bin/run-task.py')]);
 attachment=pty.spawn('screen',['-x',session],{cols:120,rows:30,name:'xterm-256color',env:process.env});attachment.onData(s=>term.write(s));
 await until(async()=>(await view()).some(l=>l.includes('状态 42')));
 assert(execFileSync('screen',['-ls'],{encoding:'utf8'}).includes(session),'Screen exited with child');
 attachment.write('\x1b');await delay(500);
 assert(execFileSync('screen',['-ls'],{encoding:'utf8'}).includes(session),'Esc terminated the fallback Screen');
 attachment.write('\x07\x15printf "SHELL-ALIVE\\n"\r');
 await until(async()=>(await view()).some(l=>l==='SHELL-ALIVE'));
 console.log('PASS child exit, Screen stays alive, Esc stays alive, fallback shell accepts commands');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{if(attachment)attachment.kill();term.dispose();try{execFileSync('screen',['-S',session,'-X','quit']);}catch{}fs.rmSync(root,{recursive:true,force:true});});
