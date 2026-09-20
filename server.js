const http = require('http');
const fs = require('fs');
const path = require('path');
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
const agents = new Map();   // ws -> { id, name, screen, attrs, sys, ws, scrollback }
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

// Replay an agent's buffered scrollback to a browser in small batches, yielding
// to the event loop between each so a large history doesn't stall every other
// connection on the server (see SCROLLBACK_SEND_BATCH). Wire format is
// unchanged — same `data`/`scrollback_info`/`scrollback_end` messages, just
// paced. `done` fires when finished, including when there's nothing to send.
function sendScrollbackReplay(ws, ainfo, done) {
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

  const total = ainfo.scrollback.length;
  if (total === 0) {
    // Empty buffer still reports info+end: browsers treat scrollback_end as
    // "replay finished" to trigger their post-connect repaint; with no end
    // message a fresh session's terminal would never get one.
    ws.send(JSON.stringify({ type: 'scrollback_info', agentId: ainfo.id, total: 0, loadedFrom: 0, hasMore: false }));
    ws.send(JSON.stringify({ type: 'scrollback_end', agentId: ainfo.id }));
    finish();
    done();
    return;
  }
  // Walk back from the most recent chunk, stopping at whichever limit —
  // chunk count or total bytes — is hit first. Bounded to at most
  // SCROLLBACK_INIT iterations, so this is a cheap, one-time scan.
  let start = total, bytes = 0, count = 0;
  while (start > 0 && count < SCROLLBACK_INIT && bytes < SCROLLBACK_INIT_BYTES) {
    start--;
    bytes += ainfo.scrollback[start].length;
    count++;
  }
  let i = start;
  function sendBatch() {
    if (ws.readyState !== ws.OPEN) { finish(); done(); return; } // browser gone mid-replay
    const end = Math.min(i + SCROLLBACK_SEND_BATCH, total);
    for (; i < end; i++) {
      ws.send(JSON.stringify({ type: 'data', payload: ainfo.scrollback[i], agentId: ainfo.id }));
    }
    if (i < total) {
      setImmediate(sendBatch);
      return;
    }
    ws.send(JSON.stringify({ type: 'scrollback_info', agentId: ainfo.id, total, loadedFrom: start, hasMore: start > 0 }));
    ws.send(JSON.stringify({ type: 'scrollback_end', agentId: ainfo.id }));
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
        clientId: a.attrs && a.attrs.clientId ? a.attrs.clientId : null
      };
    });
}

function broadcastAgents() {
  for (const [ws, binfo] of browsers) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'agents', agents: getAgentsList(binfo.user) }));
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
        scrollbackSize: a.scrollback.length,
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
      const info = {
        id,
        name: msg.name || 'unknown',
        screen: msg.screen || '',
        attrs: msg.attrs || {},
        sys: msg.sys || {},
        connectedAt: new Date().toISOString(),
        ws,
        scrollback: [],
        scrollbackBytes: 0,
        lastOutput: '',
        user
      };
      agents.set(ws, info);
      console.log(`[+] Agent connected: ${info.name} (${id})`);
      broadcastAgents();
      if (supervisor) supervisor.onAgentConnected(info);

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
      ws.send(JSON.stringify({ type: 'auth_ok', agents: getAgentsList(user), user, supervisorConfig: config.server.supervisor }));
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

      // Append to scrollback. Track total bytes incrementally (no reduce()) and
      // trim in one batched splice only once meaningfully over budget, rather
      // than shifting the array on every message — see SCROLLBACK_TRIM_MARGIN.
      agentInfo.scrollback.push(msg.payload);
      agentInfo.scrollbackBytes = (agentInfo.scrollbackBytes || 0) + msg.payload.length;
      if (agentInfo.scrollbackBytes > SCROLLBACK_MAX + SCROLLBACK_TRIM_MARGIN) {
        let dropCount = 0, freed = 0;
        const sb = agentInfo.scrollback;
        while (agentInfo.scrollbackBytes - freed > SCROLLBACK_MAX && dropCount < sb.length - 1) {
          freed += sb[dropCount].length;
          dropCount++;
        }
        if (dropCount > 0) {
          sb.splice(0, dropCount);
          agentInfo.scrollbackBytes -= freed;
        }
      }
      // Forward to browsers (check both single-agent and multi-agent subscriptions).
      // Replay is batched and yields to the event loop, so live frames can
      // otherwise interleave with older frames still being replayed — the
      // browser then draws history on top of the live screen. Hold this
      // agent's live frames per-browser until its replay finishes.
      const payload = JSON.stringify({ type: 'data', payload: msg.payload, agentId: agentInfo.id });
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
        console.log(`[*] Browser watching agent: ${msg.agentId} (resume: ${!!msg.resume})`);
        // On resume (reconnect), skip scrollback replay — frontend keeps its own buffer.
        if (!msg.resume && msg.agentId) {
          for (const [, ainfo] of agents) {
            if (ainfo.id === msg.agentId) {
              sendScrollbackReplay(ws, ainfo, () => {});
              break;
            }
          }
        }
      }
    }

    if (role === 'browser' && msg.type === 'connect_multi') {
      const binfo = browsers.get(ws);
      if (binfo && Array.isArray(msg.agentIds)) {
        binfo.agentIds = new Set(msg.agentIds);
        console.log(`[*] Browser watching ${msg.agentIds.length} agents: ${msg.agentIds.join(', ')} (resume: ${!!msg.resume})`);
        // On resume (reconnect), skip scrollback replay.
        if (!msg.resume) {
          // Each agent's replay is independently paced (sendScrollbackReplay) and
          // kicked off without waiting on the others, so they interleave fairly
          // across event-loop ticks instead of one agent's history blocking the rest.
          for (const agentId of msg.agentIds) {
            for (const [, ainfo] of agents) {
              if (ainfo.id === agentId) {
                sendScrollbackReplay(ws, ainfo, () => {});
                break;
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
            chunks.push(ainfo.scrollback[i]);
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
httpServer.listen(port, () => {
  console.log(`Screen Web Terminal server listening on http://0.0.0.0:${port}`);
  if (supervisor) supervisor.start();
});
