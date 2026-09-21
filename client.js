const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const WebSocket = require('ws');
const pty = require('node-pty');
const { detectClaudeState } = require('./claude-detector');
const { validateSpawnRequest, SPAWN_MAX_NODES } = require('./spawn-validator');
const { loadConfig } = require('./config-loader');

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
const { config, configFile } = loadConfig('config.json', __dirname);
const { serverUrl, token, name, screen: screenSession, screenMode, attrs } = config.client;

if (!serverUrl || !token || !name) {
  console.error('Missing client config: serverUrl, token, name are required');
  process.exit(1);
}

const screenName = screenSession || 'main';

// --- Stable per-machine clientId ---
// Groups this client with any nodes it spawns via spawn_node (server.js target.clientId
// routing, supervisor.js per-machine node counting). Persisted back into the config file
// so it survives restarts instead of fragmenting the grouping on every relaunch.
if (!config.client.clientId) {
  config.client.clientId = `c-${os.hostname()}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error('[!] failed to persist clientId to config:', e.message);
  }
}
const clientId = config.client.clientId;

// --- Push-update: self file manifest ---
// Server diffs these hashes against its own copies and pushes only what
// differs (update_files). Whitelist is strict: only these names may ever be
// written by the update path.
const CLIENT_FILES = ['client.js', 'claude-detector.js', 'spawn-validator.js', 'config-loader.js'];
// Names this agent may be asked to upload (pull_update). Includes the
// server-side files: when this machine is the designated update source, the
// server replaces its own copies from here. Strict whitelist — anything else
// is refused, so the fetch path can never read arbitrary files.
const FETCHABLE_FILES = ['client.js', 'claude-detector.js', 'spawn-validator.js', 'config-loader.js',
  'server.js', 'supervisor.js', 'public/index.html', 'public/guide.html', 'public/favicon.svg'];

function sha256File(absPath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(absPath);
    s.on('data', d => h.update(d));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

// {name: hash} of our FETCHABLE_FILES copies; missing files are omitted.
// Deliberately wider than CLIENT_FILES: the server-side files (server.js,
// public/* etc.) are hashed too so the four-state version badge can spot a
// machine whose server-side copies drifted (i.e. someone edited them here to
// publish via pull). At register time this snapshot IS the running version
// (the server treats it as R); later query_files refreshes give fresh disk
// state (A).
async function hashSelfFiles() {
  const out = {};
  for (const name of FETCHABLE_FILES) {
    try { out[name] = await sha256File(path.join(__dirname, name)); } catch { /* omitted */ }
  }
  return out;
}

// --- Debug byte-stream dump (toggle with --dump flag) ---
// Dumps raw pty traffic to /tmp/swt-dump-<name>-{in,out}.bin so escape-sequence
// flow (mouse mode switches, alt screen, etc.) can be inspected offline.
const DEBUG_DUMP = process.argv.includes('--dump');
const dumpStreams = {};
function dumpStream(dir, data) {
  let s = dumpStreams[dir];
  if (!s) {
    s = dumpStreams[dir] = fs.createWriteStream(`/tmp/swt-dump-${screenName}-${dir}.bin`, { flags: 'a' });
  }
  s.write(Buffer.from(data));
}

// --- File transfer config ---
// The "base" used for file_ls / upload / download is the SHELL's current working
// directory inside the screen session, not the node process's cwd. We track it
// passively — never by writing to the PTY (writing `pwd` would leak into whatever
// has keyboard focus, e.g. an AI dialog in codex/claude):
//   1. OSC 7: shells whose PROMPT_COMMAND reports
//      `printf '\033]7;file://%s%s\033\\' "$HOSTNAME" "$PWD"` broadcast their
//      cwd at every prompt; we listen on the PTY data stream and cache it.
//      NOTE: GNU screen 4.09 swallows OSC 7 (verified) — this only fires when
//      the PTY connects to the shell directly or a newer screen passes it.
//   2. /proc (primary in practice): resolve the screen server pid via the
//      socket dir, walk its descendants, read /proc/<pid>/cwd — always current,
//      zero shell config. With multiple screen windows it may pick another
//      window's shell; acceptable for a single-window monitoring setup.
//   3. static `fileRoot` (from config) as the last resort.
const staticFileRoot = path.resolve(config.client.fileRoot || process.cwd());
const MAX_FILE_SIZE = 200 * 1024 * 1024;        // 200MB per file
const CHUNK_SIZE = 256 * 1024;                  // 256KB raw per chunk
const activeUploads = new Map();                // uploadId -> { stream, size, received, target }
const activeDownloads = new Map();              // downloadId -> { rs, aborted }
let oscCwd = null;                              // shell cwd from last OSC 7 report

// Match an OSC 7 sequence: ESC ] 7 ; file://host/path terminated by BEL or ST.
// Payload captured without the terminator; host is ignored (client is per-machine).
const OSC7_RE = /\x1b\]7;file:\/\/([^\x07\x1b]*?)(?:\x07|\x1b\\)/;

// Feed PTY output through a small tail buffer so sequences split across chunks
// are still recognized; on a match, decode the URL path into oscCwd.
function trackOscCwd(tail, data) {
  tail = (tail + data).slice(-1024);
  const m = OSC7_RE.exec(tail);
  if (m) {
    const rest = m[1];                    // host/path
    const slash = rest.indexOf('/');
    let p = slash === -1 ? '/' : rest.slice(slash);
    try { p = decodeURIComponent(p); } catch { /* keep raw path */ }
    if (p.startsWith('/')) oscCwd = p;
    tail = tail.slice(m.index + m[0].length);   // consume, avoid re-matching
  }
  return tail;
}

// Passive /proc lookup: server pid comes from the screen socket dir
// (/var/run/screen/S-<user>/<serverpid>.<session>), then walk up to three
// generations of descendants (server → window → shell) and return the first
// readable /proc/<pid>/cwd, preferring the deepest (the shell itself).
function readShellCwdFromProc() {
  try {
    const sockDir = `/var/run/screen/S-${os.userInfo().username}`;
    const match = fs.readdirSync(sockDir).find(f => f.endsWith(`.${screenName}`));
    if (!match) return null;
    const serverPid = parseInt(match.split('.')[0], 10);
    if (!Number.isFinite(serverPid)) return null;

    const children = new Map();           // ppid -> [pid]
    for (const ent of fs.readdirSync('/proc', { withFileTypes: true })) {
      if (!/^\d+$/.test(ent.name)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${ent.name}/stat`, 'utf8');
        // comm (field 2) may contain spaces — parse after the last ')'
        const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const ppid = parseInt(rest[1], 10);
        if (!children.has(ppid)) children.set(ppid, []);
        children.get(ppid).push(parseInt(ent.name, 10));
      } catch { /* process vanished */ }
    }

    let frontier = [serverPid];
    let found = null;
    for (let depth = 0; depth < 3 && frontier.length; depth++) {
      const next = [];
      for (const pid of frontier) next.push(...(children.get(pid) || []));
      for (const pid of next) {
        try {
          const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
          if (cwd) found = cwd;           // keep the deepest hit
        } catch { /* unreadable */ }
      }
      frontier = next;
    }
    return found;
  } catch { return null; }
}

