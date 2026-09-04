const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const WebSocket = require('ws');
const pty = require('node-pty');

// --- Auto-collect system info ---
function collectSysInfo() {
  const info = {};
  info.hostname = os.hostname();
  info.username = os.userInfo().username;
  info.platform = os.platform();
  info.arch = os.arch();
  info.kernel = os.release();
  info.uptime = Math.floor(os.uptime());

  // OS distro
  try {
    const m = fs.readFileSync('/etc/os-release').match(/PRETTY_NAME="(.+)"/);
    info.os = (m && m[1]) || os.type();
  } catch { info.os = os.type(); }

  // IPs
  const nets = os.networkInterfaces();
  info.ips = [];
  for (const [name, addrs] of Object.entries(nets)) {
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) {
        info.ips.push({ iface: name, addr: a.address });
      }
    }
  }

  // CPU
  const cpus = os.cpus();
  info.cpu = (cpus[0] && cpus[0].model) || 'unknown';
  info.cpuCount = cpus.length;

  // Memory (MB)
  info.memTotal = Math.round(os.totalmem() / 1024 / 1024);
  info.memUsed = Math.round((os.totalmem() - os.freemem()) / 1024 / 1024);

  // Load
  info.loadAvg = os.loadavg().map(l => l.toFixed(2));

  // GPU
  try {
    info.gpu = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null', { encoding: 'utf8' }).trim().split('\n').map(s => s.trim());
  } catch { info.gpu = []; }

  // Disk usage for /
  try {
    const df = execSync("df -h / 2>/dev/null | tail -1", { encoding: 'utf8' }).trim().split(/\s+/);
    info.diskTotal = df[1];
    info.diskUsed = df[2];
    info.diskPercent = df[4];
  } catch {}

  return info;
}

// --- Load config (support --config flag for multi-instance) ---
const cfgEqArg = process.argv.find(a => a.startsWith('--config='));
const configArg = (cfgEqArg ? cfgEqArg.split('=')[1] : null)
  || (process.argv.indexOf('--config') !== -1 ? process.argv[process.argv.indexOf('--config') + 1] : null);
const configFile = configArg || path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const { serverUrl, token, name, screen: screenSession, screenMode, attrs } = config.client;

if (!serverUrl || !token || !name) {
  console.error('Missing client config: serverUrl, token, name are required');
  process.exit(1);
}

const screenName = screenSession || 'main';

// --- File transfer config ---
// The "base" used for file_ls / upload / download is the SHELL's current working
// directory inside the screen session, not the node process's cwd. We query it
// on demand by sending `pwd` to the PTY and parsing the first absolute-path line
// out of the response. A static `fileRoot` (from config) is kept only as a
// fallback when the pwd query fails.
const staticFileRoot = path.resolve(config.client.fileRoot || process.cwd());
const MAX_FILE_SIZE = 200 * 1024 * 1024;        // 200MB per file
const CHUNK_SIZE = 256 * 1024;                  // 256KB raw per chunk
const activeUploads = new Map();                // uploadId -> { stream, size, received, target }
const activeDownloads = new Map();              // downloadId -> { rs, aborted }
let lastKnownCwd = null;                        // cached shell cwd from last pwd query

// --- pwd query state machine ---
// pwd writes its result to the PTY and we intercept the next data chunk to
// extract the path. Multiple concurrent callers are coalesced into a single
// in-flight query; they all resolve/reject together when it completes.
let pwdResolvers = [];     // [{ resolve, reject }]
let pwdBuffer = '';
let pwdTimer = null;
let pwdDataListener = null;

