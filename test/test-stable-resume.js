'use strict';
// A real broker with persistent terminal models verifies sequence recovery,
// stable identities and explicit rejection of the removed protocol.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const WebSocket = require('ws');
const { TerminalState } = require('../terminal-state');
const { PROTOCOL_VERSION } = require('../terminal-protocol');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-resume-'));
const port = 21000 + Math.floor(Math.random() * 1000);
const cfg = path.join(dir, 'server.json');
fs.writeFileSync(cfg, JSON.stringify({server:{port,password:'pw',tokens:{token:{user:'test'}},supervisor:{enabled:false}}}));
let server, log = '';
const sockets = new Set(), models = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const send = (ws, value) => ws.send(JSON.stringify(value));
function next(ws, predicate, trigger) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', receive); reject(Error('timeout: ' + log.slice(-500))); }, 7000);
    function receive(raw) {
      const msg = JSON.parse(raw);
      if (!predicate(msg)) return;
      clearTimeout(timer); ws.off('message', receive); resolve(msg);
    }
    ws.on('message', receive); if (trigger) trigger();
  });
}
function connect() { return new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`); sockets.add(ws);
  ws.on('open', () => resolve(ws)); ws.on('error', reject);
}); }
async function start() {
  server = fork(path.resolve(__dirname, '../server.js'), ['--config=' + cfg], {stdio:['ignore','pipe','pipe','ipc']});
  server.stdout.on('data', data => log += data); server.stderr.on('data', data => log += data);
  for (let i=0;i<60;i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/agents`)).ok) return; } catch {}
    await sleep(50);
  }
  throw Error('server did not start: ' + log);
}
async function browser() {
  const ws = await connect();
  const auth = await next(ws, m => m.type==='auth_ok', () => send(ws,{type:'auth',username:'test',password:'pw'}));
  return {ws, agents:auth.agents};
}
async function agent(model, screen='screen') {
  const ws = await connect();
  model.emit = payload => { if (ws.readyState===ws.OPEN) send(ws,{type:'data',payload}); };
  ws.on('message', raw => {
    const msg=JSON.parse(raw);
    if (msg.type==='terminal_snapshot_request') model.snapshot(snapshot => send(ws,{type:'terminal_snapshot_result',reqId:msg.reqId,...snapshot}));
  });
  send(ws,{type:'register',protocolVersion:PROTOCOL_VERSION,token:'token',name:'fixture',screen,attrs:{clientId:'stable-client'},cols:80,rows:24});
  await sleep(100); return ws;
}
function replay(ws, request, count=1) {
  return new Promise((resolve,reject)=>{
    const frames=[];let ready=0;
    const timer=setTimeout(()=>{ws.off('message',receive);reject(Error('replay timed out'));},7000);
    function receive(raw) {
      const msg=JSON.parse(raw);frames.push(msg);
      if(msg.type==='terminal_ready' && ++ready===count) {clearTimeout(timer);ws.off('message',receive);resolve(frames);}
    }
    ws.on('message',receive);send(ws,request);
  });
}
function snapshotText(frames) {return Buffer.from(frames.find(m=>m.type==='terminal_snapshot').payload,'base64').toString();}
(async()=>{
  await start();
  // Missing version and identity must fail explicitly, even with a valid token.
  for (const patch of [{protocolVersion:undefined},{attrs:{}},{cols:0}]) {
    const ws=await connect();
    const error=await next(ws,m=>m.type==='error',()=>send(ws,{type:'register',protocolVersion:PROTOCOL_VERSION,token:'token',screen:'s',attrs:{clientId:'id'},cols:80,rows:24,...patch}));
    assert(error.message.includes('protocol 2 required'));ws.close();
  }
  console.log('PASS old protocol, missing identity and invalid size rejected');
  const model=new TerminalState(80,24,()=>{});models.push(model);
  let aws=await agent(model);
  for(let i=1;i<=5;i++)model.write(`LINE-${i}\r\n`);
  await sleep(100);
  const first=await browser();let id=first.agents[0].id;
  const initial=await replay(first.ws,{type:'connect',agentId:id});
  assert(snapshotText(initial).includes('LINE-1'));
  const anchor=initial.find(m=>m.type==='terminal_snapshot').seq;
  assert(Number.isFinite(anchor));
  assert(!initial.some(m=>m.type==='data'));
  model.write('DELTA-1\r\n');model.write('DELTA-2\r\n');await sleep(100);
  const second=await browser();
  const delta=await replay(second.ws,{type:'connect',agentId:id,resume:true,sinceSeq:anchor});
  assert.equal(delta.filter(m=>m.type==='data').map(m=>Buffer.from(m.payload,'base64').toString()).join(''),'DELTA-1\r\nDELTA-2\r\n');
  assert(!delta.some(m=>m.type==='terminal_snapshot'));
  const end=delta.find(m=>m.type==='terminal_ready').lastSeq;
  const empty=await replay(second.ws,{type:'connect',agentId:id,resume:true,sinceSeq:end});
  assert(!empty.some(m=>m.type==='data'||m.type==='terminal_snapshot'));
  const stale=await replay(second.ws,{type:'connect',agentId:id,resume:true,sinceSeq:1});
  assert(snapshotText(stale).includes('LINE-1'));assert(!stale.some(m=>m.type==='data'));
  console.log('PASS fresh snapshot, contiguous delta, empty delta and gap snapshot');
  const previous=id;await new Promise(resolve=>{aws.once('close',resolve);aws.close();});
  model.write('OFFLINE-OUTPUT\r\n');
  aws=await agent(model);
  const third=await browser();id=third.agents[0].id;
  assert.notEqual(id,previous);assert.equal(third.agents[0].attrs.clientId,'stable-client');
  const recovered=await replay(third.ws,{type:'connect',agentId:id,resume:true,sinceSeq:end});
  assert(snapshotText(recovered).includes('OFFLINE-OUTPUT'));assert(snapshotText(recovered).includes('LINE-1'));
  assert(!recovered.some(m=>m.type==='data'));
  console.log('PASS agent reconnect preserves model and invalidates incomplete delta cache');
  const another=new TerminalState(80,24,()=>{});models.push(another);await agent(another,'other');
  another.write('OTHER-SCREEN\r\n');await sleep(100);
  const multi=await browser();const ids=multi.agents.map(a=>a.id);
  const frames=await replay(multi.ws,{type:'connect_multi',agentIds:ids,resume:true,sinceSeqs:{}},2);
  assert.equal(frames.filter(m=>m.type==='terminal_snapshot').length,2);
  console.log('PASS multi resume with unknown positions takes independent snapshots');
  await new Promise(resolve=>{server.once('exit',resolve);server.kill();});
  await start();await agent(model);const restarted=await browser();id=restarted.agents[0].id;
  const final=await replay(restarted.ws,{type:'connect',agentId:id,resume:true,sinceSeq:end});
  assert(snapshotText(final).includes('OFFLINE-OUTPUT'));assert(!final.some(m=>m.type==='data'));
  console.log('PASS broker restart recovers rendered history from agent without raw tail');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{
  for(const ws of sockets)ws.terminate();for(const model of models)model.dispose();
  server?.kill();fs.rmSync(dir,{recursive:true,force:true});
});
