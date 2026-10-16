'use strict';
const assert = require('assert');
const { createTerminalReplay } = require('../terminal-replay');
const frame = seq => ({seq,payload:Buffer.from(String(seq)).toString('base64')});
const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  const sent=[], requests=[];
  const agent={id:'agent',ws:{OPEN:1,readyState:1,send:raw=>requests.push(JSON.parse(raw))},term:{scrollback:[1,2,3,4,5].map(frame)}};
  const ws={OPEN:1,readyState:1,send:raw=>sent.push(JSON.parse(raw))};
  const info={agentIds:new Set(['agent'])};
  const replay=createTerminalReplay({agents:new Map([[agent.ws,agent]]),browsers:new Map([[ws,info]]),batchSize:1});
  replay.subscribe(ws,agent,{resume:true,sinceSeq:1});
  // Simulate server cache trimming and incoming live output between batches.
  agent.term.scrollback.splice(0,4);
  info.pendingLive=new Map([['agent',[JSON.stringify({type:'data',...frame(6),agentId:'agent'})]]]);
  for(let i=0;i<5;i++)await tick();
  assert.deepStrictEqual(sent.filter(m=>m.type==='data').map(m=>m.seq),[2,3,4,5,6]);
  assert(sent.findIndex(m=>m.type==='terminal_ready')<sent.findIndex(m=>m.seq===6));
  assert.equal(info.replaying.size,0);
  console.log('PASS delta remains ordered during cache trimming and live output');
  sent.length=0;agent.term.scrollback=[1,2,3,4,5].map(frame);
  replay.subscribe(ws,agent,{resume:true,sinceSeq:1});
  replay.subscribe(ws,agent,{}); // Snapshot replaces an in-flight delta.
  assert.equal(requests.at(-1).type,'terminal_snapshot_request');
  for(let i=0;i<5;i++)await tick();
  assert.deepStrictEqual(sent.filter(m=>m.type==='data').map(m=>m.seq),[2]);
  assert(!sent.some(m=>m.type==='terminal_ready'));
  replay.subscribe(ws,agent,{});
  assert.equal(replay.pendingSnapshots.size,1,'superseded snapshot request retained');
  replay.cancelSocket(ws);assert.equal(replay.pendingSnapshots.size,0);
  console.log('PASS replacing a replay cancels stale batches and snapshot timers');
})().catch(e=>{console.error(e);process.exitCode=1;});