function queryShellCwd() {
  return new Promise((resolve, reject) => {
    if (!ptyProcess) {
      reject(new Error('pty not running'));
      return;
    }
    // Coalesce concurrent callers
    if (pwdResolvers.length > 0) {
      pwdResolvers.push({ resolve, reject });
      return;
    }
    pwdResolvers.push({ resolve, reject });
    pwdBuffer = '';

    pwdTimer = setTimeout(() => {
      finishPwdQuery(new Error('pwd query timeout (3s)'));
    }, 3000);

    pwdDataListener = (data) => {
      pwdBuffer += data;
      // Strip OSC sequences and CSI escapes so a colorful prompt doesn't confuse us.
      const stripped = pwdBuffer
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
      const lines = stripped.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (/^[\/~]/.test(line)) {
          let p = line;
          if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1).replace(/^\//, ''));
          finishPwdQuery(null, p);
          return;
        }
      }
    };

    ptyProcess.on('data', pwdDataListener);
    ptyProcess.write('pwd\n');
  });
}

function finishPwdQuery(err, cwd) {
  if (pwdTimer) { clearTimeout(pwdTimer); pwdTimer = null; }
  if (pwdDataListener && ptyProcess) {
    try { ptyProcess.removeListener('data', pwdDataListener); } catch {}
    pwdDataListener = null;
  }
  const resolvers = pwdResolvers;
  pwdResolvers = [];
  pwdBuffer = '';
  if (!err && cwd) lastKnownCwd = cwd;
  for (const { resolve, reject } of resolvers) {
    if (err) reject(err); else resolve(cwd);
  }
}

// Resolve a relative path against a base directory. Returns null if the result
// escapes the base (which itself is constrained to $HOME for safety).
function safeResolveAgainst(base, rel) {
  const resolved = path.resolve(base, rel || '.');
  const home = os.homedir();
  // Allow navigation anywhere under the user's home directory.
  if (resolved !== home && !resolved.startsWith(home + path.sep)) return null;
  return resolved;
}

function sendMsg(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

// -x: multi-display (for attached sessions), -r: reattach (for detached)
// Use large default PTY size so TUI apps (claude, vim, etc.) have room.
// Browser will send actual resize shortly after connecting.
const cols = parseInt(config.client.cols) || 200;
const rows = parseInt(config.client.rows) || 50;
const screenArgs = (screenMode || 'auto') === 'auto'
  ? ['-x', screenName]   // default: -x works for attached sessions
  : screenMode === 'reattach'
    ? ['-r', screenName]
    : ['-x', screenName];

let ws = null;
let ptyProcess = null;
let reconnectDelay = 1000;
const MAX_DELAY = 30000;

// Heartbeat
let hbInterval = null;
let hbTimeout = null;
const HB_INTERVAL = 30000;  // ping every 30s
const HB_TIMEOUT = 90000;   // 90s no response = dead connection

function startHeartbeat() {
  stopHeartbeat();
  hbInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
      // Reset timeout on each ping
      clearTimeout(hbTimeout);
      hbTimeout = setTimeout(() => {
        console.log('[!] Heartbeat timeout, connection may be dead');
        ws.terminate(); // force close, triggers reconnect
      }, HB_TIMEOUT);
    }
  }, HB_INTERVAL);
}

function stopHeartbeat() {
  clearInterval(hbInterval);
  clearTimeout(hbTimeout);
  hbInterval = null;
  hbTimeout = null;
}

