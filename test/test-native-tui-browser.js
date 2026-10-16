'use strict';
const assert=require('assert');
const fs=require('fs'),os=require('os'),path=require('path'),net=require('net');
const {spawn,execFileSync}=require('child_process');
const { launchBrowser, routeTerminalAssets, login } = require('./helpers/browser');
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
 fs.writeFileSync(ccfg,JSON.stringify({mode:'client',client:{serverUrl:`ws://127.0.0.1:${port}`,token:'token',name:'native-test',screen:session,clientId:'native-test'}}));
 server=spawn(process.execPath,[path.join(project,'server.js'),`--config=${scfg}`],{cwd:project});server.stdout.on('data',x=>serverLog+=x);server.stderr.on('data',x=>serverLog+=x);
 await until(async()=> (await fetch(`http://127.0.0.1:${port}/api/agents`)).ok);
 client=spawn(process.execPath,[path.join(project,'client.js'),`--config=${ccfg}`],{cwd:project});client.stdout.on('data',x=>clientLog+=x);client.stderr.on('data',x=>clientLog+=x);
 await until(async()=>{const a=(await(await fetch(`http://127.0.0.1:${port}/api/agents`)).json()).agents;return a.some(x=>x.protocolVersion===2);});
 browser=await launchBrowser();
 const errors=[];
 async function openPage(viewport={width:1200,height:800}){
  const p=await browser.newPage({viewport});p.on('pageerror',e=>errors.push(e.stack));
  await routeTerminalAssets(p);
  await login(p,`http://127.0.0.1:${port}/`);await p.locator('.agent-card').first().click();
  await until(async()=> (await p.evaluate(screenText)).includes('NATIVE-PAGER'));return p;
 }
 // Exercise the actual frontend/xterm handlers, including mouseup bubbling.
 async function checkSelection(p,multi=false){
  await p.context().grantPermissions(['clipboard-read','clipboard-write']);
  await p.evaluate(m=>{
   window.selectionTarget=m?Object.values(multiTerms)[0].term:term;
   window.selectionReports=[];window.selectionMenus=[];
   window.selectionMenuListener=e=>selectionMenus.push(e.defaultPrevented);
   document.addEventListener('contextmenu',selectionMenuListener);
   window.selectionSubscriptions=[selectionTarget.onData(d=>selectionReports.push(d)),selectionTarget.onBinary(d=>selectionReports.push(d))];
  },multi);
  const selector=multi?'.multi-term-container .xterm-screen':'#term-container .xterm-screen';
  for(const mode of [1000,1002,1003]){
   await p.evaluate(mode=>new Promise(r=>selectionTarget.write(`\x1b[?${mode}h`,r)),mode);
   for(const earlyRelease of [false,true]){
    const b=await p.locator(selector).boundingBox();
    const size=await p.evaluate(()=>({cols:selectionTarget.cols,rows:selectionTarget.rows}));
    const cw=b.width/size.cols,ch=b.height/size.rows;
    await p.mouse.move(b.x+cw*0.2,b.y+ch*1.5);
    await p.keyboard.down('Shift');await p.mouse.down();
    await p.mouse.move(b.x+cw*22.2,b.y+ch*1.5,{steps:8});
    const selected=await p.evaluate(()=>selectionTarget.getSelection());
    assert(selected.includes('ROW-'),'drag should select fixture text');
    await p.evaluate(()=>selectionReports.length=0);
    if(earlyRelease)await p.keyboard.up('Shift');
    await p.mouse.up();
    if(!earlyRelease)await p.keyboard.up('Shift');
    assert.equal(await p.evaluate(()=>selectionTarget.getSelection()),selected,`mode ${mode}: mouseup cleared selection`);
    // Any-motion tracking must not erase selection just by hovering afterward.
    await p.mouse.move(b.x+cw*24,b.y+ch*1.5);
    assert.equal(await p.evaluate(()=>selectionTarget.getSelection()),selected,'hover cleared selection');
    assert.deepStrictEqual(await p.evaluate(()=>selectionReports),[],'selection leaked mouse input');
    await p.keyboard.press('Control+Shift+c');
    assert.equal(await p.evaluate(()=>navigator.clipboard.readText()),selected,'clipboard differs from selection');
    assert.deepStrictEqual(await p.evaluate(()=>selectionReports),[],'copy sent input to app');
    // A browser context menu needs the helper textarea's native selection,
    // and neither button press nor release may reach the TUI while selecting.
    await p.mouse.click(b.x+cw*35,b.y+ch*4.5,{button:'right'});
    assert.equal(await p.evaluate(()=>selectionTarget.getSelection()),selected,'right click cleared selection');
    assert.deepStrictEqual(await p.evaluate(()=>selectionReports),[],'right click leaked app input');
    assert.equal(await p.evaluate(()=>selectionMenus[selectionMenus.length-1]),false,'browser context menu was prevented');
    const nativeSelection=await p.evaluate(()=>{
     const t=selectionTarget.textarea;return {value:t.value,start:t.selectionStart,end:t.selectionEnd,active:document.activeElement.className,text:t.value.slice(t.selectionStart,t.selectionEnd)};
    });
    assert.equal(nativeSelection.text,selected,'context menu has no native text selection to copy: '+JSON.stringify(nativeSelection));
    await p.evaluate(()=>document.execCommand('copy'));
    assert.equal(await p.evaluate(()=>navigator.clipboard.readText()),selected,'context-menu copy differs from selection');
    // Ordinary clicking still reports to the app and clears the old selection.
    await p.mouse.click(b.x+cw*25,b.y+ch*1.5);
    assert((await p.evaluate(()=>selectionReports.length))>0,'ordinary click did not reach app');
    assert.equal(await p.evaluate(()=>selectionTarget.hasSelection()),false);
    await p.evaluate(()=>selectionReports.length=0);
    await p.mouse.click(b.x+cw*35,b.y+ch*4.5,{button:'right'});
    assert((await p.evaluate(()=>selectionReports.length))>0,'right click without selection did not reach app');
   }
  }
  // A drag ending outside the terminal must finish cleanly, too.
  const b=await p.locator(selector).boundingBox();
  await p.mouse.move(b.x+5,b.y+25);await p.keyboard.down('Shift');await p.mouse.down();
  await p.mouse.move(b.x+b.width+5,b.y+50,{steps:5});await p.mouse.up();await p.keyboard.up('Shift');
  assert(await p.evaluate(()=>selectionTarget.hasSelection()),'outside release lost selection');
  await p.evaluate(()=>{selectionTarget.clearSelection();selectionSubscriptions.forEach(s=>s.dispose());document.removeEventListener('contextmenu',selectionMenuListener);});
  console.log('PASS '+(multi?'multi':'single')+' terminal selection, early modifier release, outside release, clipboard, context menu and ordinary clicks');
 }
 const page=await openPage();
 await checkSelection(page);
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
 const oldPage=String(firstWheel.at(-1).page).padStart(4,'0');
 await until(async()=>(await page.evaluate(screenText)).includes('page='+oldPage));
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
 await checkSelection(multi,true);
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


 async function restartClient(){
  const old=client;const exited=new Promise(r=>old.once('exit',r));old.kill();await exited;
  client=spawn(process.execPath,[path.join(project,'client.js'),`--config=${ccfg}`],{cwd:project});
  client.stdout.on('data',x=>clientLog+=x);client.stderr.on('data',x=>clientLog+=x);
 }
 const previousAgentId=await page.evaluate(()=>currentAgentId);
 await restartClient();
 await until(async()=>await page.evaluate(id=>currentAgentId!==id,previousAgentId));
 await until(async()=>await page.evaluate(()=>term.buffer.active.type==='normal' && term.modes.mouseTrackingMode!=='none'));
 assert(await page.locator('#btn-scroll-latest').isDisabled());
 const beforeToggleWheel=fs.readFileSync(events,'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.kind.startsWith('wheel')).length;
 const toggleBox=await page.locator('#term-container .xterm-screen').boundingBox();await page.mouse.move(toggleBox.x+80,toggleBox.y+80);await page.mouse.wheel(0,-100);
 await until(async()=>fs.readFileSync(events,'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.kind.startsWith('wheel')).length>beforeToggleWheel);
 console.log('PASS TUI enabled without configuration after client restart with browser still open');

 // Rapid close/reopen must cancel the old view's frame and resize work.
 await page.evaluate(()=>{
  window.closedViewMessages=[];
  const send=ws.send;
  window.restoreViewSend=()=>{ws.send=send;};
  ws.send=function(data){const m=JSON.parse(data);if(m.type==='resize'||m.type==='connect_multi'||(m.type==='connect'&&m.agentId))closedViewMessages.push(m);return send.call(this,data);};
  const id=currentAgentId;
  closeTerminal();
  for(let i=0;i<3;i++){openTerminal(id,'rapid reopen');window.dispatchEvent(new Event('resize'));closeTerminal();}
  selectedAgents.add(id);openMultiTerminal();window.dispatchEvent(new Event('resize'));closeMultiView();
 });
 await delay(700);
 assert.deepStrictEqual(await page.evaluate(()=>closedViewMessages),[],'closed view sent stale subscriptions or resizes');
 await page.evaluate(()=>restoreViewSend());
 await page.locator('.agent-card').first().click();
 await until(async()=>(await page.evaluate(screenText)).includes('NATIVE-PAGER'));
 console.log('PASS rapid single/multi view close cancels delayed subscriptions and resizes');

 const phone=await openPage({width:390,height:844});
 await phone.locator('#float-toggle-view').click();
 assert.equal(await phone.evaluate(()=>termViewMode),'structured');
 const phoneKeyCount=fs.readFileSync(events,'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(m=>m.kind==='key').length;
 await phone.evaluate(()=>structSendRaw('\x1b[5~'));
 await until(()=>fs.readFileSync(events,'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(m=>m.kind==='key').length>phoneKeyCount);
 await phone.locator('#float-toggle-view').click();
 assert.equal(await phone.evaluate(()=>termViewMode),'xterm');
 const beforeComposition=fs.readFileSync(events,'utf8');
 const input=phone.locator('#mobile-text-input');
 await input.dispatchEvent('compositionstart');await input.fill('中文');
 await delay(100);assert.equal(fs.readFileSync(events,'utf8'),beforeComposition,'uncommitted IME input reached app');
 await input.dispatchEvent('compositionend');
 await until(()=>fs.readFileSync(events,'utf8').slice(beforeComposition.length).split('\n').filter(Boolean).map(JSON.parse).map(m=>m.hex).join('').includes(Buffer.from('中文').toString('hex')));
 assert.equal(await input.inputValue(),'');
 await phone.close();
 await until(async()=>await page.evaluate(()=>!pendingSizeSnapshot.has(currentAgentId)));
 console.log('PASS phone structured/raw switch and committed IME text through shared input');

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
