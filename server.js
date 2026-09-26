const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { createSupervisor } = require('./supervisor');
const { stripAnsi } = require('./claude-detector');
const { loadConfig } = require('./config-loader');

// --- Load config (support --config flag) ---
const { config, configFile } = loadConfig('config.json', __dirname);
const { port, password, tokens } = config.server;
const validTokens = new Set(Object.keys(tokens || {}));
const tokenUserMap = {};
for (const [token, info] of Object.entries(tokens || {})) {
  tokenUserMap[token] = info.user || 'user';
}

// --- State ---
const agents = new Map();   // ws -> { id, name, screen, attrs, sys, ws, ... } (per-connection registration)
// Terminal identity key: "clientId|screen". Stable across agent reconnects —
// the scrollback buffer and seq counter hang off this, so a reconnect (new
// agent-N id) no longer resets history. Agents without a clientId (legacy
// configs) fall back to "nokey|<screen>", which is still better than keying
// on the per-connection agent id.
function terminalKey(attrs, screen) {
  const cid = (attrs || {}).clientId || 'nokey';
  return `${cid}|${screen || ''}`;
}
const terminals = new Map(); // terminalKey -> { scrollback: [], scrollbackBytes: 0, nextSeq }
const browsers = new Map(); // ws -> { ws, agentIds: Set }
// Configurable so a low-resource VPS can shrink per-agent memory: config.server.scrollbackMax (bytes).
const SCROLLBACK_MAX = config.server.scrollbackMax || 2000000; // ~2MB scrollback per agent
// Trim only once we're this far over budget, in one batch — avoids paying an
// O(n) Array.shift()/splice() on every single incoming chunk once the buffer
// is full (which is most of the time under any sustained output).
const SCROLLBACK_TRIM_MARGIN = Math.max(20000, Math.round(SCROLLBACK_MAX * 0.1));
// Chunks of scrollback replayed to a browser on connect. Configurable via
// config.server.scrollbackInit — kept modest by default (older history is
// available on demand via scrollback_more) since every chunk here is a
// synchronous ws.send() cost paid at connect time (see sendScrollbackReplay).
const SCROLLBACK_INIT = config.server.scrollbackInit || 3000;
// A *byte* cap on top of the chunk-count one above. Chunk sizes vary wildly —
// a chunk can be a few bytes (one keystroke's echo) or tens of KB (a big PTY
// read) — so "last 3000 chunks" alone doesn't reliably bound how much data a
// browser has to receive, base64-decode, and hand to xterm.js to parse/render
// before the terminal feels ready. Whichever limit is hit first wins.
const SCROLLBACK_INIT_BYTES = config.server.scrollbackInitBytes || 600000;
const SCROLLBACK_PAGE = 500;    // chunks per lazy-load request
// How many scrollback chunks to send per event-loop tick during replay. Node
// is single-threaded — a tight loop sending thousands of chunks synchronously
// would freeze EVERY other connection (all agents' live output, all other
// browsers, HTTP requests) for the duration. Batching + yielding via
// setImmediate keeps each pause small regardless of how much history there is.
const SCROLLBACK_SEND_BATCH = 200;
const LAST_OUTPUT_MAX = 10000; // keep last 10KB for status preview
const LAST_LINES_COUNT = 3;    // show last 3 lines in dashboard

// --- Resource governance (defense in depth for a low-resource VPS) ---
// Every one of these bounds something that was previously unbounded: a request
// body, a single WS frame, or the number of live connections. None of this is
// about normal usage hitting the ceiling — it's about a bug, a stuck reconnect
// loop, or a hostile client not being able to grow memory without limit.
const MAX_ACTION_BODY = config.server.maxActionBody || 65536;       // /api/action POST body (bytes) — plenty for pasted terminal input
const MAX_WS_PAYLOAD = config.server.maxWsPayload || 4 * 1024 * 1024; // single WS frame (bytes) — file_chunk payloads are ~342KB base64; leaves headroom
const MAX_BROWSERS = config.server.maxBrowsers || 100;              // concurrent authenticated browser connections
const MAX_AGENTS = config.server.maxAgents || 200;                  // concurrent registered agents

// Always an object (not just falsy-checked) so update_supervisor_config below
// has somewhere to merge into even if config.json never had a supervisor block.
config.server.supervisor = config.server.supervisor || {};

const pendingScreenQueries = new Map(); // reqId -> (result) => void
const pendingUpdateReqs = new Map();    // reqId -> browser ws awaiting update_files_result/query_files_result
const pendingPulls = new Map();         // reqId -> { ws, agentName } awaiting fetch_files_result
// clientId -> { r, rPrev } — the running-version hashes this machine's agents
// reported at their last TWO registers. Used by the badge to disambiguate
// "agent restarted onto an unpublished local version" (rPrev==server, r!=server
// → 待拉取) from "server published, agent not pushed yet" (r unchanged → 待更新).
const agentRunningVersions = new Map();

