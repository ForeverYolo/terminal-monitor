const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createSupervisor } = require('./supervisor');

// --- Load config (support --config flag) ---
const configArg = process.argv.find(a => a.startsWith('--config='))?.split('=')[1]
  || (process.argv.indexOf('--config') !== -1 ? process.argv[process.argv.indexOf('--config') + 1] : null);
const configFile = configArg || path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const { port, password, tokens } = config.server;
const validTokens = new Set(Object.keys(tokens || {}));
const tokenUserMap = {};
for (const [token, info] of Object.entries(tokens || {})) {
  tokenUserMap[token] = info.user || 'user';
}

// --- State ---
const agents = new Map();   // ws -> { id, name, screen, attrs, sys, ws, scrollback }
const browsers = new Map(); // ws -> { ws, agentIds: Set }
const SCROLLBACK_MAX = 2000000; // ~2MB scrollback per agent
const SCROLLBACK_INIT = 50000;  // send recent scrollback on connect
const SCROLLBACK_PAGE = 500;    // chunks per lazy-load request
const LAST_OUTPUT_MAX = 10000; // keep last 10KB for status preview
const LAST_LINES_COUNT = 3;    // show last 3 lines in dashboard

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
        needsInput: hasPrompt(a.lastOutput)
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
const httpServer = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const file = path.join(__dirname, 'public', 'index.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  } else if (req.url === '/favicon.ico' || req.url === '/favicon.svg') {
    const file = path.join(__dirname, 'public', 'favicon.svg');
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    res.end(fs.readFileSync(file));
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
        scrollbackSize: a.scrollback.length
      };
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ time: new Date().toISOString(), agents: list }, null, 2));
  } else if (req.url === '/api/action' && req.method === 'POST') {
    // API: send input to an agent's terminal
    let body = '';
    req.on('data', chunk => { body += chunk; });
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
const wss = new WebSocketServer({ server: httpServer });

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
      role = 'browser';
      const user = msg.username || 'user';
      browsers.set(ws, { ws, agentIds: new Set(), user });
      ws.send(JSON.stringify({ type: 'auth_ok', agents: getAgentsList(user), user }));
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

      // Append to scrollback
      agentInfo.scrollback.push(msg.payload);
      let total = agentInfo.scrollback.reduce((s, p) => s + p.length, 0);
      while (total > SCROLLBACK_MAX && agentInfo.scrollback.length > 1) {
        total -= agentInfo.scrollback.shift().length;
      }
      // Forward to browsers (check both single-agent and multi-agent subscriptions)
      const payload = JSON.stringify({ type: 'data', payload: msg.payload, agentId: agentInfo.id });
      for (const [bws, binfo] of browsers) {
        if (binfo.agentIds.has(agentInfo.id) && bws.readyState === bws.OPEN) {
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
          // Send recent scrollback (last SCROLLBACK_INIT chunks)
          for (const [, ainfo] of agents) {
            if (ainfo.id === msg.agentId && ainfo.scrollback.length > 0) {
              const total = ainfo.scrollback.length;
              const start = Math.max(0, total - SCROLLBACK_INIT);
              for (let i = start; i < total; i++) {
                ws.send(JSON.stringify({ type: 'data', payload: ainfo.scrollback[i], agentId: ainfo.id }));
              }
              // Tell browser how much history is available
              ws.send(JSON.stringify({
                type: 'scrollback_info',
                agentId: ainfo.id,
                total: total,
                loadedFrom: start,
                hasMore: start > 0
              }));
              // End marker so browser scrolls to bottom after all data is written
              ws.send(JSON.stringify({
                type: 'scrollback_end',
                agentId: ainfo.id
              }));
              console.log(`[*] Sent ${total - start}/${total} scrollback chunks to browser`);
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
          // Send scrollback for each agent
          for (const agentId of msg.agentIds) {
            for (const [, ainfo] of agents) {
              if (ainfo.id === agentId && ainfo.scrollback.length > 0) {
                const total = ainfo.scrollback.length;
                const start = Math.max(0, total - SCROLLBACK_INIT);
                for (let i = start; i < total; i++) {
                  ws.send(JSON.stringify({ type: 'data', payload: ainfo.scrollback[i], agentId: ainfo.id }));
                }
                ws.send(JSON.stringify({
                  type: 'scrollback_info',
                  agentId: ainfo.id,
                  total: total,
                  loadedFrom: start,
                  hasMore: start > 0
                }));
                ws.send(JSON.stringify({
                  type: 'scrollback_end',
                  agentId: ainfo.id
                }));
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
const supCfg = config.server.supervisor;
let supervisor = null;
if (supCfg && supCfg.enabled) {
  supervisor = createSupervisor(supCfg, {
    getAgents: getAgentsList,
    sendToAgent: (agentId, input) => {
      for (const [aws, ainfo] of agents) {
        if (ainfo.id === agentId && aws.readyState === aws.OPEN) {
          const bytes = new TextEncoder().encode(input);
          let bin = '';
          bytes.forEach(b => bin += String.fromCharCode(b));
          aws.send(JSON.stringify({ type: 'data', payload: btoa(bin) }));
          return true;
        }
      }
      return false;
    }
  });
}

// --- Start ---
httpServer.listen(port, () => {
  console.log(`Screen Web Terminal server listening on http://0.0.0.0:${port}`);
  if (supervisor) supervisor.start();
});
