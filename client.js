const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const WebSocket = require('ws');
const pty = require('node-pty');
const { createFileTransfer } = require('./file-transfer');
const { TerminalState } = require('./terminal-state');
const { PROTOCOL_VERSION } = require('./terminal-protocol');
const { encodeScreenInput } = require('./terminal-filter');
const { prepareScreenTerminal, startScreenSession } = require('./screen-terminal');
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
const screenTerm = prepareScreenTerminal();
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
const { CLIENT_FILES, FETCHABLE_FILES } = require('./managed-files');
const { buildFileManifest, installFiles } = require('./file-update');

// {name: hash} of our FETCHABLE_FILES copies; missing files are omitted.
// Deliberately wider than CLIENT_FILES: the server-side files (server.js,
// public/* etc.) are hashed too so the four-state version badge can spot a
// machine whose server-side copies drifted (i.e. someone edited them here to
// publish via pull).
//
// RUNNING-VERSION SNAPSHOT (the R in the badge's S/A/R model): hashed ONCE at
// process startup and cached for every register. The server treats these hashes
// as "the version this process is running" — which is only true for a startup
// snapshot. Rehashing at each connect (the old behaviour) silently reported
// freshly-deployed disk files as the running version, so after any reconnect
// (server restart, network blip) a stale process showed "✓ 最新" instead of
// "⏳ 待应用" and the pending restart became invisible. Fresh DISK state (the
// A channel) comes from query_files, which always rehashes on demand.
let runningFileHashes = null;
async function hashSelfFiles() {
  if (runningFileHashes) return runningFileHashes;
  return (runningFileHashes = await hashDiskFiles());
}
// Fresh DISK hashes (the A channel for the version badge): always rehashes,
// never cached. query_files uses this — it must see files changed on disk
// since this process started (deployed updates, local edits), which the
// running-version snapshot above deliberately freezes out.
async function hashDiskFiles() {
  return buildFileManifest(__dirname, FETCHABLE_FILES);
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
  const screenCommand = [];
  if (cmd === 'claude') {
    screenCommand.push('bash', '-lc', 'claude');
  } else if (cmd === 'bash') {
    screenCommand.push('bash', '-l');
  } else {
    screenCommand.push(cmd);
  }
  console.log(`[spawn_node] creating screen ${newScreenName}: ${screenCommand.join(' ')}`);
  try {
    startScreenSession(newScreenName, screenCommand);
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
// change to one we actually RUN triggers a restart.
async function handleUpdateFiles(msg) {
  const reqId = msg.reqId;
  if (!Array.isArray(msg.files)) {
    sendMsg({ type: 'update_files_result', reqId, ok: false, error: 'files must be an array', updated: [] });
    return;
  }
  const updated = installFiles(__dirname, msg.files, FETCHABLE_FILES);
  const ranFilesChanged = updated.some(name => CLIENT_FILES.includes(name));
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
  require('./service-restart').restartClient({
    root: __dirname, node: process.execPath, configFile, screenName, pid: process.pid
  });
  console.log(`[update] self-restart scheduled (screen swt-client-${screenName})`);
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
let cols = parseInt(config.client.cols) || 200;
let rows = parseInt(config.client.rows) || 50;
const screenArgs = (screenMode || 'auto') === 'auto'
  ? ['-x', screenName]   // default: -x works for attached sessions
  : screenMode === 'reattach'
    ? ['-r', screenName]
    : ['-x', screenName];

let ws = null;
let ptyProcess = null;
let terminalState = null;
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

// Register handshake is async (hashSelfFiles reads the managed files from disk). The
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

  const transferSocket = ws;
  const fileTransfers = createFileTransfer({
    send: message => {
      if (transferSocket.readyState !== WebSocket.OPEN) return false;
      transferSocket.send(JSON.stringify(message));
      return true;
    },
    getSocket: () => transferSocket, getShellCwd
  });
  ws.on('open', () => {
    console.log('Connected to server');
    reconnectDelay = 1000;
    registered = false;
    startHeartbeat();
    startClaudeStateReporter();

    // Spawn PTY with screen — unless it survived the disconnect (see the
    // keep-PTY logic in ws.on('close')); a fresh `screen -r` attach would
    // repaint one viewport and mark the gap as if nothing happened. The
    // terminal model covers that gap instead.
    if (!ptyProcess) spawnPty();

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
        protocolVersion: PROTOCOL_VERSION,
        cols,
        rows
      }));
      flushOutbound();
    });
  });

  function spawnPty() {
    if (terminalState) terminalState.dispose();
    terminalState = new TerminalState(cols, rows, payload => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        sendRawOrQueue(JSON.stringify({ type: 'data', payload }));
      }
    });
    if (ptyProcess) {
      try { ptyProcess.kill(); } catch {}
      ptyProcess.removeAllListeners('data');
      ptyProcess = null;
    }
    const generation = ++ptyGeneration;

    ptyProcess = pty.spawn('screen', screenArgs, {
      name: screenTerm,
      cols,
      rows,
      env: { ...process.env, TERM: screenTerm }
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
      terminalState.write(data);
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
      ptyProcess.write(encodeScreenInput(input));
    }

    if (msg.type === 'resize' && ptyProcess) {
      const nextCols = msg.cols || cols, nextRows = msg.rows || rows;
      cols = nextCols;
      rows = nextRows;
      if (terminalState) terminalState.resize(nextCols, nextRows);
      ptyProcess.resize(nextCols, nextRows);
    }

    if (msg.type === 'terminal_snapshot_request' && terminalState) {
      terminalState.snapshot(snapshot => sendMsg({ type: 'terminal_snapshot_result', reqId: msg.reqId, ...snapshot }));
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

    // --- Push-update: server sends diffs of the managed inventory ---
    if (msg.type === 'update_files') {
      handleUpdateFiles(msg).catch(e => {
        console.error('[update] failed:', e.message);
        sendMsg({ type: 'update_files_result', reqId: msg.reqId, ok: false, error: e.message, updated: [] });
      });
    }

    if (msg.type === 'query_files') {
      hashDiskFiles().then(files => {
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
      fileTransfers.handle(msg).catch(e => console.error('[file] handler error:', e.message));
    }
  });

  ws.on('close', () => {
    console.log('Disconnected from server');
    registered = false;
    pendingOutbound = [];
    stopHeartbeat();
    stopClaudeStateReporter();
    // KEEP the PTY attached to screen across reconnects. Killing it used to
    // mean: reconnect → fresh `screen -r` attach → screen repaints one
    // viewport → everything between the disconnect and reconnect was gone
    // except that one redraw. The terminal model now keeps the gap for a
    // browser snapshot after reconnect.
    // A surviving PTY must keep its generation: its eventual exit handler
    // still owns recovery. Only spawnPty increments the generation, which
    // also invalidates old respawn timers if reconnect creates a replacement.
    // Abort any in-flight file transfers — streams won't survive a reconnect.
    fileTransfers.dispose();
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