// Detect if output ends with a prompt (waiting for input)
function hasPrompt(text) {
  if (!text || !text.trim()) return false;
  const lines = text.split('\n');
  const lastLine = lines[lines.length - 1].trim();
  if (!lastLine) return false;
  // Common prompt endings: # $ > : |%
  // But NOT when followed by more text (like "Select an option:")
  const promptRe = /[#$:>%|]\s*$/;
  return promptRe.test(lastLine);
}

let agentIdCounter = 0;

function generateAgentId() {
  return `agent-${++agentIdCounter}`;
}

// Monotonic data sequence numbers, scoped per terminal. Assigned as data
// chunks enter the terminal's scrollback, so a browser can resume from
// "everything after seq N". Counter-within-timestamp: process uptime alone
// would reset on server restart and hand browsers duplicate seqs (they'd
// silently skip the redelivery), so mix in wall-clock time. 1024 chunks/s
// headroom is far above any realistic PTY chunk rate (each send is a fresh
// Date.now() so the window never exhausts).
let seqCounter = 0;
let seqLastMs = 0;
function nextSeq() {
  const ms = Date.now();
  if (ms !== seqLastMs) { seqLastMs = ms; seqCounter = 0; }
  return ms * 1024 + (++seqCounter);
}

// Replay an agent's buffered scrollback to a browser in small batches, yielding
// to the event loop between each so a large history doesn't stall every other
// connection on the server (see SCROLLBACK_SEND_BATCH). Wire format is
// unchanged — same `data`/`scrollback_info`/`scrollback_end` messages, just
// paced. `done` fires when finished, including when there's nothing to send.
//
// sinceSeq enables incremental replay: only chunks with seq > sinceSeq are
// sent (mode:'delta'). When the requested gap is no longer fully buffered
// (trimmed tail, or the browser is behind a trim point), fall back to a full
// window replay (mode:'full') — the browser clears its terminal and redraws.
// seq always rides along on replayed `data` frames so the browser can pick up
// its lastSeq from either mode.
function sendScrollbackReplay(ws, ainfo, done, sinceSeq) {
  const term = terminals.get(terminalKey(ainfo.attrs, ainfo.screen)) || { scrollback: [] };
  const binfo = browsers.get(ws);
  if (binfo) {
    if (!binfo.replaying) binfo.replaying = new Set();
    binfo.replaying.add(ainfo.id);
  }
  const finish = () => {
    if (!binfo) return;
    binfo.replaying.delete(ainfo.id);
    const queued = binfo.pendingLive && binfo.pendingLive.get(ainfo.id);
    if (binfo.pendingLive) binfo.pendingLive.delete(ainfo.id);
    if (queued && ws.readyState === ws.OPEN) {
      for (const p of queued) ws.send(p);
    }
  };

  // Resolve the replay window. Delta mode needs the FIRST buffered chunk's seq
  // to prove contiguity: if sinceSeq sits before it, trimmed history is missing
  // and xterm cannot prepend — fall back to 'tail': append whatever the buffer
  // still has onto the browser's existing content. Clearing (the old full
  // fallback) destroyed the browser's local history whenever the SERVER had
  // less than the browser remembered (server restart empties the buffer) —
  // that erased history instead of restoring it. A full clear is only correct
  // on a fresh (non-resume) connect.
  let start = 0, mode = 'full';
  if (Number.isFinite(sinceSeq) && sinceSeq > 0) {
    if (term.scrollback.length === 0) {
      // Buffer empty (server restarted / nothing buffered yet): the browser's
      // own history is the only copy left — keep it, send nothing.
      mode = 'tail';
    } else {
      const first = term.scrollback[0];
      if (first.seq <= sinceSeq) {
        // Buffer covers the gap: replay only chunks after sinceSeq.
        start = term.scrollback.length;
        while (start > 0 && term.scrollback[start - 1].seq > sinceSeq) start--;
        mode = 'delta';
      } else {
        // Gap not coverable: keep browser content, append our tail.
        mode = 'tail';
      }
    }
  }

  const total = term.scrollback.length;
  if (total === 0 || (mode === 'delta' && start >= total)) {
    // Empty buffer (or nothing after sinceSeq) still reports info+end:
    // browsers treat scrollback_end as "replay finished" to trigger their
    // post-connect repaint; with no end message a fresh session's terminal
    // would never get one.
    ws.send(JSON.stringify({ type: 'scrollback_info', agentId: ainfo.id, total: 0, loadedFrom: 0, hasMore: false, mode }));
    ws.send(JSON.stringify({ type: 'scrollback_end', agentId: ainfo.id, lastSeq: sinceSeq || null }));
    finish();
    done();
    return;
  }
  // Walk back from the most recent chunk, stopping at whichever limit —
  // chunk count or total bytes — is hit first. Bounded to at most
  // SCROLLBACK_INIT iterations, so this is a cheap, one-time scan. Delta mode
  // already fixed `start`; tail/full modes narrow the window by size.
  if (mode !== 'delta') {
    let bytes = 0, count = 0;
    let s = total;
    while (s > 0 && count < SCROLLBACK_INIT && bytes < SCROLLBACK_INIT_BYTES) {
      s--;
      bytes += term.scrollback[s].payload.length;
      count++;
    }
    start = s;
  }
  ws.send(JSON.stringify({ type: 'scrollback_info', agentId: ainfo.id, total, loadedFrom: start, hasMore: start > 0, mode }));
  let i = start;
  function sendBatch() {
    if (ws.readyState !== ws.OPEN) { finish(); done(); return; } // browser gone mid-replay
    const end = Math.min(i + SCROLLBACK_SEND_BATCH, total);
    for (; i < end; i++) {
      const chunk = term.scrollback[i];
      ws.send(JSON.stringify({ type: 'data', payload: chunk.payload, agentId: ainfo.id, seq: chunk.seq }));
    }
    if (i < total) {
      setImmediate(sendBatch);
      return;
    }
    ws.send(JSON.stringify({ type: 'scrollback_info', agentId: ainfo.id, total, loadedFrom: start, hasMore: start > 0, mode }));
    const lastSeq = total > 0 ? term.scrollback[total - 1].seq : (sinceSeq || null);
    ws.send(JSON.stringify({ type: 'scrollback_end', agentId: ainfo.id, lastSeq }));
    finish();
    done();
  }
  sendBatch();
}

function getAgentsList(user) {
  return Array.from(agents.values())
    .filter(a => !user || a.user === user)
    .map(a => {
      const lines = a.lastOutput.split('\n');
      const lastLines = lines.slice(-LAST_LINES_COUNT).join('\n');
      return {
        id: a.id,
        name: a.name,
        screen: a.screen || '',
        attrs: a.attrs || {},
        sys: a.sys || {},
        connectedAt: a.connectedAt,
        lastLines,
        needsInput: hasPrompt(a.lastOutput),
        claudeState: a.claudeState || null,
        clientId: a.attrs && a.attrs.clientId ? a.attrs.clientId : null,
        fileHashes: a.fileHashes || null,
        runningHashes: a.runningHashes || null,
        rPrev: (() => {
          const cid = a.attrs && a.attrs.clientId;
          if (!cid) return null;
          const rv = agentRunningVersions.get(cid);
          return rv ? (rv.rPrev || null) : null;
        })()
      };
    });
}

function broadcastAgents() {
  for (const [ws, binfo] of browsers) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'agents', agents: getAgentsList(binfo.user), serverFiles: serverManifest }));
    }
  }
}

// Broadcast agents list every 10s to update lastLines in dashboard
setInterval(broadcastAgents, 10000);

// Print agent status summary to console every 60s
const CONSOLE_SUMMARY_INTERVAL = 60000;
setInterval(() => {
  const agentList = Array.from(agents.values());
  if (agentList.length === 0) {
    console.log(`[STATUS] ${new Date().toISOString()} — No agents connected`);
    return;
  }
  console.log(`[STATUS] ${new Date().toISOString()} — ${agentList.length} agent(s):`);
  for (const a of agentList) {
    const lines = a.lastOutput.split('\n');
    const last3 = lines.slice(-3).filter(l => l.trim()).join(' | ');
    const status = hasPrompt(a.lastOutput) ? 'WAITING' : 'RUNNING';
    console.log(`  [${status}] ${a.name} (${a.screen}) — ${last3.substring(0, 200)}`);
  }
}, CONSOLE_SUMMARY_INTERVAL);

// --- HTTP server ---
// Cache static pages in memory instead of a blocking sync disk read on every
// request — fs.readFileSync() stalls the whole (single-threaded) event loop,
// including in-flight WebSocket traffic, while it runs. A code change to a
// cached page needs a server restart to take effect.
const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const guideHtml = fs.readFileSync(path.join(__dirname, 'public', 'guide.html'));
const faviconSvg = fs.readFileSync(path.join(__dirname, 'public', 'favicon.svg'));

// --- Push-update: file manifests and known-good backup ---
// This server's on-disk copies are the single source of truth: the web UI
// pushes CLIENT_FILES diffs to agents (see push_update handler) and restarts
// itself to apply SERVER_FILES landed here out-of-band (deploy.sh/scp).
const CLIENT_FILES = ['client.js', 'claude-detector.js', 'spawn-validator.js', 'config-loader.js'];
// client.js is listed here too (though the server never runs it) because the
// manifest is the diff source for client pushes — without it,
// update_files_result couldn't record the agent's post-push client.js hash and
// every subsequent push would resend the whole file.
const SERVER_FILES = ['server.js', 'supervisor.js', 'client.js', 'claude-detector.js', 'spawn-validator.js',
  'config-loader.js', 'public/index.html', 'public/guide.html', 'public/favicon.svg'];
// Everything an agent may be asked to upload when it's the designated update
// source (pull_update). Client-side allowlist lives in client.js and must match.
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

