'use strict';
const assert=require('assert');
const fs=require('fs'),os=require('os'),path=require('path'),net=require('net');
const {spawn,execFileSync}=require('child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const project=path.resolve(__dirname,'..');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'swt-native-browser-'));
const session=`swt-native-${process.pid}`;
let server,client,browser,serverLog='',clientLog='';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=15000){const end=Date.now()+ms;while(Date.now()<end){try{if(await fn())return;}catch{}await delay(100);}throw Error('timeout');}
const freePort=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
const screenText=()=>Array.from({length:term.buffer.active.length},(_,i)=>term.buffer.active.getLine(i).translateToString(true)).join('\n');
(async()=>{
 const port=await freePort();
 const events=path.join(dir,'events.jsonl');
 // Test GNU Screen's default settings rather than assuming mouse support.
 execFileSync('screen',['-dmS',session,'python3',path.join(project,'test/fixtures/native-tui.py'),events]);
 const scfg=path.join(dir,'server.json'),ccfg=path.join(dir,'client.json');
 fs.writeFileSync(scfg,JSON.stringify({mode:'server',server:{host:'127.0.0.1',port,password:'pw',tokens:{token:{user:'test'}},supervisor:{enabled:false}}}));
 fs.writeFileSync(ccfg,JSON.stringify({mode:'client',client:{serverUrl:`ws://127.0.0.1:${port}`,token:'token',name:'native-test',screen:session,clientId:'native-test',nativeTui:true}}));
 server=spawn(process.execPath,[path.join(project,'server.js'),`--config=${scfg}`],{cwd:project});server.stdout.on('data',x=>serverLog+=x);server.stderr.on('data',x=>serverLog+=x);
 await until(async()=> (await fetch(`http://127.0.0.1:${port}/api/agents`)).ok);
 client=spawn(process.execPath,[path.join(project,'client.js'),`--config=${ccfg}`],{cwd:project});client.stdout.on('data',x=>clientLog+=x);client.stderr.on('data',x=>clientLog+=x);
 await until(async()=>{const a=(await(await fetch(`http://127.0.0.1:${port}/api/agents`)).json()).agents;return a.some(x=>x.nativeTui===true);});
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 const errors=[];
 async function openPage(){
  const p=await browser.newPage({viewport:{width:1200,height:800}});p.on('pageerror',e=>errors.push(e.message));
  await p.route('https://cdn.jsdelivr.net/**',route=>{
   const u=route.request().url();let file;
   if(u.includes('xterm-addon-fit'))file=process.env.XTERM_FIT_JS||require.resolve('xterm-addon-fit/lib/xterm-addon-fit.js');
   else if(u.endsWith('/xterm.js'))file=path.join(project,'node_modules/xterm/lib/xterm.js');
   else if(u.endsWith('/xterm.css'))file=path.join(project,'node_modules/xterm/css/xterm.css');
   else return route.abort();return route.fulfill({path:file,contentType:u.endsWith('.css')?'text/css':'application/javascript'});
  });
  await p.goto(`http://127.0.0.1:${port}/`);await p.locator('#username-input').fill('test');await p.locator('#password-input').fill('pw');await p.locator('.login-box button').click();await p.locator('.agent-card').first().click();
  await until(async()=> (await p.evaluate(screenText)).includes('NATIVE-PAGER'));return p;
 }
 const page=await openPage();
 console.log('initial state',await page.evaluate(()=>({type:term.buffer.active.type,modes:term.modes})));
 assert.equal(await page.evaluate(()=>term.buffer.active.type),'normal','Screen relay should keep browser scrollback in the normal buffer');
 await page.locator('.xterm-helper-textarea').focus();await page.keyboard.press('PageUp');
 await until(async()=>(await page.evaluate(screenText)).includes('page=0080'));
 await page.keyboard.press('PageDown');await until(async()=>(await page.evaluate(screenText)).includes('page=0090'));
 console.log('PASS keyboard paging through real Screen');
 const box=await page.locator('#term-container .xterm-screen').boundingBox();await page.mouse.move(box.x+80,box.y+80);await page.mouse.wheel(0,-100);
 await until(async()=>fs.existsSync(events)&&fs.readFileSync(events,'utf8').includes('wheel-'));
 const firstWheel=fs.readFileSync(events,'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.kind.startsWith('wheel'));
 assert(firstWheel.length);console.log('PASS browser wheel reaches app',firstWheel.map(x=>x.kind));
 const text=await page.evaluate(screenText);const oldPage=text.match(/page=(\d+)/)[1];
 await page.evaluate(()=>ws.close());await until(async()=>await page.evaluate(()=>ws.readyState===WebSocket.OPEN));
 await until(async()=>(await page.evaluate(screenText)).includes('page='+oldPage));
 assert.equal(await page.evaluate(()=>term.buffer.active.type),'normal');
 await page.mouse.wheel(0,-100);await until(async()=>fs.readFileSync(events,'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.kind.startsWith('wheel')).length>firstWheel.length);
 console.log('PASS reconnect preserves application screen and wheel');
 const second=await openPage();assert.equal(await second.evaluate(()=>term.buffer.active.type),'normal');
 await second.locator('.xterm-helper-textarea').focus();await second.keyboard.press('PageUp');
 await until(async()=> (await page.evaluate(screenText))===(await second.evaluate(screenText)));
 console.log('PASS second browser snapshot and synchronized updates');
 await second.close();await page.setViewportSize({width:900,height:600});await delay(1200);
 assert.equal(await page.evaluate(()=>term.buffer.active.type),'normal');
 const keyCount=fs.readFileSync(events,'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.kind==='key').length;
 await page.evaluate(()=>scrollTermPages(-1));
 await until(async()=>fs.readFileSync(events,'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.kind==='key').length>keyCount);
 console.log('PASS resize and touch paging controls');
 const multi=await openPage();
 await multi.evaluate(()=>{const id=currentAgentId;closeTerminal();selectedAgents.add(id);openMultiTerminal();});
 await until(async()=>await multi.evaluate(()=>Object.values(multiTerms).some(e=>e.term.buffer.active.type==='normal' && e.term.modes.mouseTrackingMode!=='none')));
 const multiWheelCount=fs.readFileSync(events,'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.kind.startsWith('wheel')).length;
 const multiBox=await multi.locator('.multi-term-container .xterm-screen').boundingBox();await multi.mouse.move(multiBox.x+80,multiBox.y+80);await multi.mouse.wheel(0,-100);
 await until(async()=>fs.readFileSync(events,'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.kind.startsWith('wheel')).length>multiWheelCount);
 const multiKeyCount=fs.readFileSync(events,'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.kind==='key').length;
 await multi.locator('.multi-term-container .xterm-helper-textarea').focus();await multi.keyboard.press('PageUp');
 await until(async()=>fs.readFileSync(events,'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.kind==='key').length>multiKeyCount);
 await multi.close();console.log('PASS native multi-terminal snapshot, wheel and keyboard');
 await page.setViewportSize({width:1800,height:800});
 await until(async()=>await page.evaluate(()=>term.cols>180 && !pendingSizeSnapshot.has(currentAgentId)));
 const highCount=fs.readFileSync(events,'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.kind.startsWith('wheel')).length;
 const wideBox=await page.locator('#term-container .xterm-screen').boundingBox();await page.mouse.move(wideBox.x+1500,wideBox.y+80);await page.mouse.wheel(0,-100);
 await until(async()=>fs.readFileSync(events,'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.kind.startsWith('wheel')).length>highCount);
 console.log('PASS wide terminal wheel with mouse coordinates above 127');


 async function restartClient(nativeTui){
  const old=client;const exited=new Promise(r=>old.once('exit',r));old.kill();await exited;
  const cfg=JSON.parse(fs.readFileSync(ccfg));cfg.client.nativeTui=nativeTui;fs.writeFileSync(ccfg,JSON.stringify(cfg));
  client=spawn(process.execPath,[path.join(project,'client.js'),`--config=${ccfg}`],{cwd:project});
  client.stdout.on('data',x=>clientLog+=x);client.stderr.on('data',x=>clientLog+=x);
  await until(async()=>await page.evaluate(enabled=>isNativeTuiAgent(currentAgentId)===enabled,nativeTui));
 }
 await restartClient(false);
 await until(async()=>await page.evaluate(()=>term.buffer.active.type==='normal' && term.modes.mouseTrackingMode==='none'));
 assert(!(await page.locator('#btn-scroll-latest').isDisabled()));
 await restartClient(true);
 await until(async()=>await page.evaluate(()=>term.buffer.active.type==='normal' && term.modes.mouseTrackingMode!=='none'));
 assert(await page.locator('#btn-scroll-latest').isDisabled());
 const beforeToggleWheel=fs.readFileSync(events,'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.kind.startsWith('wheel')).length;
 const toggleBox=await page.locator('#term-container .xterm-screen').boundingBox();await page.mouse.move(toggleBox.x+80,toggleBox.y+80);await page.mouse.wheel(0,-100);
 await until(async()=>fs.readFileSync(events,'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.kind.startsWith('wheel')).length>beforeToggleWheel);
 console.log('PASS native/legacy/native configuration switching with browser still open');

 await page.locator('.xterm-helper-textarea').focus();await page.keyboard.type('q');
 await until(async()=>(await page.evaluate(screenText)).includes('NORMAL-AFTER'));
 await until(async()=>await page.evaluate(()=>term.modes.mouseTrackingMode==='none'));
 // Screen itself keeps its display in the alternate buffer until detached,
 // even after the application has returned to its normal screen.
 console.log('PASS application exit restores normal content and releases mouse');assert.deepStrictEqual(errors,[]);
 console.log('PASS native TUI browser end-to-end');
})().catch(e=>{console.error('FAIL',e.stack);console.error('SERVER',serverLog.slice(-1500));console.error('CLIENT',clientLog.slice(-1500));console.error('Artifacts:',dir);process.exitCode=1;}).finally(async()=>{
 if(browser)await browser.close();if(client)client.kill();if(server)server.kill();try{execFileSync('screen',['-S',session,'-X','quit']);}catch{}
 if(!process.exitCode)fs.rmSync(dir,{recursive:true,force:true});
});
