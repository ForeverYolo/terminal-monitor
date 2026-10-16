'use strict';
// Verify the deployed public endpoint. Optional --recovery restarts only the
// dedicated staging broker/client, never the production sessions.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const WebSocket = require('ws');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.env.STAGING_ROOT || '/home/renhangqi/terminal-monitor-staging';
const access = JSON.parse(fs.readFileSync(path.join(root,'runtime/access.json')));
const output = path.join(root,'runtime/smoke');
fs.mkdirSync(output,{recursive:true,mode:0o700});
const results=[];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=25000){const end=Date.now()+ms;while(Date.now()<end){try{if(await fn())return;}catch{}await delay(200);}throw Error('condition timed out');}
function pass(name){results.push(name);console.log('PASS',name);}
function lines(){return Array.from({length:term.buffer.active.length},(_,i)=>term.buffer.active.getLine(i).translateToString(true)).join('\n');}
async function latest(page){await page.locator('.xterm-helper-textarea').focus();for(let i=0;i<40;i++){if((await page.evaluate(lines)).includes('history line 49:4'))return;await page.keyboard.press('PageDown');await delay(180);}throw Error('could not return to fixture latest');}
function rejectBadPassword(){return new Promise((resolve,reject)=>{const ws=new WebSocket(access.url.replace(/^http/,'ws'));const timer=setTimeout(()=>{ws.terminate();reject(Error('auth timeout'));},10000);ws.on('error',reject);ws.on('open',()=>ws.send(JSON.stringify({type:'auth',username:access.username,password:'deliberately-wrong'})));ws.on('message',data=>{try{const msg=JSON.parse(data);assert.equal(msg.type,'error');assert.equal(msg.message,'Auth failed');clearTimeout(timer);ws.close();resolve();}catch(e){reject(e);}});});}
let browser;
(async()=>{
 const meta=await(await fetch(new URL('staging.json',access.url))).json();assert.equal(meta.environment,'staging');
 await until(async()=>{const agents=await(await fetch(new URL('api/agents',access.url))).json();return agents.agents.length===1 && agents.agents[0].nativeTui && agents.agents[0].screen==='swt-staging-codex';});
 for(const asset of ['xterm.css','xterm.js','xterm-addon-fit.js']){const r=await fetch(new URL('vendor/'+asset,access.url));assert.equal(r.status,200);assert((await r.arrayBuffer()).byteLength>1000);}
 pass('public staging identity, local assets, and 2080 client registration');
 await rejectBadPassword();pass('wrong login password rejected');
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1200,height:800}});
 const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().startsWith('http')&&new URL(r.url()).host!==new URL(access.url).host)external.push(r.url());});
 await page.goto(access.url);assert((await page.title()).includes('测试'));
 await page.locator('#username-input').fill(access.username);await page.locator('#password-input').fill(access.password);await page.locator('.login-box button').click();await page.locator('.agent-card').first().click();
 await until(async()=>/ANSWER-\d+/.test(await page.evaluate(lines)));
 assert.equal(await page.evaluate(()=>term.buffer.active.type),'normal');await latest(page);await page.screenshot({path:path.join(output,'latest.png')});pass('public browser login and real Codex history');
 const tail=await page.evaluate(lines);await page.keyboard.press('PageUp');await until(async()=>{const s=await page.evaluate(lines);return s!==tail&&!s.includes('history line 49:4')&&/ANSWER-\d+/.test(s);});await page.screenshot({path:path.join(output,'pageup.png')});pass('keyboard paging over the Tencent-to-2080 link');
 if(process.argv.includes('--escape')){
  await page.evaluate(()=>{
   window.stagingKeyInputs=[];
   const original=ws.send.bind(ws);
   ws.send=function(data){const msg=JSON.parse(data);if(msg.type==='data')window.stagingKeyInputs.push(Array.from(atob(msg.payload),c=>c.charCodeAt(0).toString(16).padStart(2,'0')).join(''));return original(data);};
  });
  await page.keyboard.press('Escape');await delay(1000);
  assert((await page.evaluate(()=>window.stagingKeyInputs)).includes('1b'),'keyboard Escape did not send ESC');
  // Exercise the mobile toolbar's handler too, without relying on viewport.
  await page.evaluate(()=>send('\x1b'));await delay(1000);
  assert(execFileSync('screen',['-ls'],{encoding:'utf8'}).includes('swt-staging-codex'),'Escape terminated staging Screen');
  const argv=JSON.parse(fs.readFileSync(path.join(root,'runtime/codex-command.json')));
  const id=argv[argv.indexOf('resume')+1];
  assert(execFileSync('ps',['-eo','args'],{encoding:'utf8'}).split('\n').some(s=>s.includes('codex --no-daemon resume '+id)),'Escape terminated Codex');
  assert(!(await page.evaluate(lines)).includes('[screen is terminating]'));
  pass('keyboard and toolbar Escape send ESC and keep Codex/Screen alive');
 }
 await latest(page);const box=await page.locator('#term-container .xterm-screen').boundingBox();await page.mouse.move(box.x+80,box.y+80);await page.mouse.wheel(0,-600);await until(async()=>!(await page.evaluate(lines)).includes('history line 49:4'));await page.screenshot({path:path.join(output,'wheel.png')});pass('mouse wheel reveals older real Codex messages');
 const position=(await page.evaluate(lines)).match(/(?:ANSWER|USER)-\d+/g);
 await page.evaluate(()=>{window.stagingOldSocket=ws;ws.close();});await until(async()=>await page.evaluate(()=>ws!==window.stagingOldSocket&&ws.readyState===WebSocket.OPEN));
 await until(async()=>JSON.stringify((await page.evaluate(lines)).match(/(?:ANSWER|USER)-\d+/g))===JSON.stringify(position));pass('browser reconnect retains reading position');
 if(process.argv.includes('--recovery')){
  const serverHost=new URL(access.url).hostname;
  const before=execFileSync('ssh',['-o','BatchMode=yes',`ubuntu@${serverHost}`,'systemctl show terminal-monitor-staging.service -p MainPID --value'],{encoding:'utf8'}).trim();
  await page.evaluate(()=>window.stagingOldSocket=ws);
  execFileSync('ssh',['-o','BatchMode=yes',`ubuntu@${serverHost}`,'sudo -n systemctl kill --kill-who=main --signal=SIGKILL terminal-monitor-staging.service']);
  await until(async()=>{const pid=execFileSync('ssh',['-o','BatchMode=yes',`ubuntu@${serverHost}`,'systemctl show terminal-monitor-staging.service -p MainPID --value'],{encoding:'utf8'}).trim();return pid!=='0'&&pid!==before;});
  await until(async()=>await page.evaluate(()=>ws!==window.stagingOldSocket&&ws.readyState===WebSocket.OPEN),45000);
  await until(async()=>/ANSWER-\d+/.test(await page.evaluate(lines)),45000);await latest(page);pass('broker crash automatically recovers and browser reconnects');
  const clientProcesses=execFileSync('ps',['-eo','pid,args'],{encoding:'utf8'}).split('\n').filter(s=>s.includes(root+'/current/client.js')&&s.includes('--config='+root+'/runtime/client.json'));
  assert.equal(clientProcesses.length,1);
  const clientPid=clientProcesses[0].trim().split(/\s+/)[0];
  function attachmentPid(){const entries=execFileSync('ps',['--ppid',clientPid,'-o','pid,args'],{encoding:'utf8'}).split('\n').filter(s=>s.includes('screen -x swt-staging-codex'));return entries.length===1?Number(entries[0].trim().split(/\s+/)[0]):null;}
  const oldAttachment=attachmentPid();assert(oldAttachment);
  const terminalSize=await page.evaluate(()=>({cols:term.cols,rows:term.rows}));
  process.kill(oldAttachment,'SIGTERM');
  await until(async()=>{const pid=attachmentPid();return pid&&pid!==oldAttachment;});
  await until(async()=>{const s=await page.evaluate(lines);return /ANSWER-\d+/.test(s)&&!s.includes('[screen is terminating]');});
  assert.deepStrictEqual(await page.evaluate(()=>({cols:term.cols,rows:term.rows})),terminalSize);
  pass('PTY exit after broker reconnect reattaches with the same terminal size');
  const oldId=await page.evaluate(()=>currentAgentId);
  // Match the full dedicated config path; refuse an ambiguous process list.
  const ps=execFileSync('ps',['-eo','pid,args'],{encoding:'utf8'}).split('\n');
  const matches=ps.filter(s=>s.includes(root+'/current/client.js')&&s.includes('--config='+root+'/runtime/client.json'));
  assert.equal(matches.length,1,'expected exactly one dedicated staging client');process.kill(Number(matches[0].trim().split(/\s+/)[0]),'SIGKILL');
  await until(async()=>await page.evaluate(id=>currentAgentId!==id&&term.buffer.active.type==='normal',oldId),45000);await latest(page);
  await page.keyboard.press('PageUp');await until(async()=>!(await page.evaluate(lines)).includes('history line 49:4'));pass('2080 client crash automatically recovers and paging still works');
 }
 await latest(page);await page.reload();await page.locator('.agent-card').first().click();await until(async()=>/ANSWER-\d+/.test(await page.evaluate(lines)));pass('full page reload restores a fresh terminal snapshot');
 if(process.argv.includes('--shell')){
  const argv=JSON.parse(fs.readFileSync(path.join(root,'runtime/codex-command.json')));
  await require('../../test/fixtures/shell-codex-roundtrip')(page,argv.slice(2),pass);
 }
 assert.deepStrictEqual(errors,[]);assert.deepStrictEqual(external,[]);pass('no browser errors or CDN dependency');
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({url:access.url,commit:meta.commit,at:new Date().toISOString(),results},null,2));
 console.log('Saved screenshots and report:',output);
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();});