// {name: hash} for the given list; missing files are omitted.
async function buildFileManifest(list) {
  const out = {};
  for (const name of list) {
    try { out[name] = await sha256File(path.join(__dirname, name)); } catch { /* omitted */ }
  }
  return out;
}

// Snapshot the booting (i.e. known-good) files for the restart rollback guard.
// Flat names in one dir to keep the restore `cp` simple; public/ files get
// re-split on restore. Only overwrite a backup when its content differs.
async function ensureRestartBackup() {
  const bakDir = path.join(__dirname, 'backups', 'pre-restart-latest');
  fs.mkdirSync(bakDir, { recursive: true });
  for (const name of SERVER_FILES) {
    const flat = name.replace(/\//g, '__');
    const src = path.join(__dirname, name);
    const dst = path.join(bakDir, flat);
    try {
      const [srcHash] = await Promise.all([sha256File(src)]);
      let dstHash = null;
      try { dstHash = await sha256File(dst); } catch { /* no backup yet */ }
      if (srcHash !== dstHash) fs.copyFileSync(src, dst);
    } catch (e) {
      console.log(`[!] backup skip ${name}: ${e.message}`);
    }
  }
}

let serverManifest = null; // filled before the WS server accepts connections

// Snapshot the files we're about to overwrite via pull_update, so a bad pull
// (e.g. wrong machine picked as source) can be undone by hand. Separate dir
// from the restart rollback backup — that one must stay "last known booting".
async function snapshotBeforePull(names) {
  const dir = path.join(__dirname, 'backups', 'pre-pull');
  fs.mkdirSync(dir, { recursive: true });
  const stamped = path.join(dir, new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(stamped, { recursive: true });
  for (const name of names) {
    try {
      const flat = name.replace(/\//g, '__');
      fs.copyFileSync(path.join(__dirname, name), path.join(stamped, flat));
    } catch { /* source missing — nothing to snapshot */ }
  }
  return stamped;
}

// Write files received from an agent (pull_update): verify sha256, then
// atomically replace. Any validation failure aborts the whole batch.
function applyPulledFiles(files) {
  const decoded = [];
  for (const f of files) {
    if (!FETCHABLE_FILES.includes(f.name)) throw new Error(`refusing non-whitelisted file: ${f.name}`);
    const buf = Buffer.from(f.content, 'base64');
    if (crypto.createHash('sha256').update(buf).digest('hex') !== f.sha256) {
      throw new Error(`sha256 mismatch for ${f.name}`);
    }
    decoded.push({ name: f.name, buf });
  }
  // All valid — write atomically (temp + rename) so a crash can't leave a
  // half-written file behind (server.js may be mid-replacement).
  for (const { name, buf } of decoded) {
    const dst = path.join(__dirname, name);
    const tmp = dst + '.pull-new';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dst);
  }
  return decoded.map(d => d.name);
}

// Verify + write the files an agent uploaded, snapshotting our old copies
// first. Replies to the requesting browser via the recorded pull request.
async function handleFetchFilesResult(msg, agentInfo, pull) {
  let result;
  try {
    if (!msg.ok || !Array.isArray(msg.files) || msg.files.length === 0) {
      throw new Error(msg.error || 'agent returned no files');
    }
    const names = msg.files.map(f => f.name);
    const backupDir = await snapshotBeforePull(names);
    const applied = applyPulledFiles(msg.files);
    // Refresh our manifest so subsequent pushes diff against what we just
    // wrote, and record new hashes as the agent's own (they ARE the source).
    serverManifest = await buildFileManifest(SERVER_FILES);
    for (const f of msg.files) {
      if (agentInfo.fileHashes && f.name in agentInfo.fileHashes) agentInfo.fileHashes[f.name] = f.sha256;
    }
    console.log(`[*] pull_update applied from ${agentInfo.name}: ${applied.join(', ')} (backup: ${backupDir})`);
    result = { type: 'pull_update_result', reqId: msg.reqId, ok: true, agentName: agentInfo.name, clientId: (agentInfo.attrs || {}).clientId || null, updated: applied, backupDir, message: '文件已落盘，重启服务器后生效' };
  } catch (e) {
    console.error(`[!] pull_update failed from ${agentInfo.name}: ${e.message}`);
    result = { type: 'pull_update_result', reqId: msg.reqId, ok: false, agentName: agentInfo.name, clientId: (agentInfo.attrs || {}).clientId || null, error: e.message };
  }
  if (pull.ws && pull.ws.readyState === pull.ws.OPEN) pull.ws.send(JSON.stringify(result));
}

// Self-restart (web "重启服务器应用更新" button): quit our swt-server screen and
// relaunch with the files currently on disk. Rollback guard: if the new server
// doesn't come up within 5s, restore the known-good boot snapshot and try once
// more. Runs detached — it must survive this process exiting.
function spawnRestartScript() {
  const DIR = __dirname;
  const NODE = process.execPath;
  const BAK = path.join(DIR, 'backups', 'pre-restart-latest');
  const script = `
set -u
sleep 1
screen -ls 2>/dev/null | grep -q '[.]swt-server' && screen -S swt-server -X quit
sleep 1
screen -dmS swt-server bash -c "cd '${DIR}' && exec '${NODE}' server.js 2>&1 | tee -a '${DIR}/server.log'"
sleep 5
if ! screen -ls 2>/dev/null | grep -q '[.]swt-server'; then
  echo "[self-update] relaunch failed, restoring backup and retrying once" >> '${DIR}/server.log'
  for f in '${BAK}'/*; do
    [ -f "$f" ] || continue
    base="$(basename "$f")"
    case "$base" in
      public__*) cp -f "$f" '${DIR}/public/'"$` + `{base#public__}" 2>/dev/null ;;
      *)         cp -f "$f" '${DIR}/'"$base" 2>/dev/null ;;
    esac
  done
  screen -dmS swt-server bash -c "cd '${DIR}' && exec '${NODE}' server.js 2>&1 | tee -a '${DIR}/server.log'"
fi
`;
  try {
    const child = require('child_process').spawn('bash', ['-c', script], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e) {
    console.log('[!] failed to spawn restart script:', e.message);
  }
}

const httpServer = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(indexHtml);
  } else if (req.url === '/guide.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(guideHtml);
  } else if (req.url === '/favicon.ico' || req.url === '/favicon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    res.end(faviconSvg);
  } else if (req.url === '/api/agents') {
    // API: return agent status as JSON (for CLI monitoring / supervisor)
    const list = Array.from(agents.values()).map(a => {
      const lines = a.lastOutput.split('\n');
      const lastLines = lines.slice(-10).join('\n');
      return {
        id: a.id,
        name: a.name,
        screen: a.screen || '',
        attrs: a.attrs || {},
        sys: a.sys || {},
        connectedAt: a.connectedAt,
        lastLines,
        needsInput: hasPrompt(a.lastOutput),
        scrollbackSize: a.term ? a.term.scrollback.length : 0,
        claudeState: a.claudeState || null,
        clientId: a.attrs && a.attrs.clientId ? a.attrs.clientId : null
      };
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ time: new Date().toISOString(), agents: list }, null, 2));
  } else if (req.url === '/api/supervisor') {
    // API: return current supervisor summary (or 503 if disabled)
    if (!supervisor) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'supervisor disabled' }));
    } else {
      const s = supervisor.buildSummary();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ time: new Date().toISOString(), ...s }, null, 2));
    }
  } else if (req.url === '/api/action' && req.method === 'POST') {
    // API: send input to an agent's terminal
    let body = '';
    let bodyTooLarge = false;
    req.on('data', chunk => {
      if (bodyTooLarge) return;
      body += chunk;
      if (body.length > MAX_ACTION_BODY) {
        bodyTooLarge = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Request body too large' }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        const { agentId, input } = JSON.parse(body);
        if (!agentId || input === undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Missing agentId or input' }));
          return;
        }
        const bytes = new TextEncoder().encode(input);
        let bin = '';
        bytes.forEach(b => bin += String.fromCharCode(b));
        const payload = btoa(bin);
        let sent = false;
        for (const [aws, ainfo] of agents) {
          if (ainfo.id === agentId && aws.readyState === aws.OPEN) {
            aws.send(JSON.stringify({ type: 'data', payload }));
            sent = true;
            break;
          }
        }
        if (sent) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Agent not found or offline' }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      }
    });
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// --- WebSocket server ---
// perMessageDeflate defaults to on in `ws`, costing a zlib context (~50-100KB)
// per connection plus per-message CPU. Payloads here are already base64 text —
// not worth the CPU/memory on a small VPS for the bandwidth it saves.
// maxPayload bounds a single frame's memory cost — `ws`'s own default is 100MB,
// which would let one oversized/malformed message (bug or hostile peer) spike
// memory well past what a small VPS has.
const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: false, maxPayload: MAX_WS_PAYLOAD });

