'use strict';
const assert=require('assert');
const fs=require('fs'),os=require('os'),path=require('path'),net=require('net');
const {spawn,execFileSync}=require('child_process');
const { launchBrowser, routeTerminalAssets, login } = require('./helpers/browser');
const project=path.resolve(__dirname,'..');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'swt-native-browser-'));
const session=`swt-codex-${process.pid}`;
let server,client,browser,serverLog='',clientLog='';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=15000){const end=Date.now()+ms;while(Date.now()<end){try{if(await fn())return;}catch{}await delay(100);}throw Error('timeout');}
const freePort=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
const screenText=()=>Array.from({length:term.buffer.active.length},(_,i)=>term.buffer.active.getLine(i).translateToString(true)).join('\n');
(async()=>{
 const port=await freePort();
 // Test GNU Screen's default settings rather than assuming mouse support.
 const args=require('./fixtures/codex-history')(path.join(dir,'codex-home'),project);
 fs.mkdirSync(path.join(dir,'bin'));
 fs.mkdirSync(path.join(dir,'runtime','sandbox'),{recursive:true});
 fs.copyFileSync(path.join(project,'infra/staging/run-task.py'),path.join(dir,'bin/run-task.py'));
 fs.writeFileSync(path.join(dir,'runtime/settings.json'),JSON.stringify({node:process.execPath}));
 fs.writeFileSync(path.join(dir,'runtime/codex-command.json'),JSON.stringify(args));
 // The production wrapper provides the shell after Codex exits.
 fs.cpSync(path.join(dir,'codex-home'),path.join(dir,'runtime/codex-home'),{recursive:true});
 fs.rmSync(path.join(dir,'codex-home'),{recursive:true});
 args[1]='CODEX_HOME='+path.join(dir,'runtime/codex-home');
 fs.writeFileSync(path.join(dir,'runtime/codex-command.json'),JSON.stringify(args));
 execFileSync('screen',['-dmS',session,'python3',path.join(dir,'bin/run-task.py')]);
 const scfg=path.join(dir,'server.json'),ccfg=path.join(dir,'client.json');
 fs.writeFileSync(scfg,JSON.stringify({mode:'server',server:{host:'127.0.0.1',port,password:'pw',tokens:{token:{user:'test'}},supervisor:{enabled:false}}}));
 fs.writeFileSync(ccfg,JSON.stringify({mode:'client',client:{serverUrl:`ws://127.0.0.1:${port}`,token:'token',name:'native-test',screen:session,clientId:'native-test',nativeTui:true}}));
 server=spawn(process.execPath,[path.join(project,'server.js'),`--config=${scfg}`],{cwd:project});server.stdout.on('data',x=>serverLog+=x);server.stderr.on('data',x=>serverLog+=x);
 await until(async()=> (await fetch(`http://127.0.0.1:${port}/api/agents`)).ok);
 client=spawn(process.execPath,[path.join(project,'client.js'),`--config=${ccfg}`],{cwd:project});client.stdout.on('data',x=>clientLog+=x);client.stderr.on('data',x=>clientLog+=x);
 await until(async()=>{const a=(await(await fetch(`http://127.0.0.1:${port}/api/agents`)).json()).agents;return a.some(x=>x.nativeTui===true);});
 browser=await launchBrowser();
 const errors=[];
 async function openPage(){
  const p=await browser.newPage({viewport:{width:1200,height:800}});p.on('pageerror',e=>errors.push(e.message));
  await routeTerminalAssets(p);
  await login(p,`http://127.0.0.1:${port}/`);await p.locator('.agent-card').first().click();
  await until(async()=> (await p.evaluate(screenText)).includes('history line 49:4'),30000);return p;
 }
 async function latest(p){
  await p.locator('.xterm-helper-textarea').focus();
  for(let i=0;i<30;i++){if((await p.evaluate(screenText)).includes('history line 49:4'))return;await p.keyboard.press('PageDown');await delay(150);}
  throw Error('PageDown did not return to latest');
 }
 const page=await openPage();
 assert.equal(await page.evaluate(()=>term.buffer.active.type),'normal');
 assert(await page.locator('#btn-scroll-latest').isDisabled());
 const tail=await page.evaluate(screenText);
 if(process.env.KEEP_TEST_ARTIFACTS)await page.screenshot({path:path.join(dir,'codex-latest.png')});
 await page.locator('.xterm-helper-textarea').focus();await page.keyboard.press('PageUp');
 await until(async()=>{const s=await page.evaluate(screenText);return s!==tail && !s.includes('ANSWER-049') && /ANSWER-0/.test(s);});
 const older=await page.evaluate(screenText);
 assert(/ANSWER-0/.test(older));console.log('PASS real Codex PageUp reveals older messages');
 if(process.env.KEEP_TEST_ARTIFACTS)await page.screenshot({path:path.join(dir,'codex-pageup.png')});
 await latest(page);
 const box=await page.locator('#term-container .xterm-screen').boundingBox();await page.mouse.move(box.x+80,box.y+80);
 await page.mouse.wheel(0,-600);
 await until(async()=>{const s=await page.evaluate(screenText);return !s.includes('history line 49:4') && /ANSWER-0/.test(s);});
 const wheelOlder=await page.evaluate(screenText);console.log('PASS real Codex browser wheel reveals older messages');
 if(process.env.KEEP_TEST_ARTIFACTS)await page.screenshot({path:path.join(dir,'codex-wheel.png')});
 const expectedMarkers=wheelOlder.match(/(?:ANSWER|USER)-\d+/g);
 await page.evaluate(()=>ws.close());await until(async()=>await page.evaluate(()=>ws.readyState===WebSocket.OPEN));
 await until(async()=>JSON.stringify((await page.evaluate(screenText)).match(/(?:ANSWER|USER)-\d+/g))===JSON.stringify(expectedMarkers));
 assert.equal(await page.evaluate(()=>term.buffer.active.type),'normal');console.log('PASS real Codex reconnect retains history position');
 // A second browser creates a fresh snapshot, rather than a delta replay.
 // Return to latest before openPage's readiness check.
 await page.locator('.xterm-helper-textarea').focus();await latest(page);
 const follower=await openPage();
 assert.equal(await follower.evaluate(()=>term.buffer.active.type),'normal');
 const followerBox=await follower.locator('#term-container .xterm-screen').boundingBox();await follower.mouse.move(followerBox.x+80,followerBox.y+80);await follower.mouse.wheel(0,-600);
 await until(async()=>{const s=await follower.evaluate(screenText);return !s.includes('history line 49:4') && /ANSWER-0/.test(s);});
 await until(async()=>JSON.stringify((await page.evaluate(screenText)).match(/(?:ANSWER|USER)-\d+/g))===JSON.stringify((await follower.evaluate(screenText)).match(/(?:ANSWER|USER)-\d+/g)));
 console.log('PASS real Codex fresh snapshot preserves wheel and multiple browsers agree');
 await follower.close();await page.setViewportSize({width:900,height:600});await delay(1200);
 assert.equal(await page.evaluate(()=>term.buffer.active.type),'normal');
 const beforeResizePage=await page.evaluate(screenText);await page.evaluate(()=>scrollTermPages(-1));
 await until(async()=>{const s=await page.evaluate(screenText);return s!==beforeResizePage && /ANSWER-0/.test(s);});
 console.log('PASS real Codex resize and touch PageUp');
 await require('./fixtures/shell-codex-roundtrip')(page,args.slice(2),name=>console.log('PASS',name));
 assert.deepStrictEqual(errors,[]);console.log('PASS real Codex + GNU Screen + client/server + Chromium; no model requests');
})().catch(async e=>{console.error('FAIL',e.stack);console.error('SERVER',serverLog.slice(-1500));console.error('CLIENT',clientLog.slice(-1500));console.error('Artifacts:',dir);if(browser){const p=browser.contexts().flatMap(c=>c.pages())[0];if(p){try{console.error('SCREEN',await p.evaluate(screenText));console.error('MODES',await p.evaluate(()=>term.modes));}catch{}}}process.exitCode=1;}).finally(async()=>{
 if(browser)await browser.close();if(client)client.kill();if(server)server.kill();try{execFileSync('screen',['-S',session,'-X','quit']);}catch{}
 // Always remove the temporary credential copy, including on failure.
 for(const profile of ['codex-home','runtime/codex-home'])fs.rmSync(path.join(dir,profile,'auth.json'),{force:true});
 if(!process.exitCode && !process.env.KEEP_TEST_ARTIFACTS)fs.rmSync(dir,{recursive:true,force:true});
 else console.log('Saved test artifacts:',dir);
});