function connect() {
  console.log(`Connecting to ${serverUrl} ...`);

  ws = new WebSocket(serverUrl);

  ws.on('open', () => {
    console.log('Connected to server');
    reconnectDelay = 1000;
    startHeartbeat();

    // Spawn PTY with screen
    spawnPty();

    // Register with server
    const sysInfo = collectSysInfo();
    ws.send(JSON.stringify({
      type: 'register',
      token,
      name,
      screen: screenName,
      attrs: attrs || {},
      sys: sysInfo,
      cols,
      rows
    }));
  });

  function spawnPty() {
    if (ptyProcess) {
      ptyProcess.kill();
    }

    ptyProcess = pty.spawn('screen', screenArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      env: { ...process.env, TERM: 'xterm-256color' }
    });

    console.log(`Attached to screen session: ${screenName} (PID: ${ptyProcess.pid})`);

    // Increase screen scrollback (default is only 100 lines)
    setTimeout(() => {
      if (ptyProcess) {
        ptyProcess.write('\x01:scrollback 10000\x0d');
        ptyProcess.write('\x01:defscrollback 10000\x0d');
      }
    }, 500);

    ptyProcess.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'data', payload: Buffer.from(data).toString('base64') }));
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      console.log(`screen exited with code ${exitCode}, respawning in 3s...`);
      ptyProcess = null;
      setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          spawnPty();
        }
      }, 3000);
    });
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch { return; }

    if (msg.type === 'data' && ptyProcess) {
      const input = Buffer.from(msg.payload, 'base64').toString('utf8');
      ptyProcess.write(input);
    }

    if (msg.type === 'resize' && ptyProcess) {
      ptyProcess.resize(msg.cols || cols, msg.rows || rows);
    }

    // Restart screen session: kill PTY so the existing onExit → respawn path
    // re-attaches via `screen -x`. WS stays open; other agents unaffected.
    if (msg.type === 'restart_screen' && ptyProcess) {
      console.log('[!] restart_screen requested — killing PTY for respawn');
      try { ptyProcess.kill(); } catch (e) { console.error('[!] kill failed:', e.message); }
    }

    // Remote kill: server tells us to die
    if (msg.type === 'kill') {
      console.log('[!] Received kill command from server, shutting down...');
      shutdown();
    }

    // Heartbeat: server pong resets our timeout
    if (msg.type === 'pong') {
      clearTimeout(hbTimeout);
    }

    // --- File transfer ---
    if (typeof msg.type === 'string' && msg.type.startsWith('file_')) {
      console.log('[file] recv', msg.type, msg.reqId || msg.uploadId || msg.downloadId || '');
      handleFileMsg(msg).catch(e => console.error('[file] handler error:', e.message));
    }
  });

  // --- File transfer handlers ---
  async function handleFileMsg(msg) {
    const agentId = msg.agentId;  // echoed back in responses for routing
    try {
      if (msg.type === 'file_ls') return await handleFileLs(msg);
      if (msg.type === 'file_upload_start') return await handleUploadStart(msg);
      if (msg.type === 'file_chunk') return handleUploadChunk(msg);
      if (msg.type === 'file_upload_end') return handleUploadEnd(msg);
      if (msg.type === 'file_download_start') return await handleDownloadStart(msg);
    } catch (e) {
      console.error('[file] error:', e.message);
    }
  }

  async function handleFileLs(msg) {
    console.log('[file] file_ls start, dir=', msg.dir);
    let cwd;
    try {
      cwd = await queryShellCwd();
      console.log('[file] pwd resolved:', cwd);
    } catch (e) {
      console.log('[file] pwd failed:', e.message);
      // pwd failed — fall back to staticFileRoot so the user can still see files.
      cwd = lastKnownCwd || staticFileRoot;
    }
    const base = cwd || staticFileRoot;
    const target = safeResolveAgainst(base, msg.dir || '.');
    if (!target) {
      sendMsg({ type: 'file_ls_result', agentId: msg.agentId, reqId: msg.reqId, dir: msg.dir || '', error: '路径超出允许范围（仅限 $HOME 内）' });
      return;
    }
    try {
      const entries = await fs.promises.readdir(target, { withFileTypes: true });
      const result = [];
      for (const ent of entries) {
        const full = path.join(target, ent.name);
        let size = 0, mtime = 0, isDir = ent.isDirectory();
        try {
          const st = await fs.promises.stat(full);
          size = st.size; mtime = st.mtimeMs; isDir = st.isDirectory();
        } catch { /* unreadable entry: include with zero stat */ }
        result.push({ name: ent.name, size, mtime, isDir });
      }
      result.sort((a, b) => (a.isDir === b.isDir) ? a.name.localeCompare(b.name) : (a.isDir ? -1 : 1));
      // Compute display path: relative to base when inside, else absolute
      let displayPath;
      if (target === base) displayPath = '.';
      else if (target.startsWith(base + path.sep)) displayPath = path.relative(base, target);
      else displayPath = target;
      console.log('[file] file_ls ok, cwd=', base, 'target=', target, 'n=', result.length);
      sendMsg({
        type: 'file_ls_result',
        agentId: msg.agentId,
        reqId: msg.reqId,
        dir: msg.dir || '',
        cwd: base,
        displayPath,
        entries: result
      });
    } catch (e) {
      sendMsg({ type: 'file_ls_result', agentId: msg.agentId, reqId: msg.reqId, dir: msg.dir || '', cwd: base, error: e.message });
    }
  }

  async function handleUploadStart(msg) {
    const filename = path.basename(msg.filename || '');   // strip any dir components
    if (!filename || filename === '.' || filename === '..') {
      sendMsg({ type: 'file_upload_ack', agentId: msg.agentId, uploadId: msg.uploadId, ok: false, error: 'Invalid filename' });
      return;
    }
    if (!Number.isFinite(msg.size) || msg.size <= 0 || msg.size > MAX_FILE_SIZE) {
      sendMsg({ type: 'file_upload_ack', agentId: msg.agentId, uploadId: msg.uploadId, ok: false, error: `Size out of range (max ${MAX_FILE_SIZE} bytes)` });
      return;
    }
    let cwd;
    try {
      cwd = await queryShellCwd();
    } catch (e) {
      cwd = lastKnownCwd || staticFileRoot;
    }
    const base = cwd || staticFileRoot;
    const target = safeResolveAgainst(base, filename);
    if (!target) {
      sendMsg({ type: 'file_upload_ack', agentId: msg.agentId, uploadId: msg.uploadId, ok: false, error: 'Invalid target path' });
      return;
    }
    try {
      const stream = fs.createWriteStream(target, { flags: 'w' });
      await new Promise((res, rej) => {
        stream.once('open', res);
        stream.once('error', rej);
      });
      stream.removeAllListeners('error');
      stream.on('error', (e) => {
        console.error('[file] upload stream error:', e.message);
        activeUploads.delete(msg.uploadId);
        try { stream.destroy(); } catch {}
        sendMsg({ type: 'file_upload_done', agentId: msg.agentId, uploadId: msg.uploadId, ok: false, error: e.message });
      });
      activeUploads.set(msg.uploadId, { stream, size: msg.size, received: 0, target });
      console.log(`[file] upload start: ${filename} (${msg.size} bytes) → ${target}`);
      sendMsg({ type: 'file_upload_ack', agentId: msg.agentId, uploadId: msg.uploadId, ok: true });
    } catch (e) {
      sendMsg({ type: 'file_upload_ack', agentId: msg.agentId, uploadId: msg.uploadId, ok: false, error: e.message });
    }
  }

  function handleUploadChunk(msg) {
    const up = activeUploads.get(msg.uploadId);
    if (!up) return;  // unknown / already finished — drop silently
    const buf = Buffer.from(msg.data || '', 'base64');
    up.received += buf.length;
    const ok = up.stream.write(buf);
    // Backpressure hint (optional): browser may track but we don't enforce windowing here.
    sendMsg({ type: 'file_chunk_ack', agentId: msg.agentId, uploadId: msg.uploadId, index: msg.index, received: up.received });
    void ok;
  }

  function handleUploadEnd(msg) {
    const up = activeUploads.get(msg.uploadId);
    if (!up) return;
    up.stream.end(() => {
      console.log(`[file] upload done: ${path.basename(up.target)} (${up.received} bytes)`);
      activeUploads.delete(msg.uploadId);
      sendMsg({ type: 'file_upload_done', agentId: msg.agentId, uploadId: msg.uploadId, ok: true, savedPath: path.basename(up.target) });
    });
  }

  async function handleDownloadStart(msg) {
    const rel = msg.path || '';
    let cwd;
    try {
      cwd = await queryShellCwd();
    } catch (e) {
      cwd = lastKnownCwd || staticFileRoot;
    }
    const base = cwd || staticFileRoot;
    const target = safeResolveAgainst(base, rel);
    if (!target) {
      sendMsg({ type: 'file_download_end', agentId: msg.agentId, downloadId: msg.downloadId, ok: false, error: 'Invalid path' });
      return;
    }
    let st;
    try {
      st = await fs.promises.stat(target);
    } catch (e) {
      sendMsg({ type: 'file_download_end', agentId: msg.agentId, downloadId: msg.downloadId, ok: false, error: e.message });
      return;
    }
    if (st.isDirectory()) {
      sendMsg({ type: 'file_download_end', agentId: msg.agentId, downloadId: msg.downloadId, ok: false, error: 'Is a directory' });
      return;
    }
    if (st.size > MAX_FILE_SIZE) {
      sendMsg({ type: 'file_download_end', agentId: msg.agentId, downloadId: msg.downloadId, ok: false, error: `File too large (max ${MAX_FILE_SIZE} bytes)` });
      return;
    }
    const name = path.basename(target);
    const totalChunks = Math.max(1, Math.ceil(st.size / CHUNK_SIZE));
    const state = { rs: fs.createReadStream(target, { highWaterMark: CHUNK_SIZE }), aborted: false, index: 0, size: st.size };
    activeDownloads.set(msg.downloadId, state);
    sendMsg({ type: 'file_download_meta', agentId: msg.agentId, downloadId: msg.downloadId, name, size: st.size, totalChunks });
    console.log(`[file] download start: ${name} (${st.size} bytes)`);

    state.rs.on('data', (chunk) => {
      if (state.aborted) return;
      // Pause until the ws send buffer drains — crude backpressure.
      const ok = sendMsg({
        type: 'file_download_chunk',
        agentId: msg.agentId,
        downloadId: msg.downloadId,
        index: state.index++,
        data: chunk.toString('base64')
      });
      if (!ok || ws.bufferedAmount > 4 * CHUNK_SIZE) {
        state.rs.pause();
        const drain = () => {
          if (ws && ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= 2 * CHUNK_SIZE) {
            ws.off('drain', drain);
            state.rs.resume();
          }
        };
        if (ws && ws.readyState === WebSocket.OPEN) ws.on('drain', drain);
        else setTimeout(() => state.rs.resume(), 100);
      }
    });
    state.rs.on('end', () => {
      console.log(`[file] download done: ${name}`);
      activeDownloads.delete(msg.downloadId);
      sendMsg({ type: 'file_download_end', agentId: msg.agentId, downloadId: msg.downloadId, ok: true });
    });
    state.rs.on('error', (e) => {
      console.error('[file] download stream error:', e.message);
      state.aborted = true;
      activeDownloads.delete(msg.downloadId);
      sendMsg({ type: 'file_download_end', agentId: msg.agentId, downloadId: msg.downloadId, ok: false, error: e.message });
    });
  }

  ws.on('close', () => {
    console.log('Disconnected from server');
    stopHeartbeat();
    if (ptyProcess) {
      ptyProcess.kill();
      ptyProcess = null;
    }
    // Abort any in-flight file transfers — streams won't survive a reconnect.
    for (const [, up] of activeUploads) { try { up.stream.destroy(); } catch {} }
    activeUploads.clear();
    for (const [, dl] of activeDownloads) { dl.aborted = true; try { dl.rs.destroy(); } catch {} }
    activeDownloads.clear();
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
}

function scheduleReconnect() {
  console.log(`Reconnecting in ${reconnectDelay / 1000}s ...`);
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
    connect();
  }, reconnectDelay);
}

// --- Graceful shutdown ---
function shutdown() {
  console.log('\nShutting down...');
  if (ptyProcess) ptyProcess.kill();
  if (ws) ws.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Start ---
console.log(`Screen Web Terminal client starting...`);
console.log(`  Name: ${name}`);
console.log(`  Screen session: ${screenName} (${screenArgs.join(' ')})`);
console.log(`  Server: ${serverUrl}`);
connect();