wss.on('connection', (ws) => {
  let role = null; // 'agent' or 'browser'

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    // --- First message determines role ---

    if (msg.type === 'register' && !role) {
      // Agent registration — validate token
      if (!msg.token || !validTokens.has(msg.token)) {
        console.log(`[!] Invalid token from ${ws.remoteAddress}`);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
        ws.close();
        return;
      }
      if (agents.size >= MAX_AGENTS) {
        console.log(`[!] Agent registration rejected: at MAX_AGENTS (${MAX_AGENTS})`);
        ws.send(JSON.stringify({ type: 'error', message: 'Server at max agent capacity' }));
        ws.close();
        return;
      }
      role = 'agent';
      const id = generateAgentId();
      const user = tokenUserMap[msg.token] || 'user';
      const regFiles = (msg.files && typeof msg.files === 'object' && !Array.isArray(msg.files)) ? msg.files : null;
      // Register-time file hashes are the RUNNING version (R): the process
      // hashed its own files as of startup. Track the previous register's R
      // per clientId so the badge can tell "restarted onto unpublished local
      // code" (rPrev==serverManifest.client.js, r differs) apart from "server
      // is ahead, agent needs pushing" (r never changed).
      const cid = (msg.attrs || {}).clientId || null;
      if (cid && regFiles) {
        const prev = agentRunningVersions.get(cid) || {};
        agentRunningVersions.set(cid, { r: regFiles['client.js'] || null, rPrev: prev.r || null });
      }
      const info = {
        id,
        name: msg.name || 'unknown',
        screen: msg.screen || '',
        attrs: msg.attrs || {},
        sys: msg.sys || {},
        // sha256 of the agent's file copies (push-update versioning); at
        // register this equals the running version; query_files refreshes
        // update it to fresh DISK state afterwards. runningHashes stays the
        // register-time snapshot (R) — cloned, never mutated in place.
        fileHashes: regFiles,
        runningHashes: regFiles ? { ...regFiles } : null,
        connectedAt: new Date().toISOString(),
        ws,
        lastOutput: '',
        user
      };
      // Scrollback lives on the STABLE terminal (clientId|screen), not on this
      // connection — a reconnect reuses the existing buffer and seq continuity
      // instead of starting from an empty history.
      const tKey = terminalKey(info.attrs, info.screen);
      let term = terminals.get(tKey);
      if (!term) {
        term = { scrollback: [], scrollbackBytes: 0 };
        terminals.set(tKey, term);
      }
      info.term = term;
      info.lastSeq = term.scrollback.length > 0 ? term.scrollback[term.scrollback.length - 1].seq : null;
      agents.set(ws, info);
      console.log(`[+] Agent connected: ${info.name} (${id})`);
      broadcastAgents();
      if (supervisor) supervisor.onAgentConnected(info);

      // Register上报的 fileHashes 是进程启动时的磁盘快照——机器是版本源或
      // 进程启动后磁盘被改过时，A 会滞后真实磁盘最长一个 query_files 周期
      // (60s)，期间徽章可能误报 待更新。注册后立刻补发一次 query_files 把
      // A 拉到当前磁盘状态，不等心跳。
      const qfReqId = 'qf-reg-' + id;
      setTimeout(() => {
        if (ws.readyState === ws.OPEN) {
          try { ws.send(JSON.stringify({ type: 'query_files', reqId: qfReqId })); } catch { /* ignore */ }
        }
      }, 1500); // 给注册回包一点时间，避免和新连接的初始流量挤在一起

      // Server-side heartbeat timeout: if no message from agent for 120s, consider dead
      ws._agentAlive = true;
      ws._agentHbTimer = setInterval(() => {
        if (!ws._agentAlive) {
          console.log(`[!] Agent ${info.name} heartbeat timeout, closing`);
          clearInterval(ws._agentHbTimer);
          ws.terminate();
        }
        ws._agentAlive = false;
      }, 120000);
      // Mark alive on any message
      const origOnMsg = ws.listeners('message').pop();
      ws.prependListener('message', () => { ws._agentAlive = true; });
      return;
    }

    if (msg.type === 'auth' && !role) {
      // Browser auth
      if (msg.password !== password) {
        ws.send(JSON.stringify({ type: 'error', message: 'Auth failed' }));
        ws.close();
        return;
      }
      if (browsers.size >= MAX_BROWSERS) {
        console.log(`[!] Browser auth rejected: at MAX_BROWSERS (${MAX_BROWSERS})`);
        ws.send(JSON.stringify({ type: 'error', message: 'Server at max connection capacity, try again shortly' }));
        ws.close();
        return;
      }
      role = 'browser';
      const user = msg.username || 'user';
      browsers.set(ws, { ws, agentIds: new Set(), user });
      ws.send(JSON.stringify({ type: 'auth_ok', agents: getAgentsList(user), user, supervisorConfig: config.server.supervisor, serverFiles: serverManifest }));
      console.log(`[+] Browser connected (user: ${user})`);
      return;
    }

    if (!role) {
      ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
      ws.close();
      return;
    }

    // --- Agent messages ---
    if (role === 'agent' && msg.type === 'data') {
      const agentInfo = agents.get(ws);
      if (!agentInfo) return;

      // Decode and track last output for dashboard preview
      try {
        const text = Buffer.from(msg.payload, 'base64').toString('utf8');
        agentInfo.lastOutput += text;
        // Keep only last 10KB
        if (agentInfo.lastOutput.length > LAST_OUTPUT_MAX) {
          agentInfo.lastOutput = agentInfo.lastOutput.slice(-LAST_OUTPUT_MAX);
        }
      } catch (e) { /* ignore decode errors */ }

      // Append to the STABLE terminal's scrollback (survives reconnects). Each
      // chunk gets a monotonic seq so browsers can resume incrementally. Trim
      // in one batched splice only once meaningfully over budget, rather than
      // shifting the array on every message — see SCROLLBACK_TRIM_MARGIN.
      const seq = nextSeq();
      agentInfo.lastSeq = seq;
      const sb = agentInfo.term.scrollback;
      sb.push({ payload: msg.payload, seq });
      agentInfo.term.scrollbackBytes = (agentInfo.term.scrollbackBytes || 0) + msg.payload.length;
      if (agentInfo.term.scrollbackBytes > SCROLLBACK_MAX + SCROLLBACK_TRIM_MARGIN) {
        let dropCount = 0, freed = 0;
        while (agentInfo.term.scrollbackBytes - freed > SCROLLBACK_MAX && dropCount < sb.length - 1) {
          freed += sb[dropCount].payload.length;
          dropCount++;
        }
        if (dropCount > 0) {
          sb.splice(0, dropCount);
          agentInfo.term.scrollbackBytes -= freed;
        }
      }
      // Forward to browsers (check both single-agent and multi-agent subscriptions).
      // Replay is batched and yields to the event loop, so live frames can
      // otherwise interleave with older frames still being replayed — the
      // browser then draws history on top of the live screen. Hold this
      // agent's live frames per-browser until its replay finishes.
      const payload = JSON.stringify({ type: 'data', payload: msg.payload, agentId: agentInfo.id, seq });
      for (const [bws, binfo] of browsers) {
        if (!binfo.agentIds.has(agentInfo.id) || bws.readyState !== bws.OPEN) continue;
        if (binfo.replaying && binfo.replaying.has(agentInfo.id)) {
          if (!binfo.pendingLive) binfo.pendingLive = new Map();
          if (!binfo.pendingLive.has(agentInfo.id)) binfo.pendingLive.set(agentInfo.id, []);
          binfo.pendingLive.get(agentInfo.id).push(payload);
        } else {
          bws.send(payload);
        }
      }
    }

    // File transfer relay (agent → browser): forward any file_* message as-is.
    if (role === 'agent' && typeof msg.type === 'string' && msg.type.startsWith('file_')) {
      const agentInfo = agents.get(ws);
      if (!agentInfo) return;
      const fpayload = JSON.stringify(msg);
      for (const [bws, binfo] of browsers) {
        if (binfo.agentIds.has(agentInfo.id) && bws.readyState === bws.OPEN) {
          bws.send(fpayload);
        }
      }
    }

    // Agent periodically reports its detected Claude session state
    if (role === 'agent' && msg.type === 'claude_state') {
      const agentInfo = agents.get(ws);
      if (!agentInfo) return;
      const prev = agentInfo.claudeState;
      agentInfo.claudeState = {
        running: !!msg.state && msg.state.running,
        kind: msg.state ? msg.state.kind : 'none',
        prompt: msg.state ? (msg.state.prompt || '').substring(0, 500) : '',
        options: msg.state ? (msg.state.options || []).slice(0, 20) : [],
        lastLine: msg.state ? (msg.state.lastLine || '').substring(0, 300) : '',
        detectedAt: msg.state ? msg.state.detectedAt : null,
        receivedAt: new Date().toISOString()
      };
      if (supervisor) supervisor.onClaudeState(agentInfo.id, agentInfo.claudeState);
      // Notify watching browsers if state kind changed (saves bandwidth vs full broadcast).
      // Broadcast to all browsers so the dashboard management panel stays live
      // without each browser needing to subscribe to every agent.
      if (!prev || prev.kind !== agentInfo.claudeState.kind || prev.prompt !== agentInfo.claudeState.prompt) {
        const update = JSON.stringify({
          type: 'claude_state',
          agentId: agentInfo.id,
          state: agentInfo.claudeState
        });
        for (const [bws, binfo] of browsers) {
          if (bws.readyState === bws.OPEN) {
            bws.send(update);
          }
        }
      }
    }

    // Forward spawn_node_result and list_screens_result agent → browser
    if (role === 'agent' && (msg.type === 'spawn_node_result' || msg.type === 'list_screens_result')) {
      const agentInfo = agents.get(ws);
      if (!agentInfo) return;
      // Resolve any pending list_screens promise first
      if (msg.type === 'list_screens_result' && msg.reqId && pendingScreenQueries.has(msg.reqId)) {
        try {
          pendingScreenQueries.get(msg.reqId)({
            ok: !!msg.ok,
            screens: msg.screens || [],
            error: msg.error
          });
        } catch {}
      }
      const out = JSON.stringify({ ...msg, agentId: agentInfo.id, clientId: (agentInfo.attrs || {}).clientId || null });
      for (const [bws, binfo] of browsers) {
        if (bws.readyState === bws.OPEN) bws.send(out);
      }
    }

    // Push-update results: agent → requesting browser. On success the agent
    // re-registers with fresh hashes anyway; update the tracked copy here too
    // so the badge flips without waiting for the reconnect cycle.
    if (role === 'agent' && msg.type === 'update_files_result') {
      const agentInfo = agents.get(ws);
      if (!agentInfo) return;
      if (msg.ok && agentInfo.fileHashes && serverManifest) {
        for (const f of (msg.updated || [])) agentInfo.fileHashes[f] = serverManifest[f];
      }
      const out = JSON.stringify({ ...msg, type: 'push_update_result', agentName: agentInfo.name, agentId: agentInfo.id, clientId: (agentInfo.attrs || {}).clientId || null });
      const target = msg.reqId && pendingUpdateReqs.get(msg.reqId);
      if (target && target.readyState === target.OPEN) target.send(out);
      pendingUpdateReqs.delete(msg.reqId);
    }

    if (role === 'agent' && msg.type === 'query_files_result') {
      const agentInfo = agents.get(ws);
      if (!agentInfo) return;
      if (msg.ok && msg.files) agentInfo.fileHashes = msg.files;
      const out = JSON.stringify({ ...msg, agentName: agentInfo.name, agentId: agentInfo.id, clientId: (agentInfo.attrs || {}).clientId || null });
      const target = msg.reqId && pendingUpdateReqs.get(msg.reqId);
      if (target && target.readyState === target.OPEN) target.send(out);
      pendingUpdateReqs.delete(msg.reqId);
    }

    // restart_node ack: forwarded as push_update_result so the browser reuses
    // its existing pendingUpdateReqs plumbing (same Map, same timeout, same UI).
    if (role === 'agent' && msg.type === 'restart_node_result') {
      const agentInfo = agents.get(ws);
      if (!agentInfo) return;
      const out = JSON.stringify({ ...msg, type: 'push_update_result', agentName: agentInfo.name, agentId: agentInfo.id, clientId: (agentInfo.attrs || {}).clientId || null, updated: [], message: '已请求重启监控进程' });
      const target = msg.reqId && pendingUpdateReqs.get(msg.reqId);
      if (target && target.readyState === target.OPEN) target.send(out);
      pendingUpdateReqs.delete(msg.reqId);
    }

    if (role === 'agent' && msg.type === 'fetch_files_result') {
      const agentInfo = agents.get(ws);
      const pull = msg.reqId && pendingPulls.get(msg.reqId);
      if (!agentInfo || !pull) return;
      pendingPulls.delete(msg.reqId);
      handleFetchFilesResult(msg, agentInfo, pull).catch(() => {});
    }

    if (role === 'agent' && msg.type === 'resize') {
      // Not forwarded to browser (browser initiates resize)
    }

    // --- Heartbeat: agent ping → server pong ---
    if (role === 'agent' && msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }

    // --- Heartbeat: browser ping → server pong ---
    if (role === 'browser' && msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }

    // --- Browser messages ---
    if (role === 'browser' && msg.type === 'connect') {
      const binfo = browsers.get(ws);
      if (binfo) {
        // Single agent mode: clear multi subscriptions and set single agent
        binfo.agentIds = new Set([msg.agentId]);
        console.log(`[*] Browser watching agent: ${msg.agentId} (resume: ${!!msg.resume}, sinceSeq: ${msg.sinceSeq ?? '-'})`);
        // Fresh connect: full window replay. Resume (reconnect): incremental
        // replay from the browser's lastSeq — data produced while the browser
        // was away is delivered, not silently skipped.
        const ainfo = msg.agentId ? [...agents.values()].find(a => a.id === msg.agentId) : null;
        if (ainfo) {
          if (!msg.resume) {
            sendScrollbackReplay(ws, ainfo, () => {});
          } else {
            // Track the browser's position per agent so later resumes from
            // this connection can pick up where this replay ends.
            if (!binfo.lastSeq) binfo.lastSeq = new Map();
            binfo.lastSeq.set(msg.agentId, Number.isFinite(msg.sinceSeq) ? msg.sinceSeq : 0);
            sendScrollbackReplay(ws, ainfo, () => {}, msg.sinceSeq || 0);
          }
        }
      }
    }

    if (role === 'browser' && msg.type === 'connect_multi') {
      const binfo = browsers.get(ws);
      if (binfo && Array.isArray(msg.agentIds)) {
        binfo.agentIds = new Set(msg.agentIds);
        console.log(`[*] Browser watching ${msg.agentIds.length} agents: ${msg.agentIds.join(', ')} (resume: ${!!msg.resume})`);
        // Fresh connect: full replay per agent. Resume: incremental per agent
        // (sinceSeqs maps agentId -> lastSeq; agents missing from the map get 0,
        // i.e. the full recent window).
        const sinceSeqs = msg.resume && msg.sinceSeqs && typeof msg.sinceSeqs === 'object' ? msg.sinceSeqs : null;
        if (!msg.resume || sinceSeqs) {
          // Each agent's replay is independently paced (sendScrollbackReplay) and
          // kicked off without waiting on the others, so they interleave fairly
          // across event-loop ticks instead of one agent's history blocking the rest.
          for (const agentId of msg.agentIds) {
            const ainfo = [...agents.values()].find(a => a.id === agentId);
            if (ainfo && (!msg.resume || sinceSeqs)) {
              if (msg.resume && sinceSeqs) {
                if (!binfo.lastSeq) binfo.lastSeq = new Map();
                binfo.lastSeq.set(agentId, Number.isFinite(sinceSeqs[agentId]) ? sinceSeqs[agentId] : 0);
                sendScrollbackReplay(ws, ainfo, () => {}, sinceSeqs[agentId] || 0);
              } else {
                sendScrollbackReplay(ws, ainfo, () => {});
              }
            }
          }
        }
      }
    }

    if (role === 'browser' && msg.type === 'disconnect_multi') {
      const binfo = browsers.get(ws);
      if (binfo) {
        binfo.agentIds = new Set();
        console.log(`[*] Browser stopped watching all agents`);
      }
    }

    if (role === 'browser' && msg.type === 'scrollback_more') {
      // Lazy load: browser requests older chunks
      for (const [, ainfo] of agents) {
        if (ainfo.id === msg.agentId) {
          const from = Math.max(0, msg.fromIndex - SCROLLBACK_PAGE);
          const chunks = [];
          for (let i = from; i < msg.fromIndex; i++) {
            chunks.push(ainfo.term.scrollback[i]);
          }
          ws.send(JSON.stringify({
            type: 'scrollback_data',
            agentId: ainfo.id,
            chunks,
            fromIndex: from,
            toIndex: msg.fromIndex,
            hasMore: from > 0
          }));
          console.log(`[*] Sent scrollback batch ${from}-${msg.fromIndex} (${chunks.length} chunks)`);
          break;
        }
      }
    }

    if (role === 'browser' && msg.type === 'data') {
      const binfo = browsers.get(ws);
      if (!binfo || binfo.agentIds.size === 0) return;
      if (!msg.agentId || !binfo.agentIds.has(msg.agentId)) return;
      // Find the agent ws and forward
      for (const [aws, ainfo] of agents) {
        if (ainfo.id === msg.agentId && aws.readyState === aws.OPEN) {
          aws.send(JSON.stringify({ type: 'data', payload: msg.payload }));
          break;
        }
      }
    }

    if (role === 'browser' && msg.type === 'resize') {
      const binfo = browsers.get(ws);
      if (!binfo || binfo.agentIds.size === 0) return;
      if (!msg.agentId || !binfo.agentIds.has(msg.agentId)) return;
      for (const [aws, ainfo] of agents) {
        if (ainfo.id === msg.agentId && aws.readyState === aws.OPEN) {
          aws.send(JSON.stringify({ type: 'resize', cols: msg.cols, rows: msg.rows }));
          break;
        }
      }
    }

    // File transfer relay (browser → agent): forward any file_* message as-is.
    if (role === 'browser' && typeof msg.type === 'string' && msg.type.startsWith('file_')) {
      const binfo = browsers.get(ws);
      if (!binfo || !msg.agentId || !binfo.agentIds.has(msg.agentId)) return;
      for (const [aws, ainfo] of agents) {
        if (ainfo.id === msg.agentId && aws.readyState === aws.OPEN) {
          aws.send(JSON.stringify(msg));
          break;
        }
      }
    }

    // Restart screen session on the target agent (browser → agent).
    // Client kills its PTY; existing respawn logic re-attaches via `screen -x`.
    if (role === 'browser' && msg.type === 'restart_screen') {
      const binfo = browsers.get(ws);
      if (!binfo || !msg.agentId || !binfo.agentIds.has(msg.agentId)) return;
      for (const [aws, ainfo] of agents) {
        if (ainfo.id === msg.agentId && aws.readyState === aws.OPEN) {
          aws.send(JSON.stringify({ type: 'restart_screen' }));
          console.log(`[*] restart_screen forwarded to agent ${ainfo.name}`);
          break;
        }
      }
    }

    // Kill a node from the management panel (browser → agent) — either just
    // the monitoring agent (mode: 'agent_only') or the agent AND its
    // underlying task screen (mode: 'agent_and_task'). Like spawn_node, this
    // doesn't require the browser to be "watching" this agent's terminal —
    // it's a fleet-management action, not a terminal-session action.
    if (role === 'browser' && msg.type === 'kill_node') {
      const binfo = browsers.get(ws);
      if (!binfo) return;
      let matchWs = null, matchInfo = null;
      for (const [aws, ainfo] of agents) {
        if (aws.readyState === aws.OPEN && ainfo.id === msg.agentId) { matchWs = aws; matchInfo = ainfo; break; }
      }
      if (!matchWs) {
        ws.send(JSON.stringify({ type: 'kill_node_result', reqId: msg.reqId, ok: false, error: 'Agent not found or offline' }));
        return;
      }
      const mode = msg.mode === 'agent_and_task' ? 'agent_and_task' : 'agent_only';
      matchWs.send(JSON.stringify({ type: 'kill_node', reqId: msg.reqId, mode }));
      console.log(`[*] kill_node (${mode}) forwarded to agent ${matchInfo.name}`);
      ws.send(JSON.stringify({ type: 'kill_node_result', reqId: msg.reqId, ok: true }));
    }

    // Live-update the supervisor's config from the management panel (browser →
    // server). Any authenticated browser can call this — same trust level as
    // spawn_node/restart_screen/api-action, all of which already let a logged-in
    // browser affect the whole fleet. Persists to config.json (survives a
    // restart) and hot-reloads the running supervisor via initSupervisor().
    // The form always submits the full config, so every field below is
    // unconditionally applied (not a partial patch).
    if (role === 'browser' && msg.type === 'update_supervisor_config') {
      const errors = [];
      const next = { ...config.server.supervisor };

      next.enabled = !!msg.enabled;
      next.analyzerAgentName = String(msg.analyzerAgentName || '').trim().slice(0, 100);

      const webhook = String(msg.webhook || '').trim().slice(0, 500);
      if (webhook) {
        try { new URL(webhook); } catch { errors.push('webhook 不是合法 URL'); }
      }
      next.webhook = webhook;

      const numField = (key, label, min, max) => {
        const n = Number(msg[key]);
        if (!Number.isFinite(n) || n < min || n > max) {
          errors.push(`${label} 必须在 ${min}-${max} 之间`);
          return;
        }
        next[key] = Math.round(n);
      };
      numField('summaryInterval', '摘要间隔(秒)', 10, 86400);
      numField('idleTimeout', '空闲告警阈值(秒)', 10, 86400);
      numField('analyzerInterval', '分析间隔(秒)', 10, 86400);
      numField('analyzerTimeout', '分析超时(秒)', 5, 3600);

      if (errors.length) {
        ws.send(JSON.stringify({ type: 'supervisor_config_result', ok: false, error: errors.join('; ') }));
        return;
      }

      config.server.supervisor = next;
      try {
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
      } catch (e) {
        ws.send(JSON.stringify({ type: 'supervisor_config_result', ok: false, error: `保存到 config.json 失败: ${e.message}` }));
        return;
      }

      initSupervisor();
      console.log(`[*] Supervisor config updated by browser (enabled=${next.enabled}, analyzer=${next.analyzerAgentName || '(none)'})`);

      ws.send(JSON.stringify({ type: 'supervisor_config_result', ok: true }));
      const broadcastMsg = JSON.stringify({ type: 'supervisor_config', config: next });
      for (const [bws] of browsers) {
        if (bws.readyState === bws.OPEN) bws.send(broadcastMsg);
      }
    }

    // Spawn a new node on the target client machine (browser → server → agent).
    // Either msg.target.agentId (any agent of that client) or msg.target.clientId.
    // Generates a unique reqId for correlation.
    if (role === 'browser' && msg.type === 'spawn_node') {
      const binfo = browsers.get(ws);
      if (!binfo) return;
      const target = msg.target || {};
      let matchWs = null, matchInfo = null;
      for (const [aws, ainfo] of agents) {
        if (aws.readyState !== aws.OPEN) continue;
        if (target.agentId && ainfo.id === target.agentId) { matchWs = aws; matchInfo = ainfo; break; }
        if (target.clientId && (ainfo.attrs || {}).clientId === target.clientId) {
          matchWs = aws; matchInfo = ainfo; break;
        }
      }
      if (!matchWs) {
        ws.send(JSON.stringify({
          type: 'spawn_node_result',
          reqId: msg.reqId,
          ok: false,
          error: `No agent found for target ${JSON.stringify(target)}`
        }));
        return;
      }
      const fwd = JSON.stringify({
        type: 'spawn_node',
        reqId: msg.reqId,
        screenName: msg.screenName,
        nodeName: msg.nodeName,
        cmd: msg.cmd || 'bash'
      });
      matchWs.send(fwd);
      console.log(`[*] spawn_node forwarded to ${matchInfo.name} (client ${matchInfo.attrs && matchInfo.attrs.clientId}) screen=${msg.screenName} cmd=${msg.cmd || 'bash'}`);
    }

    // --- Push-update: send this server's managed-file diffs to agents ---
    // ALL of SERVER_FILES, not just the client-side four: agent machines keep
    // on-disk copies of server.js/public/* too (install.sh layout), and stale
    // copies there previously tripped the 待拉取 badge as false drift. The
    // agent writes them all but only self-restarts when a file it actually
    // RUNS (client-side four) changed. Content source is this server's own
    // on-disk copies (read fresh per push, so out-of-band scp'd updates are
    // picked up without a restart).
    async function buildUpdatePayload(agentInfo) {
      const files = [];
      for (const name of SERVER_FILES) {
        const want = serverManifest ? serverManifest[name] : null;
        const have = agentInfo.fileHashes ? agentInfo.fileHashes[name] : null;
        if (want && have === want) continue; // already up to date
        let content;
        try { content = fs.readFileSync(path.join(__dirname, name)); } catch { continue; }
        files.push({ name, content: content.toString('base64'), sha256: crypto.createHash('sha256').update(content).digest('hex') });
      }
      return files;
    }

    function findAgentByClientId(clientId) {
      for (const [aws, ainfo] of agents) {
        if (aws.readyState === aws.OPEN && (ainfo.attrs || {}).clientId === clientId) return { aws, ainfo };
      }
      return null;
    }

    // ALL live agents of a machine. Machines run one client process per screen
    // (monitor-1/2/3 share one clientId) — push/restart must reach every one of
    // them, not just the first match, or the badge stays stale for the rest.
    function findAllAgentsByClientId(clientId) {
      const matches = [];
      for (const [aws, ainfo] of agents) {
        if (aws.readyState === aws.OPEN && (ainfo.attrs || {}).clientId === clientId) matches.push({ aws, ainfo });
      }
      return matches;
    }

    async function pushToClient(ws, reqId, clientId) {
      // Diff against a FRESH manifest, not the boot-time one: files may have
      // been scp'd/deployed onto the server while it's running (that's the
      // whole update flow — deploy.sh lands files, then pushes happen).
      serverManifest = await buildFileManifest(SERVER_FILES);
      const matches = findAllAgentsByClientId(clientId);
      if (matches.length === 0) {
        ws.send(JSON.stringify({ type: 'push_update_result', reqId, agentName: clientId, ok: false, error: 'agent offline', updated: [] }));
        return;
      }
      const files = await buildUpdatePayload(matches[0].ainfo);
      if (files.length === 0) {
        ws.send(JSON.stringify({ type: 'push_update_result', reqId, agentName: matches[0].ainfo.name, ok: true, updated: [], message: 'already up to date' }));
        return;
      }
      // Send to EVERY process of this machine: each one applies the files and
      // replies with the same reqId; per-reqId replies after the first are
      // ignored by pendingUpdateReqs (single-slot), so the browser sees one
      // result — but every process has the work queued either way.
      pendingUpdateReqs.set(reqId, ws);
      for (const { aws, ainfo } of matches) {
        aws.send(JSON.stringify({ type: 'update_files', reqId, files }));
        console.log(`[*] push_update → ${ainfo.name}: ${files.map(f => f.name).join(', ')}`);
      }
    }

    if (role === 'browser' && msg.type === 'push_update') {
      const binfo = browsers.get(ws);
      if (binfo && msg.clientId && msg.reqId) pushToClient(ws, msg.reqId, msg.clientId);
    }

    if (role === 'browser' && msg.type === 'push_update_all') {
      const binfo = browsers.get(ws);
      if (binfo && msg.reqId) {
        const clientIds = new Set();
        for (const [, ainfo] of agents) {
          const cid = (ainfo.attrs || {}).clientId;
          if (cid) clientIds.add(cid);
        }
        for (const cid of clientIds) pushToClient(ws, msg.reqId + '-' + cid, cid);
      }
    }

    // --- Pull-update: treat the named agent as the version source ---
    // Ask it to upload FETCHABLE_FILES, then overwrite our on-disk copies.
    // The agent's hashes have ALREADY been compared against the agent's own
    // manifest by the browser, so here we take everything it sends.
    if (role === 'browser' && msg.type === 'pull_update') {
      const binfo = browsers.get(ws);
      if (binfo && msg.clientId && msg.reqId) {
        const match = findAgentByClientId(msg.clientId);
        if (!match) {
          ws.send(JSON.stringify({ type: 'pull_update_result', reqId: msg.reqId, agentName: msg.clientId, ok: false, error: 'agent offline' }));
        } else {
          pendingPulls.set(msg.reqId, { ws, agentName: match.ainfo.name });
          match.aws.send(JSON.stringify({ type: 'fetch_files', reqId: msg.reqId, names: FETCHABLE_FILES }));
          console.log(`[*] pull_update → fetching source files from ${match.ainfo.name}`);
        }
      }
    }

    if (role === 'browser' && msg.type === 'restart_server') {
      const binfo = browsers.get(ws);
      if (binfo && msg.reqId) {
        // Ack BEFORE initiating — the restart kills this WS mid-flight.
        ws.send(JSON.stringify({ type: 'restart_server_result', reqId: msg.reqId, ok: true, message: '服务器将在1秒后重启' }));
        console.log('[*] restart_server requested — restarting to apply on-disk files');
        setTimeout(spawnRestartScript, 500);
      }
    }

    // --- Restart a single agent's monitoring process (⏳ 待应用 fix) ---
    // The agent relaunches its own service screen (swt-client-<session>) so the
    // running code picks up what's already on disk. Task screens are untouched.
    // One client process per screen shares a clientId, so the restart request
    // must fan out to EVERY live process of that machine — a single send only
    // restarts one monitor, leaving the others stale (hence "click restart N
    // times").
    if (role === 'browser' && msg.type === 'restart_node') {
      const binfo = browsers.get(ws);
      if (binfo && msg.clientId && msg.reqId) {
        const matches = findAllAgentsByClientId(msg.clientId);
        if (matches.length === 0) {
          ws.send(JSON.stringify({ type: 'restart_node_result', reqId: msg.reqId, agentName: msg.clientId, ok: false, error: 'agent offline' }));
        } else {
          pendingUpdateReqs.set(msg.reqId, ws); // reuse: agent replies with restart_node_result → forwarded as push_update_result
          for (const { aws, ainfo } of matches) {
            aws.send(JSON.stringify({ type: 'restart_node', reqId: msg.reqId }));
            console.log("[*] restart_node sent to " + ainfo.name);
          }
        }
      }
    }
  });

  ws.on('close', () => {
    if (role === 'agent') {
      const info = agents.get(ws);
      if (info) {
        console.log(`[-] Agent disconnected: ${info.name} (${info.id})`);
        if (supervisor) supervisor.onAgentDisconnected(info);
      }
      agents.delete(ws);
      broadcastAgents();
    }
    if (role === 'browser') {
      console.log(`[-] Browser disconnected`);
      browsers.delete(ws);
    }
  });
});

