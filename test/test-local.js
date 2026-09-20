/**
 * Local end-to-end test for the supervisor / claude_state / spawn_node features.
 *
 * Spins up:
 *   - a real SWT server (in-process, on an ephemeral port)
 *   - two MOCK agents that connect via WebSocket and emit fake Claude-like
 *     output (NO real screen, NO real claude binary)
 *   - a "browser" client that subscribes to events and asserts:
 *       * claude_state arrives with correct kind
 *       * dashboard-style agents list includes claudeState
 *       * /api/supervisor returns a summary
 *       * spawn_node validation rejects bad input (no screen touched)
 *
 * Safe by construction: no real `screen` or `claude` process is invoked.
 *
 * Run: node test/test-local.js
 */

'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

// We can't easily `require('../server')` because it self-starts. So we spawn
// it as a child process on a unique port.

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PORT = 18799 + Math.floor(Math.random() * 1000);
const PASSWORD = 'test-pwd';
const TOKEN = 'test-token-abc';

function makeServerConfig() {
  return {
    mode: 'server',
    server: {
      port: PORT,
      password: PASSWORD,
      tokens: { [TOKEN]: { name: 'test', user: 'test', desc: 'test' } },
      supervisor: {
        enabled: true,
        summaryInterval: 5,   // 5s for fast tests
        idleTimeout: 9999,
        spawnAnalyzerClaude: false  // never actually spawn in tests
        // llm intentionally omitted → no external API calls
      }
    }
  };
}

function log(...args) { console.log(`[test] ${args.join(' ')}`); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Tiny WS mock agent. Sends register, then emits `claude_state` directly
// (bypassing the detector) AND periodically sends `data` payloads that look
// like Claude output, so the server's claude_state propagation can be verified.
class MockAgent {
  constructor(name, screen, clientId) {
    this.name = name;
    this.screen = screen;
    this.clientId = clientId;
    this.ws = null;
    this.received = [];
    this.alive = true;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({
          type: 'register',
          token: TOKEN,
          name: this.name,
          screen: this.screen,
          attrs: { clientId: this.clientId },
          sys: { hostname: 'test' }
        }));
        resolve();
      });
      this.ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw.toString()); } catch { return; }
        this.received.push(m);
        if (m.type === 'spawn_node') this.handleSpawnNodeLikeClient(m);
      });
      this.ws.on('error', reject);
    });
  }
  sendState(state) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'claude_state', state }));
  }
  sendData(text) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      type: 'data',
      payload: Buffer.from(text).toString('base64')
    }));
  }
  sendRaw(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(obj));
  }
  // Pretend to be client.js for spawn_node: validate, but never actually spawn
  // a real screen. Returns spawn_node_result with ok=false in test mode.
  handleSpawnNodeLikeClient(msg) {
    const { validateSpawnRequest, SPAWN_MAX_NODES } = require('../spawn-validator');
    const v = validateSpawnRequest(msg);
    if (!v.ok) {
      this.sendRaw({ type: 'spawn_node_result', reqId: msg.reqId, ok: false, error: v.error });
      return;
    }
    // In test mode we always reject to avoid spawning real screen sessions
    this.sendRaw({
      type: 'spawn_node_result',
      reqId: msg.reqId,
      ok: false,
      error: 'TEST_MODE_NO_SPAWN: validation passed but spawn suppressed in tests'
    });
  }
  close() {
    this.alive = false;
    try { this.ws.close(); } catch {}
  }
}

// Browser WS client
class BrowserClient {
  constructor() { this.ws = null; this.events = []; this.agents = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ type: 'auth', password: PASSWORD, username: 'test' }));
      });
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        this.events.push(m);
        if (m.type === 'auth_ok') { this.agents = m.agents || []; resolve(); }
        if (m.type === 'agents') this.agents = m.agents || [];
      });
      this.ws.on('error', reject);
    });
  }
  waitFor(predFn, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        const found = predFn(this.events);
        if (found) return resolve(found);
        if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for event'));
        setTimeout(check, 100);
      };
      check();
    });
  }
  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
  close() { try { this.ws.close(); } catch {} }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    }).on('error', reject);
  });
}

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

