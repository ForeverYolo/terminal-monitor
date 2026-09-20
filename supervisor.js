/**
 * Supervisor (overseer) module — server-side orchestrator.
 *
 * Responsibilities:
 *   1. Aggregate per-agent Claude session state (from `claude_state` messages).
 *   2. Count nodes per clientId (via list_screens round-trips).
 *   3. Periodically produce a human-readable summary of the whole fleet.
 *   4. Drive a designated "analyzer" Claude agent (a real Claude Code node) to
 *      produce AI summaries + suggestions. The analyzer is a persistent agent
 *      (manages its own context across cycles), NOT a one-shot LLM call.
 *   5. Broadcast `supervisor_event` messages to browsers (management panel).
 *
 * Safety contract:
 *   - The analyzer is a real Claude Code with tools, so the supervisor auto-DENIES
 *     every permission prompt it raises (kind==='bash'). Physically it can never
 *     execute anything — pure analysis. Plus each cycle's prompt forbids tools.
 *   - The supervisor NEVER auto-injects into other agents' terminals. The
 *     analyzer's suggestions are advisory, shown in the panel; a human clicks to
 *     apply.
 *
 * Enabled via config.server.supervisor.enabled.
 * Analyzer config:
 *   supervisor.analyzerAgentName  — name of the Claude node to use as analyzer
 *                                   (you start it yourself on a machine of choice)
 *   supervisor.analyzerInterval   — seconds between analysis cycles (default 300)
 *   supervisor.analyzerTimeout    — seconds to wait for a <SUMMARY> per cycle (default 120)
 */

'use strict';

const http = require('http');
const https = require('https');
const { stripAnsi } = require('./claude-detector');

