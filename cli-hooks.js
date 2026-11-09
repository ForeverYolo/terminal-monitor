'use strict';
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function socketPath(screen) {
  const uid = process.getuid ? process.getuid() : os.userInfo().username;
  const dir = path.join(os.tmpdir(), `terminal-monitor-hooks-${uid}`);
  return path.join(dir, crypto.createHash('sha256').update(String(screen).replace(/^\d+\./, '')).digest('hex').slice(0, 24) + '.sock');
}
async function createHookReceiver(screen, onEvent, onError = () => {}) {
  const socket = socketPath(screen), dir = path.dirname(socket);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) throw Error('Hook directory must be owned by this user and mode 700');
  if (fs.existsSync(socket)) {
    const alive = await new Promise(resolve => {
      const c = net.createConnection(socket);
      c.setTimeout(500, () => { c.destroy(); resolve(true); });
      c.on('connect', () => { c.destroy(); resolve(true); });
      c.on('error', e => resolve(e.code !== 'ECONNREFUSED' && e.code !== 'ENOENT'));
    });
    if (alive) throw Error('Another monitor owns the hook socket for this Screen');
    const stale = fs.lstatSync(socket);
    if (!stale.isSocket() || (process.getuid && stale.uid !== process.getuid())) throw Error('Invalid stale hook socket');
    fs.unlinkSync(socket);
  }
  const peers = new Set();
  const server = net.createServer(c => {
    if (peers.size >= 16) { c.destroy(); return; }
    peers.add(c);
    c.setTimeout(1500, () => c.destroy());
    let data = '', bytes = 0, handled = false;
    c.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 4096 || handled) { c.destroy(); return; }
      data += chunk.toString('utf8');
      const end = data.indexOf('\n');
      if (end < 0) return;
      handled = true;
      try { const accepted = onEvent(JSON.parse(data.slice(0, end))); c.end(JSON.stringify({ ok: !!accepted }) + '\n'); }
      catch { c.end('{"ok":false}\n'); }
    });
    c.on('error', () => {});
    c.on('close', () => peers.delete(c));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  fs.chmodSync(socket, 0o600);
  server.on('error', onError);
  return { socket, close() { for (const c of peers) c.destroy(); server.close(); } };
}
module.exports = { socketPath, createHookReceiver };
