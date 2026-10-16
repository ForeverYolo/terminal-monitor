'use strict';
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const {spawnSync}=require('child_process');
const {DEPLOY_FILES}=require('../managed-files');
const project=path.resolve(__dirname,'..'),root=fs.mkdtempSync(path.join(os.tmpdir(),'swt-deploy-'));
try {
 const dir=path.join(root,"project 'quoted'"),bin=path.join(root,'bin'),capture=path.join(root,'capture.jsonl');fs.mkdirSync(dir);fs.mkdirSync(bin);
 for(const file of [...DEPLOY_FILES,'deploy.sh']){fs.mkdirSync(path.dirname(path.join(dir,file)),{recursive:true});fs.copyFileSync(path.join(project,file),path.join(dir,file));}
 fs.writeFileSync(path.join(dir,'deploy.targets.conf'),"fixture|tester|example.invalid|22|/tmp/remote project 'quoted'\n");
 for(const command of ['ssh','scp'])fs.writeFileSync(path.join(bin,command),`#!/usr/bin/env node\nrequire('fs').appendFileSync(process.env.DEPLOY_CAPTURE,JSON.stringify({command:${JSON.stringify(command)},args:process.argv.slice(2)})+'\\n');`,{mode:0o755});
 const run=args=>spawnSync('bash',[path.join(dir,'deploy.sh'),...args],{cwd:root,env:{...process.env,PATH:bin+':'+process.env.PATH,DEPLOY_CAPTURE:capture},encoding:'utf8'});
 const result=run([]);assert.equal(result.status,0,result.stdout+result.stderr);
 const records=fs.readFileSync(capture,'utf8').trim().split('\n').map(JSON.parse);
 const copies=records.filter(r=>r.command==='scp');assert.equal(copies.length,DEPLOY_FILES.length);
 for(const file of DEPLOY_FILES)assert(copies.some(r=>r.args.includes(path.join(dir,file))),`missing ${file}`);
 assert.equal(records.filter(r=>r.command==='ssh').length,DEPLOY_FILES.length,'remote directories must be prepared');
 assert.notEqual(run(['does-not-exist.js']).status,0,'missing requested files must fail deployment');
 console.log('PASS default deployment includes shared modules, assets and scripts; missing files fail');
} finally {fs.rmSync(root,{recursive:true,force:true});}