async function main() {
  // 1. Write server config + spawn server
  const cfgPath = path.join(PROJECT_ROOT, `config.test-server-${PORT}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify(makeServerConfig(), null, 2));
  log(`spawning server on port ${PORT}, cfg=${cfgPath}`);

  const { spawn } = require('child_process');
  const serverProc = spawn(process.execPath, ['server.js', `--config=${cfgPath}`], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProc.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
  serverProc.stderr.on('data', d => process.stderr.write(`[server!] ${d}`));

  // wait for server to come up
  await sleep(800);

  try {
    // 2. Connect two mock agents with different Claude states
    const agent1 = new MockAgent('test-alpha', 'screen-alpha', 'CLIENT-A');
    const agent2 = new MockAgent('test-beta', 'screen-beta', 'CLIENT-B');
    await agent1.connect();
    await agent2.connect();
    log('both mock agents connected');

    // Agent 1: yes/no Claude state
    agent1.sendState({
      running: true,
      kind: 'yesno',
      prompt: 'Do you want to proceed?',
      options: [],
      lastLine: '❯ Yes',
      detectedAt: new Date().toISOString()
    });
    agent1.sendData('Welcome to Claude Code!\nDo you want to proceed?\n  ❯ Yes\n    No\n');

    // Agent 2: option-list Claude state
    agent2.sendState({
      running: true,
      kind: 'option',
      prompt: 'Pick a strategy',
      options: [
        { index: 1, label: 'aggressive' },
        { index: 2, label: 'conservative' }
      ],
      lastLine: '2. conservative',
      detectedAt: new Date().toISOString()
    });
    agent2.sendData('Welcome to Claude Code!\nPick a strategy\n  1. aggressive\n  2. conservative\n');

    // 3. Connect a browser
    const browser = new BrowserClient();
    await browser.connect();
    browser.send({ type: 'connect_multi', agentIds: [] }); // subscribe to all broadcasts
    log('browser connected');

    // Wait for at least one claude_state event
    await sleep(2500);

    // 4. Assertions
    log('--- assertions ---');

    // (a) agents list includes claudeState
    await sleep(500);
    const found1 = browser.agents.find(a => a.name === 'test-alpha');
    const found2 = browser.agents.find(a => a.name === 'test-beta');
    assert(found1 && found2, 'browser received both agents in list');
    assert(found1 && found1.claudeState && found1.claudeState.kind === 'yesno',
      `agent1 claudeState.kind = yesno (got: ${found1 && found1.claudeState && found1.claudeState.kind})`);
    assert(found2 && found2.claudeState && found2.claudeState.kind === 'option',
      `agent2 claudeState.kind = option (got: ${found2 && found2.claudeState && found2.claudeState.kind})`);
    assert(found1 && found1.clientId === 'CLIENT-A', 'agent1 clientId propagated');
    assert(found2 && found2.claudeState.options.length === 2, 'agent2 has 2 options');

    // (b) detector unit test (re-check via /api/agents or locally)
    const apiRes = await httpGet(`http://127.0.0.1:${PORT}/api/agents`);
    assert(apiRes.status === 200, '/api/agents returns 200');
    assert(apiRes.body.agents && apiRes.body.agents.length === 2, '/api/agents lists 2 agents');
    const apiA1 = apiRes.body.agents.find(a => a.name === 'test-alpha');
    assert(apiA1 && apiA1.claudeState && apiA1.claudeState.kind === 'yesno', '/api/agents has agent1 claudeState=yesno');

    // (c) /api/supervisor returns summary
    const supRes = await httpGet(`http://127.0.0.1:${PORT}/api/supervisor`);
    assert(supRes.status === 200, '/api/supervisor returns 200');
    assert(typeof supRes.body.message === 'string' && supRes.body.message.length > 0,
      'supervisor returns non-empty message');
    assert(supRes.body.agents && supRes.body.agents.length === 2, 'supervisor lists 2 agents');
    assert(supRes.body.clients && supRes.body.clients.length === 2, 'supervisor groups into 2 clients');
    log(`summary: ${supRes.body.message.split('\n').map(s=>'    '+s).join('\n')}`);

    // (d) supervisor_event broadcast (periodic summary fires every 5s)
    try {
      const ev = await browser.waitFor(e => e.find(x => x.type === 'supervisor_event' && x.event && x.event.type === 'summary'), 8000);
      assert(!!ev, 'browser received supervisor summary event');
    } catch (e) {
      assert(false, `browser received supervisor summary event (${e.message})`);
    }

    // (e) spawn_node validation: invalid screenName should be rejected
    const badReqId = 'req-bad-name';
    browser.send({
      type: 'spawn_node',
      reqId: badReqId,
      target: { clientId: 'CLIENT-A' },
      screenName: 'bad name with spaces',
      cmd: 'bash'
    });
    try {
      const ev = await browser.waitFor(
        es => es.find(x => x.type === 'spawn_node_result' && x.reqId === badReqId),
        5000
      );
      assert(!ev.ok && /Invalid/i.test(ev.error || ''), 'spawn_node rejects bad screenName');
    } catch (e) {
      assert(false, `spawn_node bad-name rejection (${e.message})`);
    }

    // (f) spawn_node validation: invalid cmd rejected
    const badCmdId = 'req-bad-cmd';
    browser.send({
      type: 'spawn_node',
      reqId: badCmdId,
      target: { clientId: 'CLIENT-A' },
      screenName: 'valid-name',
      cmd: 'rm'   // not in whitelist
    });
    try {
      const ev = await browser.waitFor(
        es => es.find(x => x.type === 'spawn_node_result' && x.reqId === badCmdId),
        5000
      );
      assert(!ev.ok && /cmd must be one of/i.test(ev.error || ''), 'spawn_node rejects bad cmd');
    } catch (e) {
      assert(false, `spawn_node bad-cmd rejection (${e.message})`);
    }

    // (f2) spawn_node: valid params — in test mode, MockAgent suppresses actual spawn
    //      and returns "TEST_MODE_NO_SPAWN" so we never spawn a real screen.
    const validReqId = 'req-valid-but-suppressed';
    browser.send({
      type: 'spawn_node',
      reqId: validReqId,
      target: { clientId: 'CLIENT-A' },
      screenName: 'test-node-1',
      cmd: 'bash'
    });
    try {
      const ev = await browser.waitFor(
        es => es.find(x => x.type === 'spawn_node_result' && x.reqId === validReqId),
        5000
      );
      assert(!ev.ok && /TEST_MODE_NO_SPAWN/.test(ev.error || ''),
        'spawn_node valid params → suppressed in test mode (no real screen spawned)');
    } catch (e) {
      assert(false, `spawn_node test-mode suppression (${e.message})`);
    }

    // (g) spawn_node: missing target → error
    const noTargetId = 'req-no-target';
    browser.send({
      type: 'spawn_node',
      reqId: noTargetId,
      target: { clientId: 'NONEXISTENT' },
      screenName: 'whatever',
      cmd: 'bash'
    });
    try {
      const ev = await browser.waitFor(
        es => es.find(x => x.type === 'spawn_node_result' && x.reqId === noTargetId),
        5000
      );
      assert(!ev.ok && /No agent found/i.test(ev.error || ''), 'spawn_node rejects missing target');
    } catch (e) {
      assert(false, `spawn_node no-target rejection (${e.message})`);
    }

    // (h) Verify claude_state broadcast reaches browser when state changes
    agent1.sendState({
      running: true,
      kind: 'option',
      prompt: 'Pick again',
      options: [{ index: 1, label: 'foo' }, { index: 2, label: 'bar' }],
      lastLine: '2. bar',
      detectedAt: new Date().toISOString()
    });
    try {
      const ev = await browser.waitFor(
        es => es.find(x => x.type === 'claude_state' && x.agentId === found1.id && x.state && x.state.kind === 'option'),
        5000
      );
      assert(ev && ev.state.options.length === 2, 'browser received updated claude_state');
    } catch (e) {
      assert(false, `claude_state broadcast (${e.message})`);
    }

    // (i) Verify supervisor event payload structure on initial summary
    try {
      const ev = await browser.waitFor(
        es => es.find(x => x.type === 'supervisor_event' && x.event && x.event.agents && x.event.agents.length === 2),
        8000
      );
      const ags = ev.event.agents;
      assert(ags[0].claude !== undefined, 'supervisor summary agent has claude field');
      assert(ev.event.clients && ev.event.clients.length === 2, 'supervisor summary has 2 clients');
    } catch (e) {
      assert(false, `supervisor summary structure (${e.message})`);
    }

    // 5. Clean shutdown
    log('--- done, shutting down ---');
    browser.close();
    agent1.close();
    agent2.close();
    await sleep(300);
  } finally {
    // cleanup
    try { fs.unlinkSync(cfgPath); } catch {}
    try { serverProc.kill('SIGTERM'); } catch {}
    setTimeout(() => {
      try { serverProc.kill('SIGKILL'); } catch {}
    }, 1000);
  }

  // wait briefly to let server die
  await sleep(800);
  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('[test] FATAL', e);
  process.exit(2);
});