// --- Supervisor ---
// Deps are built once; initSupervisor() (re)creates the actual instance from
// the current config.server.supervisor, so a live config update from the
// browser (see 'update_supervisor_config' below) can tear down and restart
// it in place without restarting the whole server.
const supervisorDeps = {
  getAgents: getAgentsList,
  getAgentRawOutput: (agentId) => {
    for (const [, ainfo] of agents) {
      if (ainfo.id === agentId) return ainfo.lastOutput || '';
    }
    return '';
  },
  sendToAgent: (agentId, input) => {
    for (const [aws, ainfo] of agents) {
      if (ainfo.id === agentId && aws.readyState === aws.OPEN) {
        aws.send(JSON.stringify({ type: 'data', payload: Buffer.from(input, 'utf8').toString('base64') }));
        return true;
      }
    }
    return false;
  },
  sendToAgentObj: (agentId, obj) => {
    for (const [aws, ainfo] of agents) {
      if (ainfo.id === agentId && aws.readyState === aws.OPEN) {
        aws.send(JSON.stringify(obj));
        return true;
      }
    }
    return false;
  },
  broadcastToBrowsers: (obj) => {
    const data = JSON.stringify(obj);
    for (const [bws] of browsers) {
      if (bws.readyState === bws.OPEN) bws.send(data);
    }
  },
  requestAgentListScreens: (agentId) => {
    return new Promise((resolve) => {
      const reqId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      let resolved = false;
      const onTimer = setTimeout(() => {
        if (!resolved) { resolved = true; resolve({ ok: false, error: 'timeout' }); }
      }, 5000);
      pendingScreenQueries.set(reqId, (result) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(onTimer);
        pendingScreenQueries.delete(reqId);
        resolve(result);
      });
      // Send list_screens request to agent
      for (const [aws, ainfo] of agents) {
        if (ainfo.id === agentId && aws.readyState === aws.OPEN) {
          aws.send(JSON.stringify({ type: 'list_screens', reqId }));
          return;
        }
      }
      // Agent not found
      if (!resolved) { resolved = true; clearTimeout(onTimer); pendingScreenQueries.delete(reqId); resolve({ ok: false, error: 'agent offline' }); }
    });
  }
};