// Best-effort current shell cwd, without ever writing to the PTY.
function getShellCwd() {
  if (oscCwd) return oscCwd;                    // freshest: from the active shell's prompt
  return readShellCwdFromProc() || staticFileRoot;
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
    sendRawOrQueue(JSON.stringify(obj));
    return true;
  }
  return false;
}

// --- Spawn new node (screen + child client) ---
// triggered by server 'spawn_node' message. Always safe:
//   - max 20 nodes per machine (configurable via SPAWN_MAX_NODES)
//   - screenName validated strictly (alphanum + -_)
//   - cmd whitelist: claude | bash | sh
//   - writes temp config under project dir
//   - child is detached and unref'd so it survives parent exit
// Raw `screen -ls` parse — can throw; callers decide how to handle failure
// (spawn_node treats it as "no sessions", list_screens reports the error over the wire).
function getLocalScreenSessions() {
  const out = execSync('screen -ls 2>/dev/null || true', { encoding: 'utf8' });
  const names = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*\d+\.([^\s]+)\s+/);
    if (m) names.push(m[1]);
  }
  return names;
}

function listLocalScreenNames() {
  try { return getLocalScreenSessions(); } catch { return []; }
}

// Screen names of nodes THIS app has spawned/registered on this machine —
// scoped to our own config.client-*.json files, NOT every screen session that
// happens to exist on the box. A machine can easily be running 30+ screens
// for completely unrelated projects; those must never count against our cap
// or be reported as "our" node count in the management panel.
function listLocalNodeScreenNames() {
  try {
    return fs.readdirSync(__dirname)
      .filter(f => /^config\.client-.*\.json$/.test(f))
      .map(f => f.slice('config.client-'.length, -'.json'.length));
  } catch { return []; }
}

