'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readProcess, processApp, screenProcesses } = require('./cli-process');
const { socketPath } = require('./cli-hooks');

function codexHome(pid) {
  const env = Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').map(line => {
    const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
  }));
  return fs.realpathSync(env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex'));
}
function cliCwd(pid) {
  const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  const base = fs.realpathSync(`/proc/${pid}/cwd`);
  let directory = base;
  for (let i = 1; i < args.length && args[i] !== '--'; i++) {
    if (args[i] === '-C' || args[i] === '--cd') directory = path.resolve(base, args[++i]);
    else if (/^(?:-C|--cd)=/.test(args[i])) directory = path.resolve(base, args[i].slice(args[i].indexOf('=') + 1));
  }
  return fs.realpathSync(directory);
}
function hookRoute(app, payload) {
  let cli = null, daemon = null;
  for (let p = readProcess(process.ppid), depth = 0; p && depth < 32; p = readProcess(p.ppid), depth++) {
    if (processApp(p.pid) !== app) continue;
    if (cli && p.tty !== cli.tty) break;
    cli = p;
    if (!p.tty) {
      const args = fs.readFileSync(`/proc/${p.pid}/cmdline`, 'utf8').split('\0');
      if (app === 'codex' && args[1] === 'app-server' && args.includes('--managed-daemon')) daemon = p;
      break;
    }
  }
  if (!cli) return null;
  // Direct CLI children retain their Screen ancestry. Never reinterpret an
  // ordinary background CLI, shell, or Claude event as a shared Codex event.
  if (cli.tty) return process.env.STY ? { cli, screen: process.env.STY } : null;
  if (!daemon || typeof payload.cwd !== 'string' || !path.isAbsolute(payload.cwd)) return null;
  const cwd = fs.realpathSync(payload.cwd);
  if (cwd !== fs.realpathSync(process.cwd())) return null;
  const home = codexHome(daemon.pid);
  const dir = process.env.SCREENDIR || `/run/screen/S-${os.userInfo().username}`;
  const matches = [];
  // Count all matching Screen CLIs, including unmonitored ones. Two clients in
  // one project are ambiguous; a stale inherited STY cannot break the tie.
  for (const screen of fs.readdirSync(dir)) {
    const processes = screenProcesses(screen);
    if (!processes) continue;
    for (const candidate of processes.clis) {
      if (candidate.app !== 'codex') continue;
      try {
        if (cliCwd(candidate.pid) === cwd && codexHome(candidate.pid) === home)
          matches.push({ cli: candidate, screen, count: processes.clis.length });
      } catch { return null; }
    }
  }
  if (matches.length !== 1 || matches[0].count !== 1) return null;
  const match = matches[0], current = readProcess(match.cli.pid);
  if (!current || current.start !== match.cli.start) return null;
  const socket = fs.lstatSync(socketPath(match.screen));
  if (!socket.isSocket() || (process.getuid && socket.uid !== process.getuid())) return null;
  return match;
}
module.exports = { hookRoute };
