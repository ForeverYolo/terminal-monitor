'use strict';
// A synthetic legacy rollout is loaded by the real Codex TUI. No prompt is
// submitted and no agent/model work is started. All Codex state is temporary.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
module.exports = function prepareCodexHistory(root, cwd) {
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const auth = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.existsSync(auth)) {
    fs.copyFileSync(auth, path.join(root, 'auth.json'));
    fs.chmodSync(path.join(root, 'auth.json'), 0o600);
  }
  // Worktree trust resolves to the common repository; this changes only the
  // isolated test configuration, not the user's configuration.
  const common = require('child_process').execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {cwd, encoding:'utf8'}).trim();
  const repo = path.dirname(common);
  fs.writeFileSync(path.join(root, 'config.toml'), `check_for_update_on_startup=false\n[tui]\nalternate_screen="always"\nanimations=false\n[projects.${JSON.stringify(repo)}]\ntrust_level="trusted"\n`);
  const entries = [{ timestamp, type:'session_meta', payload: {
    id, timestamp, cwd, originator:'codex_cli_rs', cli_version:'0.159.3', source:'cli',
    model_provider:'openai', base_instructions:{text:'Historical UI fixture. No tasks to execute.'}
  }}];
  for (let i=0;i<50;i++) {
    const user=`USER-${String(i).padStart(3,'0')} display fixture`;
    const answer=`ANSWER-${String(i).padStart(3,'0')}\n`+Array.from({length:5},(_,n)=>`history line ${i}:${n}`).join('\n');
    entries.push({timestamp,type:'event_msg',payload:{type:'user_message',message:user,images:[]}});
    entries.push({timestamp,type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:user}]}});
    entries.push({timestamp,type:'event_msg',payload:{type:'agent_message',message:answer,phase:'final_answer'}});
    entries.push({timestamp,type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:answer}]}});
  }
  const sessions=path.join(root,'sessions',timestamp.slice(0,4),timestamp.slice(5,7),timestamp.slice(8,10));
  fs.mkdirSync(sessions,{recursive:true});
  fs.writeFileSync(path.join(sessions,`rollout-${timestamp.replace(/[:.]/g,'-')}-${id}.jsonl`),entries.map(x=>JSON.stringify(x)).join('\n')+'\n');
  return ['env', `CODEX_HOME=${root}`, process.env.CODEX_BIN || 'codex', '--no-daemon', 'resume', id, '-C', cwd];
};