function createSupervisor(cfg, deps) {
  const {
    getAgents,               // () => agentInfo[]  (includes claudeState, lastLines)
    getAgentRawOutput,       // (agentId) => raw lastOutput string (for SUMMARY extraction)
    sendToAgent,             // (agentId, input) => boolean  (types into the agent's PTY)
    sendToAgentObj,          // (agentId, obj) => boolean
    broadcastToBrowsers,     // (obj) => void
    requestAgentListScreens  // (agentId) => Promise<{screens[]}>
  } = deps;

  const summaryInterval = (cfg.summaryInterval || 60) * 1000;
  const idleTimeout = (cfg.idleTimeout || 600) * 1000;
  const webhook = cfg.webhook || '';

  // --- Analyzer config ---
  const analyzerName = cfg.analyzerAgentName || '';
  const analyzerInterval = (cfg.analyzerInterval || 300) * 1000;
  const analyzerTimeout = (cfg.analyzerTimeout || 120) * 1000;

  // Per-agent state cache keyed by agentId
  const agentState = new Map();   // id -> { claude, lastChange, lastStatus }
  // Per-client node counts
  const clientNodeCounts = new Map(); // clientId -> count

  let summaryTimer = null;
  let idleTimer = null;
  let screenQueryTimer = null;
  let analyzerTimer = null;

  // ============ Aggregation ============

  function onClaudeState(agentId, state) {
    const prev = agentState.get(agentId) || {
      claude: null, lastChange: Date.now(), lastStatus: 'RUNNING'
    };
    prev.claude = state;
    const newStatus = state && state.running ? (state.kind === 'working' ? 'RUNNING' : 'WAITING') : 'IDLE';
    if (prev.lastStatus !== newStatus) {
      prev.lastStatus = newStatus;
      prev.lastChange = Date.now();
    }
    agentState.set(agentId, prev);
  }

  function onAgentConnected(agentInfo) {
    agentState.set(agentInfo.id, { claude: null, lastChange: Date.now(), lastStatus: 'RUNNING' });
    notify('agent_connected', { agent: summarizeAgent(agentInfo) });
    if (requestAgentListScreens) {
      requestAgentListScreens(agentInfo.id).then(res => {
        if (res && res.ok) updateClientCount(agentInfo);
      }).catch(() => {});
    }
  }

  function onAgentDisconnected(agentInfo) {
    agentState.delete(agentInfo.id);
    notify('agent_disconnected', { agent: { name: agentInfo.name, screen: agentInfo.screen } });
  }

  function updateClientCount(agentInfo) {
    const cid = (agentInfo.attrs || {}).clientId;
    if (!cid) return;
    if (requestAgentListScreens) {
      requestAgentListScreens(agentInfo.id).then(res => {
        if (res && res.ok && Array.isArray(res.screens)) {
          clientNodeCounts.set(cid, res.screens.length);
        }
      }).catch(() => {});
    }
  }

  function summarizeAgent(a) {
    // `a` is either the raw internal agentInfo (has lastOutput, e.g. from
    // onAgentConnected) or the list-view shape from getAgents() (has lastLines
    // instead, no lastOutput) — handle both so lastLines isn't silently empty.
    const last3 = a.lastOutput !== undefined
      ? stripAnsi(a.lastOutput).split('\n').slice(-3).filter(l => l.trim()).join('\n')
      : (a.lastLines || '');
    const st = agentState.get(a.id);
    return {
      id: a.id,
      name: a.name,
      screen: a.screen || '',
      clientId: (a.attrs || {}).clientId || null,
      connectedAt: a.connectedAt,
      needsInput: a.needsInput,
      status: st ? st.lastStatus : 'UNKNOWN',
      claude: st && st.claude ? st.claude : null,
      lastLines: last3.substring(0, 500)
    };
  }

  function buildSummary() {
    const agents = getAgents();
    if (agents.length === 0) return { message: 'No agents connected', agents: [], clients: [] };

    const byClient = new Map();
    for (const a of agents) {
      const cid = (a.attrs || {}).clientId || 'unknown';
      if (!byClient.has(cid)) byClient.set(cid, { clientId: cid, count: 0, agents: [] });
      const c = byClient.get(cid);
      c.count += 1;
      c.agents.push(summarizeAgent(a));
    }
    const summaries = agents.map(summarizeAgent);
    const clients = Array.from(byClient.values()).map(c => ({
      ...c,
      reportedNodeCount: clientNodeCounts.get(c.clientId) || null
    }));

    const lines = summaries.map(s => {
      const c = s.claude;
      const cstr = c && c.running
        ? `claude:${c.kind}${c.prompt ? ' "' + stripAnsi(c.prompt).substring(0, 60) + '"' : ''}`
        : 'no-claude';
      return `  [${s.status}] ${s.name} (${s.screen}) — ${cstr}`;
    });
    const message = `${summaries.length} agent(s) across ${clients.length} client(s):\n${lines.join('\n')}`;
    return { message, agents: summaries, clients };
  }

  // ============ Notification ============

  function notify(type, data) {
    const payload = { type, time: new Date().toISOString(), ...data };

    if (type === 'summary') {
      console.log(`[SUPERVISOR] Summary — ${data.message.split('\n')[0]} (${data.agents ? data.agents.length : 0} agents)`);
    } else if (type === 'idle_alert') {
      console.log(`[SUPERVISOR] IDLE ALERT — ${data.message}`);
    } else if (type === 'llm_summary') {
      console.log(`[SUPERVISOR] analyzer summary cycle ${data.cycle} (${data.summary ? data.summary.length : 0} chars)`);
    } else if (type === 'analyzer_missing' || type === 'analyzer_timeout') {
      console.log(`[SUPERVISOR] ${type}: ${data.message}`);
    } else if (type === 'agent_connected' || type === 'agent_disconnected') {
      console.log(`[SUPERVISOR] ${type}: ${data.agent.name}`);
    }

    if (broadcastToBrowsers) broadcastToBrowsers({ type: 'supervisor_event', event: payload });
    if (webhook) sendWebhook(payload);
  }

  function sendWebhook(payload) {
    try {
      const data = JSON.stringify(payload);
      const url = new URL(webhook);
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
      }, () => {});
      req.on('error', e => console.log(`[SUPERVISOR] Webhook error: ${e.message}`));
      req.write(data);
      req.end();
    } catch (e) { /* swallow */ }
  }

  // ============ Periodic: idle + node counts ============

  function checkIdle() {
    const agents = getAgents();
    for (const a of agents) {
      const st = agentState.get(a.id);
      if (!st) continue;
      if (st.lastStatus === 'WAITING' && (Date.now() - st.lastChange) > idleTimeout) {
        const minutes = Math.round((Date.now() - st.lastChange) / 60000);
        notify('idle_alert', { message: `${a.name} (${a.screen}) waiting for input ${minutes}min`, agent: summarizeAgent(a) });
        st.lastChange = Date.now();
      }
    }
    const activeIds = new Set(agents.map(a => a.id));
    for (const id of agentState.keys()) {
      if (!activeIds.has(id)) agentState.delete(id);
    }
    // clientNodeCounts is keyed by clientId, not agentId, and nothing else ever
    // prunes it — without this a client whose every agent has disconnected
    // (e.g. a temporary spawn_node machine) leaks one Map entry forever.
    const activeClientIds = new Set(agents.map(a => (a.attrs || {}).clientId).filter(Boolean));
    for (const cid of clientNodeCounts.keys()) {
      if (!activeClientIds.has(cid)) clientNodeCounts.delete(cid);
    }
  }

  function refreshScreenCounts() {
    const agents = getAgents();
    const seenClients = new Set();
    for (const a of agents) {
      const cid = (a.attrs || {}).clientId;
      if (!cid || seenClients.has(cid)) continue;
      seenClients.add(cid);
      updateClientCount(a);
    }
  }

  // ============ Analyzer agent ============

  let analyzerAgentId = null;
  let analyzerPhase = 'idle';      // 'idle' | 'reading'
  let analyzerCycle = 0;
  let analyzerWatcher = null;
  let analyzerCycleStart = 0;

  function resolveAnalyzer() {
    if (!analyzerName) return null;
    const agents = getAgents();
    const found = agents.find(a => a.name === analyzerName || (a.name && a.name.includes(analyzerName)));
    analyzerAgentId = found ? found.id : null;
    return analyzerAgentId;
  }

  function buildSnapshot() {
    const agents = getAgents();
    const claude = agents.filter(a => a.claudeState && a.claudeState.running);
    const nonClaude = agents.filter(a => !(a.claudeState && a.claudeState.running)).map(a => a.name);
    return {
      claude: claude.map(a => ({
        name: a.name,
        screen: a.screen,
        kind: a.claudeState.kind,
        prompt: a.claudeState.prompt,
        options: a.claudeState.options,
        lastLine: (a.lastLines || '').split('\n').pop().substring(0, 200)
      })),
      nonClaude
    };
  }

  function buildAnalyzerPrompt(snap, n) {
    const snapJson = JSON.stringify(snap, null, 2);
    return `第 ${n} 次集群巡检。当前各节点状态：\n${snapJson}\n\n你是只读督工分析员。规则：\n1. 绝不调用会修改文件/系统/网络的工具（即使你想调用，我也会一律拒绝）。\n2. 用 3-5 句话总结整体进展。\n3. 对每个等待输入的节点给出**只读**的下一步建议。\n4. 最终结论放在 <SUMMARY cycle="${n}"> 和 </SUMMARY> 之间，内容为：摘要 + 换行后的"建议："列表（每条一行：节点名: 只读命令 (理由)）。`;
  }

  function runAnalyzerCycle() {
    if (!analyzerName) return;
    const aid = resolveAnalyzer();
    if (!aid) {
      notify('analyzer_missing', { message: `analyzer 节点 "${analyzerName}" 未连接` });
      return;
    }
    // Don't stack a new cycle if the previous one is still reading
    if (analyzerPhase === 'reading') {
      console.log(`[SUPERVISOR] analyzer still reading previous cycle — skipping`);
      return;
    }

    analyzerCycle++;
    analyzerCycleStart = Date.now();
    analyzerPhase = 'reading';

    const snap = buildSnapshot();
    const prompt = buildAnalyzerPrompt(snap, analyzerCycle);
    sendToAgent(aid, prompt + '\r');
    console.log(`[SUPERVISOR] analyzer cycle ${analyzerCycle}: sent snapshot (${snap.claude.length} claude agents) → ${aid}`);

    if (analyzerWatcher) clearInterval(analyzerWatcher);
    analyzerWatcher = setInterval(analyzerWatch, 3000);
    analyzerWatch();
  }

  function analyzerWatch() {
    if (analyzerPhase !== 'reading') return;
    const aid = analyzerAgentId;
    if (!aid) { stopAnalyzerWatch(); return; }
    const agents = getAgents();
    const a = agents.find(x => x.id === aid);
    if (!a) {
      console.log(`[SUPERVISOR] analyzer disconnected mid-cycle — aborting cycle ${analyzerCycle}`);
      notify('analyzer_timeout', { message: `analyzer 第 ${analyzerCycle} 轮中断(节点掉线)`, cycle: analyzerCycle });
      stopAnalyzerWatch();
      return;
    }

    // Safety net: deny any tool-permission prompt the analyzer raises so it can
    // never execute anything. (Its own prompt also forbids tools.)
    const cs = a.claudeState;
    if (cs && cs.running && cs.kind === 'bash') {
      sendToAgent(aid, 'n\r');
    }

    // Extract the SUMMARY marker from the analyzer's raw terminal output
    const raw = getAgentRawOutput ? getAgentRawOutput(aid) : '';
    const stripped = stripAnsi(raw);
    const re = new RegExp('<SUMMARY cycle="' + analyzerCycle + '">([\\s\\S]*?)</SUMMARY>');
    const m = stripped.match(re);
    if (m) {
      const summary = m[1].trim();
      notify('llm_summary', { summary, suggestions: [], cycle: analyzerCycle });
      stopAnalyzerWatch();
      return;
    }

    if (Date.now() - analyzerCycleStart > analyzerTimeout) {
      notify('analyzer_timeout', { message: `analyzer 第 ${analyzerCycle} 轮超时 (${analyzerTimeout / 1000}s)`, cycle: analyzerCycle });
      stopAnalyzerWatch();
    }
  }

  function stopAnalyzerWatch() {
    analyzerPhase = 'idle';
    if (analyzerWatcher) { clearInterval(analyzerWatcher); analyzerWatcher = null; }
  }

  // ============ Lifecycle ============

  function start() {
    console.log(`[SUPERVISOR] Started (summary ${summaryInterval / 1000}s, idle ${idleTimeout / 1000}s${webhook ? ', webhook' : ''}${analyzerName ? ', analyzer=' + analyzerName + ' every ' + (analyzerInterval / 1000) + 's' : ''})`);
    summaryTimer = setInterval(() => notify('summary', buildSummary()), summaryInterval);
    idleTimer = setInterval(checkIdle, 60000);
    screenQueryTimer = setInterval(refreshScreenCounts, 30000);
    if (analyzerName) {
      analyzerTimer = setInterval(runAnalyzerCycle, analyzerInterval);
      // First cycle after a short grace period so agents register their claude_state
      setTimeout(runAnalyzerCycle, 15000);
    }
  }

  function stop() {
    if (summaryTimer) clearInterval(summaryTimer);
    if (idleTimer) clearInterval(idleTimer);
    if (screenQueryTimer) clearInterval(screenQueryTimer);
    if (analyzerTimer) clearInterval(analyzerTimer);
    stopAnalyzerWatch();
    summaryTimer = null; idleTimer = null; screenQueryTimer = null; analyzerTimer = null;
    console.log('[SUPERVISOR] Stopped');
  }

  return {
    start, stop,
    onAgentConnected, onAgentDisconnected,
    onClaudeState,
    buildSummary,
    runAnalyzerCycleNow: runAnalyzerCycle
  };
}

module.exports = { createSupervisor };
