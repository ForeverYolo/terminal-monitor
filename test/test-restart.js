'use strict';
// Exercise restart.sh with real Screen and disposable Node services. Remote
// transport is replaced with a local SSH stub; no production server is used.
const assert=require('assert');
const fs=require('fs'),os=require('os'),path=require('path');
const {spawn,execFileSync}=require('child_process');
const project=path.resolve(__dirname,'..');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'swt-restart-'));
const local=path.join(root,"local project 'quoted'"),remote=path.join(root,'remote project');
const session=`restart-${process.pid}`,sibling=`restart-other-${process.pid}`;
const screens=new Set([session,`swt-client-${session}`,`swt-client-${sibling}`]);
const children=[];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await delay(100);}throw Error('fixture timed out');}
const fixture=`const fs=require('fs');
let arg=process.argv.find(a=>a.startsWith('--config='));
const file=arg?arg.slice(9):'config.json';
const cfg=JSON.parse(fs.readFileSync(file));
fs.writeFileSync(file+'.pid',JSON.stringify({pid:process.pid,nativeTui:cfg.client?.nativeTui}));
setInterval(()=>{},1000);`;
function prepare(dir){
 fs.mkdirSync(dir,{recursive:true});fs.copyFileSync(path.join(project,'restart.sh'),path.join(dir,'restart.sh'));
 fs.writeFileSync(path.join(dir,'client.js'),fixture);fs.writeFileSync(path.join(dir,'server.js'),fixture);
 fs.writeFileSync(path.join(dir,'terminal-state.js'),'module.exports={};');
 for(const dep of ['node-pty','ws']){fs.mkdirSync(path.join(dir,'node_modules',dep),{recursive:true});fs.writeFileSync(path.join(dir,'node_modules',dep,'index.js'),'module.exports={};');}
 for(const name of [session,sibling])fs.writeFileSync(path.join(dir,`config.client-${name}.json`),JSON.stringify({client:{nativeTui:true}}));
 fs.writeFileSync(path.join(dir,'config.json'),'{}');
}
function start(dir,args){const child=spawn(process.execPath,args,{cwd:dir,stdio:'ignore'});children.push(child);return child;}
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
function info(dir,name){try{return JSON.parse(fs.readFileSync(path.join(dir,name+'.pid')));}catch{return null;}}
function screenPid(name){const text=execFileSync('screen',['-ls'],{encoding:'utf8'});return text.split('\n').map(s=>s.trim().split(/\s+/)[0]).find(s=>s.slice(s.indexOf('.')+1)===name);}
async function run(dir,args,env={}){
 return new Promise((resolve,reject)=>{
  const child=spawn('bash',[path.join(dir,'restart.sh'),...args],{cwd:os.tmpdir(),env:{...process.env,...env}});
  let out='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>out+=x);
  child.on('error',reject);child.on('exit',code=>resolve({code,out}));
 });
}
(async()=>{
 prepare(local);prepare(remote);
 const bin=path.join(root,'bin'),sshLog=path.join(root,'ssh.json');fs.mkdirSync(bin);
 fs.writeFileSync(path.join(bin,'ssh'),'#!/bin/bash\nprintf "%s\\n" "$@" > "$SSH_FIXTURE_LOG"\nexec bash -s\n',{mode:0o755});
 const env={PATH:bin+':'+process.env.PATH,SSH_FIXTURE_LOG:sshLog};
 for(const args of [['--help'],['-h'],['help'],['client','--help'],['client',session,'--help']]){
  const help=await run(local,args,env);assert.equal(help.code,0,help.out);
  assert(help.out.includes('deploy.targets.conf')&&help.out.includes('service'));
  assert(!fs.existsSync(sshLog),'help called SSH');
  assert(!info(local,`config.client-${session}.json`),'help started a client');
  assert(!info(local,'config.json'),'help started a server');
 }
 console.log('PASS help aliases exit successfully without configuration, SSH or service startup');
 execFileSync('screen',['-dmS',session,'sleep','300']);const task=screenPid(session);
 const siblingChild=start(local,['client.js',`--config=config.client-${sibling}.json`]);
 await until(()=>info(local,`config.client-${sibling}.json`));
 let result=await run(local,['client',session],env);assert.equal(result.code,0,result.out);
 assert(!fs.existsSync(sshLog),'local mode called SSH');assert(!fs.existsSync(path.join(local,'deploy.targets.conf')));
 const first=info(local,`config.client-${session}.json`);assert(first?.nativeTui);assert(alive(first.pid));
 assert.equal(screenPid(session),task);assert(alive(siblingChild.pid));
 console.log('PASS default local restart without deploy config or SSH, quoted path, task/sibling preserved');
 // Leave an unattached duplicate process, as can happen after Screen SIGHUP.
 const orphan=start(local,['client.js',`--config=config.client-${session}.json`]);
 await until(()=>info(local,`config.client-${session}.json`)?.pid===orphan.pid);
 result=await run(local,['client',session,'--local','service'],env);assert.equal(result.code,0,result.out);
 const second=info(local,`config.client-${session}.json`);assert(second.pid!==first.pid&&second.pid!==orphan.pid);
 assert(!alive(first.pid));assert(!alive(orphan.pid));assert(alive(siblingChild.pid));assert.equal(screenPid(session),task);
 console.log('PASS explicit local restart removes only matching clients, including an orphan');
 const cfg=path.join(local,`config.client-${session}.json`);fs.writeFileSync(cfg+'.stop','');
 result=await run(local,['client',session],env);assert.equal(result.code,0,result.out);assert(alive(second.pid));fs.unlinkSync(cfg+'.stop');
 fs.writeFileSync(cfg,'{invalid');result=await run(local,['client',session],env);assert.notEqual(result.code,0);assert(alive(second.pid));
 fs.writeFileSync(cfg,JSON.stringify({client:{nativeTui:true}}));
 result=await run(local,['client',session,'--local','invalid'],env);assert.notEqual(result.code,0);assert(alive(second.pid));
 console.log('PASS stopped-node marker and invalid config/scope cause no service interruption');
 // Close the local fixture service before exercising the remote transport.
 execFileSync('screen',['-S',`swt-client-${session}`,'-X','quit']);
 if(alive(second.pid))process.kill(second.pid,'SIGTERM');
 fs.writeFileSync(path.join(local,'deploy.targets.conf'),`# fixture\nremote|fixture|example.invalid|2222|${remote}\n`);
 result=await run(local,['client',session,'remote'],env);assert.equal(result.code,0,result.out);
 assert.deepStrictEqual(fs.readFileSync(sshLog,'utf8').trim().split('\n'),['-p','2222','fixture@example.invalid','bash -s']);
 assert(alive(info(remote,`config.client-${session}.json`).pid));assert.equal(screenPid(session),task);
 console.log('PASS remote label still uses deploy configuration and SSH with the same restart worker');
 // Server Screen has a fixed name: isolate it in a separate Screen socket dir.
 const socket=path.join(root,'screen-sockets');fs.mkdirSync(socket,{mode:0o700});
 try{
  result=await run(local,['server'],{...env,SCREENDIR:socket});assert.equal(result.code,0,result.out);
  const server=info(local,'config.json');assert(alive(server.pid));
  result=await run(local,['server','--local'],{...env,SCREENDIR:socket});assert.equal(result.code,0,result.out);
  assert(info(local,'config.json').pid!==server.pid);assert(!alive(server.pid));
  console.log('PASS server defaults to local and supports explicit --local');
 }finally{try{execFileSync('screen',['-S','swt-server','-X','quit'],{env:{...process.env,SCREENDIR:socket},stdio:'ignore'});}catch{}}
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
 for(const name of screens){try{execFileSync('screen',['-S',name,'-X','quit'],{stdio:'ignore'});}catch{}}
 for(const c of children)if(alive(c.pid))c.kill();
 for(const dir of [local,remote])for(const name of [`config.client-${session}.json`,`config.client-${sibling}.json`,'config.json']){const state=info(dir,name);if(state&&alive(state.pid))try{process.kill(state.pid,'SIGTERM');}catch{}}
 await delay(200);fs.rmSync(root,{recursive:true,force:true});
});
