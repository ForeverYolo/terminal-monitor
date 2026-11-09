'use strict';
// Explicit staging-only setup. Owns one isolated hooks file; never changes
// ~/.codex or the user's task sessions. Restart the dedicated task separately
// after this command, so a deployment doesn't silently terminate a task.
const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(process.argv[2] || '/home/renhangqi/terminal-monitor-staging');
if (path.basename(root) !== 'terminal-monitor-staging') throw Error('Expected dedicated staging root');
const commandFile = path.join(root,'runtime/codex-command.json');
const argv = JSON.parse(fs.readFileSync(commandFile));
if (!argv.includes('CODEX_HOME='+path.join(root,'runtime/codex-home')) || !argv.includes(path.join(root,'runtime/sandbox')) || !argv.includes('resume')) throw Error('Unexpected task command; refusing to alter it');
const hookPath = path.join(root,'current/cli-hook.js');
const config = execFileSync(process.execPath,[hookPath,'codex','--print-config'],{encoding:'utf8'});
const file = path.join(root,'runtime/codex-home/hooks.json');
const marker = path.join(root,'runtime/state-hooks-installed');
if (fs.existsSync(file) && !fs.existsSync(marker)) throw Error('Existing hooks file is not owned by this setup; merge it manually');
if (!fs.existsSync(commandFile+'.before-state-hooks')) fs.copyFileSync(commandFile,commandFile+'.before-state-hooks');
fs.writeFileSync(file,config,{mode:0o600});
// This isolated home contains only the generated observe-only test hooks.
if (!argv.includes('--dangerously-bypass-hook-trust')) argv.splice(argv.indexOf('resume'),0,'--dangerously-bypass-hook-trust');
fs.writeFileSync(commandFile,JSON.stringify(argv),{mode:0o600});
fs.writeFileSync(marker,'Generated observe-only staging hooks\n',{mode:0o600});
// A bare `claude` launched from the test shell loads project-local settings.
// Merge observe-only hooks there instead of changing the user's global home.
const claudeDir = path.join(root,'runtime/sandbox/.claude');
fs.mkdirSync(claudeDir,{recursive:true});
const claudeFile = path.join(claudeDir,'settings.local.json');
const claudeConfig = fs.existsSync(claudeFile) ? JSON.parse(fs.readFileSync(claudeFile,'utf8')) : {};
const generated = JSON.parse(execFileSync(process.execPath,[hookPath,'claude','--print-config'],{encoding:'utf8'}));
claudeConfig.hooks = claudeConfig.hooks || {};
for (const [event,groups] of Object.entries(generated.hooks)) {
  const existing = claudeConfig.hooks[event] || [];
  claudeConfig.hooks[event] = existing.map(group => ({...group,hooks:(group.hooks || []).filter(h=>!(typeof h.command==='string' && h.command.includes(hookPath)))})).filter(group=>group.hooks.length).concat(groups);
}
fs.writeFileSync(claudeFile,JSON.stringify(claudeConfig,null,2)+'\n',{mode:0o600});
console.log('Installed scoped Codex and Claude hooks; running CLIs may need restart to load configuration.');
