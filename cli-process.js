'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function readProcess(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { pid: +pid, state: fields[0], ppid: +fields[1], pgrp: +fields[2], tty: +fields[4], foreground: +fields[5], start: fields[19] };
  } catch { return null; }
}
function processApp(pid) {
  try {
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    // Only executable/script slots; never match a task prompt or shell -c text.
    const names = args.slice(0, /^(?:node|python[\d.]*)$/.test(path.basename(args[0] || '')) ? 2 : 1).map(a => path.basename(a));
    if (names.some(n => /^(?:codex|codex\.js)$/.test(n))) return 'codex';
    if (names.some(n => /^(?:claude|claude\.js|claude\.exe)$/.test(n)) || args.slice(0, 2).some(a => /\/@anthropic-ai\/claude-code\/(?:cli\.js|bin\/claude\.exe)$/.test(a))) return 'claude';
    if (names.some(n => /^(?:qoderclicn(?:-[\d.]+)?|qodercli|qoder-cn|qodercn)$/.test(n))) return 'qoder';
  } catch {}
  return null;
}
function processName(pid) {
  try {
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    let name = path.basename(args[0] || '');
    if (/^(?:bash|sh|dash|zsh|fish|screen|SCREEN|env)$/.test(name)) return null;
    if (/^(?:node|nodejs|python[\d.]*|ruby|perl)$/.test(name)) {
      // Only an executable/script slot; never display prompts, -c/-e code,
      // arguments or full paths as a CLI name.
      if (!args[1] || args[1].startsWith('-')) return null;
      name = path.basename(args[1]).replace(/\.(?:js|mjs|cjs|py|rb|pl)$/i, '');
    }
    return /^[\p{L}\p{N}_.+-]{1,64}$/u.test(name) ? name : null;
  } catch { return null; }
}
function screenProcesses(screenName) {
  try {
    const socketDir = process.env.SCREENDIR || `/run/screen/S-${os.userInfo().username}`;
    const sockets = fs.readdirSync(socketDir).filter(n => n === screenName || n.endsWith('.' + screenName));
    if (sockets.length !== 1) return null;
    const screenPid = +sockets[0].split('.')[0];
    const all = new Map(fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).map(readProcess).filter(Boolean).map(p => [p.pid, p]));
    const descendants = [];
    for (const p of all.values()) {
      let q = p;
      for (let depth = 0; q && depth < 32; depth++, q = all.get(q.ppid)) {
        if (q.ppid === screenPid) { descendants.push(p); break; }
      }
    }
    const active = descendants.filter(p => p.tty && p.pgrp === p.foreground && !['T', 't', 'Z'].includes(p.state));
    const candidates = active.map(p => ({ ...p, app: processApp(p.pid) })).filter(p => p.app);
    // Codex has a launcher/TUI and a child app-server with the same executable.
    // They are one CLI instance, not two Screen windows. Bind to the outermost
    // ancestor so a replaced worker cannot resurrect a dead foreground CLI.
    const byPid = new Map(candidates.map(p => [p.pid, p]));
    const clis = candidates.filter(p => {
      let parent = all.get(p.ppid);
      for (let depth = 0; parent && depth < 32; depth++, parent = all.get(parent.ppid)) {
        if (byPid.get(parent.pid)?.app === p.app) return false;
      }
      return true;
    });
    // Unknown foreground programs are naming/lifecycle candidates only. They
    // become a Code CLI only after the independent screen detector accepts UI.
    const named = active.map(p => ({ ...p, app: processApp(p.pid) || 'generic', appName: processName(p.pid) })).filter(p => p.appName);
    const namedPids = new Set(named.map(p => p.pid));
    const foreground = named.filter(p => {
      for (let parent = all.get(p.ppid), depth = 0; parent && depth < 32; parent = all.get(parent.ppid), depth++)
        if (namedPids.has(parent.pid)) return false;
      return true;
    });
    return { screenPid, descendants, clis, foreground };
  } catch { return null; }
}
module.exports = { readProcess, processApp, processName, screenProcesses };