let supervisor = null;
function initSupervisor() {
  if (supervisor) { supervisor.stop(); supervisor = null; }
  const supCfg = config.server.supervisor;
  if (supCfg && supCfg.enabled) {
    supervisor = createSupervisor(supCfg, supervisorDeps);
    supervisor.start();
  }
}
initSupervisor();

// --- Start ---
// Manifest + known-good backup are ready before (or shortly after) the first
// agents register; agents re-register on reconnect, so a slightly late fill
// self-corrects on the next 10s agents broadcast.
buildFileManifest(SERVER_FILES).then(m => {
  serverManifest = m;
  console.log(`[*] server file manifest ready (${Object.keys(m).length}/${SERVER_FILES.length} files)`);
  return ensureRestartBackup();
}).then(() => {
  console.log('[*] pre-restart backup verified');
}).catch(e => console.log('[!] manifest/backup init failed:', e.message));

// Periodic manifest refresh. The boot-time manifest goes stale when files are
// deployed onto the server while it runs (e.g. deploying a new client.js and
// restarting the AGENTS only — the server restarts later or never): the stale
// hashes then make every freshly-updated agent show a bogus "有更新" badge.
// Same tick asks each agent for fresh disk hashes (query_files) so the badge
// sees current A (agent disk), not just the register-time snapshot.
setInterval(() => {
  buildFileManifest(SERVER_FILES).then(m => { serverManifest = m; })
    .catch(e => console.log('[!] manifest refresh failed:', e.message));
  const reqId = 'qf-' + Date.now().toString(36);
  for (const [aws] of agents) {
    if (aws.readyState === aws.OPEN) {
      try { aws.send(JSON.stringify({ type: 'query_files', reqId })); } catch { /* ignore */ }
    }
  }
}, 60 * 1000);

httpServer.listen(port, () => {
  console.log(`Screen Web Terminal server listening on http://0.0.0.0:${port}`);
  if (supervisor) supervisor.start();
});
