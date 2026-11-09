'use strict';
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { launchBrowser, routeTerminalAssets, login } = require('./helpers/browser');
const root = path.resolve(__dirname, '..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-cli-browser-'));
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i=0;i<100;i++) { if (await fn()) return; await delay(100); } throw Error('CLI browser timeout'); }
let server, browser, log = ''; const agents = [];
(async () => {
  const port = await new Promise(r => { const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));}); });
  const cfg = path.join(temp,'server.json');
  fs.writeFileSync(cfg,JSON.stringify({mode:'server',server:{host:'127.0.0.1',port,password:'pw',tokens:{token:{user:'test'}},supervisor:{enabled:false}}}));
  server=spawn(process.execPath,[path.join(root,'server.js'),'--config='+cfg],{cwd:root});
  server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d);
  const url=`http://127.0.0.1:${port}`;
  await until(async()=>{try{return(await fetch(url+'/api/agents')).ok;}catch{return false;}});
  for (const name of ['shell','codex','qoder']) {
    const ws=new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});agents.push(ws);
    ws.send(JSON.stringify({type:'register',token:'token',name,screen:'fixture-'+name,attrs:{clientId:'cli-browser'},protocolVersion:2,cols:120,rows:40}));
    ws.send(JSON.stringify({type:'data',payload:Buffer.from(name==='shell'?'\x1b[32muser@host:~$ \x1b[0m\r\n':'CLI fixture').toString('base64')}));
    if(name!=='shell') ws.send(JSON.stringify({type:'cli_state',state:{isCodeCli:true,app:name,status:name==='codex'?'working':'idle',source:name==='codex'?'hooks':'screen'}}));
  }
  await until(async()=> (await(await fetch(url+'/api/agents')).json()).agents.length===3);
  browser=await launchBrowser();const page=await browser.newPage();const errors=[];
  page.on('pageerror',e=>errors.push(e.message));await routeTerminalAssets(page);await login(page,url);
  await page.locator('.agent-card').nth(2).waitFor();
  const card=name=>page.locator('.agent-card').filter({has:page.locator('.name').filter({hasText:name})});
  assert.equal(await card('shell').locator('.status-row').count(),0,'shell must have no work state');
  assert.equal(await card('shell').locator('.claude-badge').count(),0,'shell must have no CLI identity');
  assert.equal(await card('shell').locator('.terminal-preview').innerText(),'user@host:~$','shell prompt preview remains visible independently of work state');
  assert((await card('codex').innerText()).includes('工作中'));assert((await card('codex').innerText()).includes('事件'));
  assert((await card('qoder').innerText()).includes('空闲'));assert((await card('qoder').innerText()).includes('推断'));
  agents[1].send(JSON.stringify({type:'cli_state',state:{isCodeCli:true,app:'codex',status:'waiting_permission',source:'hooks',prompt:'Approve fixture?'}}));
  await until(async()=> (await card('codex').innerText()).includes('等待授权'));
  assert(await card('codex').evaluate(el=>el.classList.contains('attention')));
  agents[1].send(JSON.stringify({type:'cli_state',state:{isCodeCli:false}}));
  await until(async()=> await card('codex').locator('.status-row').count()===0);
  assert(!(await card('codex').evaluate(el=>el.classList.contains('attention'))));
  const data=await(await fetch(url+'/api/agents')).json();
  assert(data.agents.filter(a=>a.name==='shell'||a.name==='codex').every(a=>!a.needsInput&&!a.cliState.isCodeCli));
  await page.reload();await page.locator('.agent-card').nth(2).waitFor();
  assert.equal(await card('shell').locator('.status-row').count(),0);
  assert.equal(await card('shell').locator('.terminal-preview').innerText(),'user@host:~$');
  assert((await card('qoder').innerText()).includes('空闲'));
  assert.deepStrictEqual(errors,[]);
  console.log('PASS browser/API unified state, shell hidden, hooks/screen labels, attention and exit/reload');
})().catch(e=>{console.error(e,log.slice(-1500));process.exitCode=1;}).finally(async()=>{
  if(browser)await browser.close();for(const ws of agents)ws.terminate();if(server)server.kill();fs.rmSync(temp,{recursive:true,force:true});
});
