'use strict';
// Read the installed Codex's hook catalog in a private home. No thread/model
// starts, hook execution, trust bypass, or interaction with user sessions.
if(process.env.RUN_LOCAL_CODEX_HOOK_SETUP_TEST!=='1'){console.log('SKIP native Codex inline hook catalog');process.exit(0)}
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),{spawn,execFileSync}=require('child_process');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'swt-inline-codex-')),project=path.join(temp,'project'),home=path.join(temp,'codex-home');
let child,timer;const pending=new Map();let id=0,buffer='';
function call(method,params){return new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});child.stdin.write(JSON.stringify({id:n,method,params})+'\n')})}
(async()=>{
 fs.mkdirSync(project);fs.mkdirSync(home);fs.mkdirSync(path.join(project,'.codex'));
 fs.writeFileSync(path.join(home,'config.toml'),'[projects.'+JSON.stringify(project)+']\ntrust_level="trusted"\n');
 const file=path.join(project,'.codex/config.toml'),inline='[[hooks.PreToolUse]]\nmatcher="^fixture_only$"\n[[hooks.PreToolUse.hooks]]\ntype="command"\ncommand="echo keep-inline"\n';fs.writeFileSync(file,inline);
 const config=execFileSync(process.execPath,[path.join(__dirname,'../cli-hook.js'),'codex','--print-config']);fs.writeFileSync(path.join(project,'.codex/hooks.json'),config);
 child=spawn(process.env.CODEX_BIN||'codex',['app-server'],{cwd:project,env:{...process.env,CODEX_HOME:home},stdio:['pipe','pipe','pipe']});
 child.stdout.on('data',d=>{buffer+=d;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{const m=JSON.parse(line),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}}catch{}}});
 child.stderr.resume();child.on('error',e=>{for(const p of pending.values())p.reject(e)});
 timer=setTimeout(()=>{for(const p of pending.values())p.reject(Error('native hook catalog timeout'));child.kill()},20000);
 await call('initialize',{clientInfo:{name:'terminal_monitor_inline_test',version:'1.0.0'},capabilities:{experimentalApi:true}});child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
 const result=await call('hooks/list',{cwds:[project]});const hooks=[];
 function collect(v){if(!v||typeof v!=='object')return;if(typeof v.command==='string'&&v.eventName)hooks.push(v);for(const x of Object.values(v))if(typeof x==='object')collect(x)}collect(result);
 assert.equal(hooks.length,9,'both inline custom hook and eight JSON adapters must be discoverable');assert.equal(hooks.filter(h=>h.eventName==='preToolUse').length,2);assert(hooks.some(h=>h.command==='echo keep-inline'));
 assert.equal(fs.readFileSync(file,'utf8'),inline);assert(fs.readFileSync(path.join(project,'.codex/hooks.json')).equals(config));
 console.log('PASS native Codex loads inline TOML plus eight JSON hooks; both files unchanged; no thread, model request, or hook execution');
})().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>{clearTimeout(timer);child?.kill();fs.rmSync(temp,{recursive:true,force:true})});
