'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { spawn, execFileSync } = require('child_process');
const project = path.resolve(__dirname,'..');
const root = fs.mkdtempSync(path.join(os.tmpdir(),'swt-self-restart-'));
const dir = path.join(root,"project 'quoted'"), screenDir = path.join(root,'screens');
fs.mkdirSync(dir);fs.mkdirSync(screenDir,{mode:0o700});
const env = {...process.env,SCREENDIR:screenDir};
const children = [];
const screen = args => execFileSync('screen',args,{env,stdio:'pipe'});
const delay = ms => new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=18000){const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await delay(100);}throw Error('self-restart timed out');}
const cfg = path.join(root,"custom config='value'.json");
fs.writeFileSync(cfg,'{}');
for(const f of ['service-restart.js','service-runtime.sh'])fs.copyFileSync(path.join(project,f),path.join(dir,f));
const fixture=`const fs=require('fs');const cfg=process.argv.find(a=>a.startsWith('--config=')).slice(9);JSON.parse(fs.readFileSync(cfg));fs.writeFileSync(cfg+'.pid',JSON.stringify({pid:process.pid,config:cfg}));setInterval(()=>{},1000);`;
fs.writeFileSync(path.join(dir,'client.js'),fixture);fs.writeFileSync(path.join(dir,'server.js'),fixture);
function pid(){try{return JSON.parse(fs.readFileSync(cfg+'.pid')).pid;}catch{return null;}}
function live(id){try{process.kill(id,0);return true;}catch{return false;}}
function restart(method,options){
 const child=spawn(process.execPath,['-e',`require(process.argv[1])[process.argv[2]](JSON.parse(process.argv[3]));`,path.join(dir,'service-restart.js'),method,JSON.stringify(options)],{env,stdio:'inherit'});
 children.push(child);return new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('launcher failed')));});
}
(async()=>{
 screen(['-dmS','self-task','bash']);
 const client=spawn(process.execPath,[path.join(dir,'client.js'),'--config='+cfg],{env,cwd:root,stdio:'inherit'});children.push(client);
 await until(()=>pid()===client.pid);
 await restart('restartClient',{root:dir,node:process.execPath,configFile:cfg,screenName:'self-task',pid:client.pid});
 await until(()=>pid()&&pid()!==client.pid&&live(pid()));
 assert(screen(['-ls']).toString().includes('.self-task'));
 assert(screen(['-ls']).toString().includes('.swt-client-self-task'));
 console.log('PASS client self-restart preserves task and quoted external configuration');
 screen(['-S','swt-client-self-task','-X','quit']);
 await delay(300);
 const backup=path.join(dir,'backup');fs.mkdirSync(backup);
 fs.writeFileSync(path.join(backup,'server.js'),fixture);
 fs.writeFileSync(path.join(dir,'server.js'),"throw Error('deliberate restart fixture failure');");
 await restart('restartServer',{root:dir,node:process.execPath,configFile:cfg,backup});
 const old=pid();await until(()=>pid()&&pid()!==old&&live(pid()));
 assert.equal(fs.readFileSync(path.join(dir,'server.js'),'utf8'),fixture);
 assert(screen(['-ls']).toString().includes('.swt-server'));
 console.log('PASS server self-restart restores backup and preserves explicit configuration');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
 for(const name of ['swt-client-self-task','self-task','swt-server']){try{screen(['-S',name,'-X','quit']);}catch{}}
 for(const child of children){try{child.kill();}catch{}}
 await delay(200);fs.rmSync(root,{recursive:true,force:true});
});