async function handleSpawnNode(msg) {
  const reqId = msg.reqId;
  const v = validateSpawnRequest(msg);
  if (!v.ok) {
    sendMsg({ type: 'spawn_node_result', reqId, ok: false, error: v.error });
    return;
  }
  const newScreenName = v.screenName;
  const cmd = v.cmd;

  // Enforce ≤ SPAWN_MAX_NODES per machine, counting only nodes THIS app spawned
  // (see listLocalNodeScreenNames). Separately, the *name* must not collide with
  // ANY screen session on the box — ours or a completely unrelated one — since
  // we're about to `screen -dmS` with that exact name.
  const nodeCount = listLocalNodeScreenNames().length;
  if (nodeCount >= SPAWN_MAX_NODES) {
    sendMsg({ type: 'spawn_node_result', reqId, ok: false, error: `max ${SPAWN_MAX_NODES} nodes reached on this machine`, count: nodeCount });
    return;
  }
  const existing = listLocalScreenNames();
  if (existing.includes(newScreenName)) {
    sendMsg({ type: 'spawn_node_result', reqId, ok: false, error: `screen session "${newScreenName}" already exists`, count: nodeCount });
    return;
  }

  // Build child config (clone of current config + override screen + name)
  const childConfig = JSON.parse(JSON.stringify(config.client));
  childConfig.screen = newScreenName;
  childConfig.name = msg.nodeName || `${name}-${newScreenName}`;
  childConfig.screenMode = childConfig.screenMode || 'reattach'; // detached screen → -r reattach
  childConfig.clientId = clientId;
  const cfgPath = path.join(__dirname, `config.client-${newScreenName}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify({ mode: 'client', client: childConfig }, null, 2), { mode: 0o600 });

  // Create a DETACHED screen session running the chosen command. Plain `bash`
  // inside screen is interactive-NON-login: on hosts whose ~/.bashrc guards on
  // being a login shell (or heavy init like conda that misbehaves without the
  // full login env) the shell can come up half-initialized. `bash -l` with no
  // -c is an INTERACTIVE login shell — walks /etc/profile → ~/.profile →
  // ~/.bashrc, matching what the user gets over ssh. (Note: `bash -lc` would
  // be non-interactive and trip the classic `case $- in *i*` guard.)
  // claude already runs via `bash -lc` deliberately (non-interactive, no
  // prompt needed); sh never reads .bashrc, so it's left as-is.
  const screenSpawnArgs = ['screen', '-dmS', newScreenName];
  if (cmd === 'claude') {
    screenSpawnArgs.push('bash', '-lc', 'claude');
  } else if (cmd === 'bash') {
    screenSpawnArgs.push('bash', '-l');
  } else {
    screenSpawnArgs.push(cmd);
  }
  console.log(`[spawn_node] creating screen: ${screenSpawnArgs.join(' ')}`);
  try {
    execSync(screenSpawnArgs.join(' '), { encoding: 'utf8' });
  } catch (e) {
    sendMsg({ type: 'spawn_node_result', reqId, ok: false, error: `screen create failed: ${e.message}` });
    return;
  }
  // Give screen a moment to initialize before client attaches
  await new Promise(r => setTimeout(r, 800));

  // Spawn child client.js to attach to the new screen
  const child = spawn(process.execPath, [path.join(__dirname, 'client.js'), `--config=${cfgPath}`], {
    detached: true,
    stdio: 'ignore',
    cwd: __dirname,
    env: { ...process.env }
  });
  child.on('error', (e) => {
    console.error('[spawn_node] child error:', e.message);
    sendMsg({ type: 'spawn_node_result', reqId, ok: false, error: `client spawn error: ${e.message}` });
  });
  child.unref();

  console.log(`[spawn_node] spawned child PID ${child.pid} for screen ${newScreenName}`);
  // Wait briefly to see if child stays alive
  await new Promise(r => setTimeout(r, 600));
  sendMsg({
    type: 'spawn_node_result',
    reqId,
    ok: true,
    screenName: newScreenName,
    nodeName: childConfig.name,
    clientId,
    childPid: child.pid,
    count: nodeCount + 1
  });
}

// --- Pull-update: serve this machine's copies as the designated source ---
// Mirror of handleUpdateFiles (push direction). Read-only; every name is
// checked against the FETCHABLE_FILES whitelist before touching the disk.
async function handleFetchFiles(msg) {
  const reqId = msg.reqId;
  const names = (Array.isArray(msg.names) ? msg.names : [])
    .filter(n => typeof n === 'string' && FETCHABLE_FILES.includes(n));
  const files = [];
  for (const name of names) {
    const buf = await fs.promises.readFile(path.join(__dirname, name));
    files.push({
      name,
      content: buf.toString('base64'),
      sha256: crypto.createHash('sha256').update(buf).digest('hex')
    });
  }
  sendMsg({ type: 'fetch_files_result', reqId, ok: true, files });
}

// --- Push-update: apply pushed files, then self-restart if needed ---

// Files we can receive via update_files: everything the server manages
// (install.sh puts server.js/public/* copies on agent machines too). Only a
// change to one we actually RUN (the client-side four) triggers a restart.
const UPDATABLE_FILES = ['client.js', 'claude-detector.js', 'spawn-validator.js', 'config-loader.js',
  'server.js', 'supervisor.js', 'public/index.html', 'public/guide.html', 'public/favicon.svg'];

async function handleUpdateFiles(msg) {
  const reqId = msg.reqId;
  if (!Array.isArray(msg.files)) {
    sendMsg({ type: 'update_files_result', reqId, ok: false, error: 'files must be an array', updated: [] });
    return;
  }
  // Validate everything BEFORE touching disk: strict whitelist (no paths, no
  // traversal beyond the known public/ subdir) and content must match its
  // declared sha256.
  for (const f of msg.files) {
    if (!f || !UPDATABLE_FILES.includes(f.name)) {
      throw new Error(`file not allowed: ${f && f.name}`);
    }
    const buf = Buffer.from(f.content, 'base64');
    const sum = crypto.createHash('sha256').update(buf).digest('hex');
    if (sum !== f.sha256) throw new Error(`checksum mismatch: ${f.name}`);
  }
  // Atomic install: write temp sibling then rename. Overwriting the running
  // client.js is safe on Linux — node holds the old inode until exit.
  const updated = [];
  let ranFilesChanged = false;
  for (const f of msg.files) {
    const finalPath = path.join(__dirname, f.name);
    const tmpPath = finalPath + '.swt-new';
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(tmpPath, Buffer.from(f.content, 'base64'), { mode: 0o644 });
    fs.renameSync(tmpPath, finalPath);
    updated.push(f.name);
    if (CLIENT_FILES.includes(f.name)) ranFilesChanged = true;
  }
  console.log(`[update] applied: ${updated.join(', ')}${ranFilesChanged ? ' — scheduling self-restart' : ' (data-only, no restart needed)'}`);
  sendMsg({ type: 'update_files_result', reqId, ok: true, updated });
  if (ranFilesChanged) scheduleSelfRestart();
}

let selfRestartScheduled = false;

// Restart THIS client process so the new files take effect. Only ever touches
// our own service screen (swt-client-<screenName>) — the monitored task screen
// <screenName> is not touched. Uses process.execPath (absolute node), never
// bare `node` (ancient system node on some hosts can't parse the source).
function scheduleSelfRestart() {
  if (selfRestartScheduled) return;
  selfRestartScheduled = true;
  const SESSION = screenName;
  const CFG = path.basename(configFile);
  const NODE = process.execPath;
  const DIR = __dirname;
  const PID = process.pid;
  const script = `
sleep 2
kill -TERM ${PID} 2>/dev/null || true
sleep 2
if screen -ls 2>/dev/null | grep -q '[.]swt-client-${SESSION}'; then
  screen -S swt-client-${SESSION} -X quit 2>/dev/null
  sleep 1
fi
# Honor termination: if the node was killed via web UI (kill_node), the .stop
# marker must not be bypassed by an in-flight update restart. But if the task
# screen exists again, the node is being revived on purpose — clear and relaunch.
if [ -f '${DIR}/${CFG}.stop' ]; then
  if screen -ls 2>/dev/null | grep -qE '[.]${SESSION}(\\s|$)'; then
    rm -f '${DIR}/${CFG}.stop'
  else
    echo "[self-restart] .stop marker present — node terminated, not relaunching" >&2
    exit 0
  fi
fi
# Relaunch unconditionally. Two setups exist out there:
#  - install.sh's restart-on-crash wrapper: killing us above makes the wrapper
#    relaunch with the NEW files, and the screen we create below would be a
#    duplicate... except the wrapper's screen has the SAME name, so
#    screen -dmS with an existing session is refused (duplicate name check),
#    which makes this a safe no-op in that case.
#  - manually launched screen (no wrapper): without this the agent would be
#    gone forever after a push — 5060Ti incident, Sep 2026.
screen -dmS swt-client-${SESSION} bash -c "cd '${DIR}' && exec '${NODE}' client.js --config=${CFG} 2>&1 | tee -a '${DIR}/client-${SESSION}.log'"
`;
  const child = spawn('bash', ['-c', script], { detached: true, stdio: 'ignore', env: { ...process.env } });
  child.unref();
  console.log(`[update] self-restart scheduled (screen swt-client-${SESSION})`);
}

// --- Claude state detection ---
// Client-side mirror of lastOutput for cheap local detection (avoids round-trip).
let lastOutputBuffer = '';
const LAST_OUTPUT_BUFFER_MAX = 20000; // 20KB tail
let claudeStateTimer = null;
const CLAUDE_STATE_INTERVAL = 4000; // report every 4s

function pushOutput(text) {
  lastOutputBuffer += text;
  if (lastOutputBuffer.length > LAST_OUTPUT_BUFFER_MAX) {
    lastOutputBuffer = lastOutputBuffer.slice(-LAST_OUTPUT_BUFFER_MAX);
  }
}

function reportClaudeState() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const state = detectClaudeState(lastOutputBuffer);
  sendRawOrQueue(JSON.stringify({ type: 'claude_state', state }));
}

function startClaudeStateReporter() {
  stopClaudeStateReporter();
  claudeStateTimer = setInterval(reportClaudeState, CLAUDE_STATE_INTERVAL);
}

function stopClaudeStateReporter() {
  if (claudeStateTimer) { clearInterval(claudeStateTimer); claudeStateTimer = null; }
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
let oscTail = '';   // carry-over bytes between onData chunks, for OSC 7 tracking
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
      sendRawOrQueue(JSON.stringify({ type: 'ping' }));
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

let ptyGeneration = 0;  // incremented on every spawn; stale respawn timers no-op

// Register handshake is async (hashSelfFiles reads 4 files from disk). The
// server closes any connection whose first message isn't register, and a
// freshly attached screen's initial redraw fires through onData immediately —
// so outbound data/claude_state/ping that beat the register message must be
// queued, not dropped or sent early.
let registered = false;
let pendingOutbound = [];

function sendRawOrQueue(str) {
  if (registered && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(str);
  } else {
    pendingOutbound.push(str);
  }
}

function flushOutbound() {
  registered = true;
  const q = pendingOutbound;
  pendingOutbound = [];
  if (ws && ws.readyState === WebSocket.OPEN) {
    for (const s of q) ws.send(s);
  }
}

function connect() {
  console.log(`Connecting to ${serverUrl} ...`);

  ws = new WebSocket(serverUrl);

  ws.on('open', () => {
    console.log('Connected to server');
    reconnectDelay = 1000;
    registered = false;
    startHeartbeat();
    startClaudeStateReporter();

    // Spawn PTY with screen
    spawnPty();

    // Register with server
    const sysInfo = collectSysInfo();
    hashSelfFiles().then(files => {
      if (!ws || ws.readyState !== WebSocket.OPEN) { pendingOutbound = []; return; }
      ws.send(JSON.stringify({
        type: 'register',
        token,
        name,
        screen: screenName,
        attrs: { ...(attrs || {}), clientId },
        sys: sysInfo,
        files,
        cols,
        rows
      }));
      flushOutbound();
    });
  });

  function spawnPty() {
    if (ptyProcess) {
      try { ptyProcess.kill(); } catch {}
      ptyProcess.removeAllListeners('data');
      ptyProcess = null;
    }
    const generation = ++ptyGeneration;

    ptyProcess = pty.spawn('screen', screenArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      env: { ...process.env, TERM: 'xterm-256color' }
    });

    console.log(`Attached to screen session: ${screenName} (PID: ${ptyProcess.pid})`);
    const exitPid = ptyProcess.pid;

    // Increase screen scrollback (default is only 100 lines)
    setTimeout(() => {
      if (ptyProcess) {
        ptyProcess.write('\x01:scrollback 10000\x0d');
        ptyProcess.write('\x01:defscrollback 10000\x0d');
      }
    }, 500);

    ptyProcess.onData((data) => {
      if (DEBUG_DUMP) dumpStream('OUT', data);
      oscTail = trackOscCwd(oscTail, data);
      pushOutput(data);
      if (ws && ws.readyState === WebSocket.OPEN) {
        sendRawOrQueue(JSON.stringify({ type: 'data', payload: Buffer.from(data).toString('base64') }));
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      console.log(`screen exited with code ${exitCode}, respawning in 3s...`);
      if (ptyProcess && ptyProcess.pid === exitPid) ptyProcess = null;
      // Guard the respawn with the generation: if a newer pty was spawned in
      // the meantime (reconnect race), this stale exit must not spawn another.
      const myGeneration = generation;
      setTimeout(() => {
        if (myGeneration === ptyGeneration && ws && ws.readyState === WebSocket.OPEN) {
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
      if (DEBUG_DUMP) dumpStream('IN', input);
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

    // Spawn a new node (new screen session + new child client.js) locally.
    if (msg.type === 'spawn_node') {
      handleSpawnNode(msg).catch(e => {
        console.error('[spawn_node] error:', e.message);
        sendMsg({ type: 'spawn_node_result', reqId: msg.reqId, ok: false, error: e.message });
      });
    }

    // Supervisor→agent: list THIS app's own node screens (used for node
    // counting/display) — not every screen session on the machine, which
    // would include totally unrelated projects the user runs on the same box.
    if (msg.type === 'list_screens') {
      try {
        sendMsg({ type: 'list_screens_result', reqId: msg.reqId, ok: true, screens: listLocalNodeScreenNames() });
      } catch (e) {
        sendMsg({ type: 'list_screens_result', reqId: msg.reqId, ok: false, error: e.message });
      }
    }

    // Kill this node from the management panel — either just this monitoring
    // agent (mode: 'agent_only'), or the agent AND the underlying task screen
    // it was attached to (mode: 'agent_and_task'). Writing the stop marker
    // BEFORE exiting is what makes this a real stop rather than a 3s blip:
    // this process normally runs under a restart-on-crash wrapper (see
    // install.sh's write_run_wrapper) that would otherwise just relaunch it.
    if (msg.type === 'kill_node') {
      const killTask = msg.mode === 'agent_and_task';
      console.log(`[!] kill_node received (mode=${msg.mode || 'agent_only'})${killTask ? ' — also killing task screen ' + screenName : ''}`);
      try {
        fs.writeFileSync(`${configFile}.stop`, '');
      } catch (e) {
        console.error('[!] failed to write stop marker:', e.message);
      }
      if (killTask) {
        try {
          execFileSync('screen', ['-S', screenName, '-X', 'quit']);
        } catch (e) {
          console.error('[!] failed to quit task screen:', e.message);
        }
      }
      shutdown();
    }

    // Remote kill: server tells us to die
    if (msg.type === 'kill') {
      console.log('[!] Received kill command from server, shutting down...');
      shutdown();
    }

    // --- Push-update: server sends diffs of CLIENT_FILES ---
    if (msg.type === 'update_files') {
      handleUpdateFiles(msg).catch(e => {
        console.error('[update] failed:', e.message);
        sendMsg({ type: 'update_files_result', reqId: msg.reqId, ok: false, error: e.message, updated: [] });
      });
    }

    if (msg.type === 'query_files') {
      hashSelfFiles().then(files => {
        sendMsg({ type: 'query_files_result', reqId: msg.reqId, ok: true, files });
      });
    }

    // Explicit web-UI "restart monitoring process" (⏳ 待应用 fix): disk files
    // are already current but the running process predates them. Same mechanics
    // as the post-push self-restart — only touches swt-client-<screenName>,
    // never the monitored task screen. Force past the once-guard: this is a
    // deliberate user command, not an update side effect.
    if (msg.type === 'restart_node') {
      console.log('[!] restart_node requested from web UI — scheduling self restart');
      selfRestartScheduled = false;
      sendRawOrQueue(JSON.stringify({ type: 'restart_node_result', reqId: msg.reqId, ok: true }));
      scheduleSelfRestart();
    }

    // --- Pull-update: server wants THIS agent's copies of whitelisted files ---
    // Reverse direction of update_files: this machine is the designated update
    // source, so we read files and ship them up. Read-only — nothing here ever
    // writes to disk. Whitelist covers everything the server manages
    // (its own server-side files too, since it will overwrite itself with them).
    if (msg.type === 'fetch_files') {
      handleFetchFiles(msg).catch(e => {
        console.error('[fetch_files] failed:', e.message);
        sendMsg({ type: 'fetch_files_result', reqId: msg.reqId, ok: false, error: e.message, files: [] });
      });
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
    const base = getShellCwd();
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
    const base = getShellCwd();
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
    const base = getShellCwd();
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
    registered = false;
    pendingOutbound = [];
    stopHeartbeat();
    stopClaudeStateReporter();
    if (ptyProcess) {
      ptyProcess.kill();
      ptyProcess = null;
    }
    // Invalidate any pending respawn timer from this connection's pty —
    // the reconnect's spawnPty owns the next generation.
    ptyGeneration++;
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
// A .stop marker means the node was terminated from the web UI (kill_node).
// The marker must survive until someone deliberately removes it or a NEW
// screen for this session appears — otherwise every restart resurrects a dead
// node as an attach-retry zombie (monitor-3 incident, Sep 2026).
if (fs.existsSync(`${configFile}.stop`)) {
  // If the task screen exists again, the node is being brought back on
  // purpose: clear the marker and continue. Otherwise honor the stop.
  const alive = (() => {
    try {
      // screen -ls lines look like "\t1234.name\t(date)\t(Detached)" — the name
      // is followed by a TAB, never end-of-line, so anchor with (\s|$) not $.
      execSync(`screen -ls 2>/dev/null | grep -qE "[.]${screenName}(\\s|$)"`, { shell: '/bin/bash' });
      return true;
    } catch { return false; }
  })();
  if (alive) {
    try { fs.unlinkSync(`${configFile}.stop`); } catch {}
    console.log(`[*] .stop marker present but screen ${screenName} exists again — clearing marker, continuing`);
  } else {
    console.log(`[*] .stop marker present for ${configFile} and screen ${screenName} is gone — this node was terminated. Exiting.`);
    console.log(`[*] To bring it back: recreate screen ${screenName}, or delete ${configFile}.stop`);
    process.exit(0);
  }
}
console.log(`Screen Web Terminal client starting...`);
console.log(`  Name: ${name}`);
console.log(`  Screen session: ${screenName} (${screenArgs.join(' ')})`);
console.log(`  Server: ${serverUrl}`);
connect();
