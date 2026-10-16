'use strict';
// Reproduce a TUI body scrolling over its fixed input area after a snapshot.
// The mock agent emits valid Screen-style terminal output; no model is called.
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),net=require('net');
const {spawn}=require('child_process');
const WebSocket=require('ws');
const {TerminalState}=require('../terminal-state');
const { launchBrowser, routeTerminalAssets, login } = require('./helpers/browser');
const project=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'swt-scroll-region-'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await delay(50);}throw Error('condition timed out');}
const freePort=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
let server,agent,model,browser,cols=100,rows=30,log='';
function layout(){
 let data='\x1b[?6l\x1b[r\x1b[2J\x1b[H';
 for(let i=1;i<=rows-3;i++)data+=`\x1b[${i};1HBODY-${i}`;
 data+=`\x1b[${rows-2};1HINPUT BOX: keep typing here\x1b[${rows-1};1HFOOTER: protected\x1b[${rows};1HSTATUS: protected`;
 data+=`\x1b[?1003;1006h\x1b[2;${rows-3}r\x1b[${rows-3};1H`;
 model.write(data);
}
const screen=()=>Array.from({length:term.rows},(_,i)=>term.buffer.active.getLine(term.buffer.active.baseY+i)?.translateToString(true)||'');
function expected(){const t=model.term;return Array.from({length:t.rows},(_,i)=>t.buffer.active.getLine(t.buffer.active.baseY+i).translateToString(true));}
(async()=>{
 const port=await freePort(),cfg=path.join(dir,'server.json');
 fs.writeFileSync(cfg,JSON.stringify({server:{host:'127.0.0.1',port,password:'pw',tokens:{token:{user:'test'}},supervisor:{enabled:false}}}));
 server=spawn(process.execPath,[path.join(project,'server.js'),'--config='+cfg],{cwd:project});server.stdout.on('data',x=>log+=x);server.stderr.on('data',x=>log+=x);
 await until(async()=>{try{return (await fetch(`http://127.0.0.1:${port}/api/agents`)).ok;}catch{return false;}});
 agent=new WebSocket(`ws://127.0.0.1:${port}`);
 model=new TerminalState(cols,rows,payload=>{if(agent.readyState===WebSocket.OPEN)agent.send(JSON.stringify({type:'data',payload,filtered:true}));},{nativeTui:true,screenRelay:true});
 agent.on('message',raw=>{const msg=JSON.parse(raw);if(msg.type==='resize'){cols=msg.cols;rows=msg.rows;model.resize(cols,rows);layout();}if(msg.type==='terminal_snapshot_request')model.snapshot(s=>agent.send(JSON.stringify({type:'terminal_snapshot_result',reqId:msg.reqId,...s})));});
 await new Promise(r=>agent.on('open',r));
 agent.send(JSON.stringify({type:'register',token:'token',name:'scroll-region-fixture',screen:'test',attrs:{clientId:'scroll-region-fixture'},snapshotV1:true,nativeTui:true,cols,rows}));layout();
 await until(async()=>(await(await fetch(`http://127.0.0.1:${port}/api/agents`)).json()).agents.length===1);
 browser=await launchBrowser();
 let batch=0;
 const page=await browser.newPage({viewport:{width:1100,height:720}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await routeTerminalAssets(page);
 await login(page,`http://127.0.0.1:${port}/`);
 async function enter(){await page.locator('.agent-card').first().click();await until(async()=>(await page.evaluate(screen)).some(s=>s.includes('INPUT BOX: keep typing here')));await delay(350);}
 async function checkUpdates(label){
  const id=++batch;
  const data=Array.from({length:300},(_,i)=>`\r\nLIVE-${id}-${String(i).padStart(3,'0')}`).join('');model.write(data);await new Promise(r=>model.snapshot(r));
  await until(async()=>(await page.evaluate(screen)).some(s=>s.includes(`LIVE-${id}-299`)));
  const actual=await page.evaluate(screen);assert(actual[actual.length-3].includes('INPUT BOX: keep typing here'),label+': live output overwrote input box');
  assert.deepStrictEqual(actual,expected(),label+': browser and agent viewport diverged');
  console.log('PASS',label+': 300 body scrolls preserve input/footer and match agent');
 }
 await enter();await checkUpdates('fresh snapshot');
 await page.screenshot({path:path.join(dir,'fixed-input.png')});
 await page.reload();await enter();await checkUpdates('reopened terminal');
 await page.evaluate(()=>ws.close());await until(async()=>await page.evaluate(()=>ws.readyState===WebSocket.OPEN));await until(()=>log.includes('resume: true'));await delay(350);await checkUpdates('WebSocket reconnect');
 await page.setViewportSize({width:900,height:600});await delay(1000);await checkUpdates('resized terminal');
 // Keep output flowing while the browser obtains a fresh snapshot. Splits
 // deliberately land inside CSI sequences as well as printable text.
 layout();await new Promise(r=>model.snapshot(r));
 const stress=Array.from({length:7000},(_,i)=>`\r\n\x1b[32mSTRESS-${i}\x1b[0m`).join('');
 const feeding=(async()=>{for(let i=0;i<stress.length;i+=257){model.write(stress.slice(i,i+257));if(i%1028===0)await delay(1);}await new Promise(r=>model.snapshot(r));})();
 await delay(30);await page.reload();await enter();await feeding;
 await until(async()=>(await page.evaluate(screen)).some(s=>s.includes('STRESS-6999')));
 assert.deepStrictEqual(await page.evaluate(screen),expected());
 assert.equal(await page.evaluate(()=>term.modes.mouseTrackingMode),'any');
 console.log('PASS 7000 live redraws with split control sequences and a concurrent fresh snapshot');
 // Preserve an origin-relative cursor and a pending wrap as well as margins.
 model.write('\x1b[?6h\x1b[3;1H'+'x'.repeat(cols));await new Promise(r=>model.snapshot(r));
 await page.reload();await enter();
 const cursor=await page.evaluate(()=>({x:term.buffer.active.cursorX,y:term.buffer.active.cursorY,origin:term.modes.originMode}));
 assert.deepStrictEqual(cursor,{x:model.term.buffer.active.cursorX,y:model.term.buffer.active.cursorY,origin:true});
 assert.equal(cursor.x,cols,'fixture did not reach pending wrap');
 model.write('WRAP-TAIL');await new Promise(r=>model.snapshot(r));
 await until(async()=>(await page.evaluate(screen)).some(s=>s.includes('WRAP-TAIL')));
 assert.deepStrictEqual(await page.evaluate(screen),expected());
 console.log('PASS origin-relative cursor and pending wrap survive snapshot and live continuation');
 model.write('\x1b[S'.repeat(100)+'\x1b[T\x1b[L\x1b[M');await new Promise(r=>model.snapshot(r));await delay(250);
 assert.deepStrictEqual(await page.evaluate(screen),expected());
 console.log('PASS partial scroll up/down and insert/delete lines preserve fixed input area');
 assert.deepStrictEqual(errors,[]);
})().catch(async e=>{console.error('FAIL',e.stack);console.error(log.slice(-1000));if(browser){const p=browser.contexts().flatMap(x=>x.pages())[0];if(p){console.error('VIEWPORT',await p.evaluate(screen).catch(()=>null));await p.screenshot({path:path.join(dir,'failure.png')}).catch(()=>{});}}console.error('Artifacts:',dir);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(agent)agent.terminate();if(model)model.dispose();if(server)server.kill();if(!process.exitCode&&!process.env.KEEP_TEST_ARTIFACTS)fs.rmSync(dir,{recursive:true,force:true});else console.log('Saved artifacts:',dir);});
