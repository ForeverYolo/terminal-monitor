/**
 * Supervisor module — monitors agents, reports progress, detects idle/alerts
 * Enabled via config.server.supervisor.enabled (default: false)
 */

const http = require('http');
const https = require('https');

function createSupervisor(cfg, deps) {
  const { getAgents, sendToAgent } = deps;
  const summaryInterval = (cfg.summaryInterval || 300) * 1000;
  const idleTimeout = (cfg.idleTimeout || 600) * 1000;
  const webhook = cfg.webhook || '';

  let summaryTimer = null;
  let idleTimer = null;

  // Track last activity time per agent
  const agentActivity = new Map(); // agentId -> { lastChange: timestamp, lastStatus: 'RUNNING'|'WAITING' }

  function getAgentStatus(a) {
    // Reuse hasPrompt logic: agentInfo has lastOutput
    const lines = (a.lastOutput || '').split('\n');
    const last3 = lines.slice(-3).filter(l => l.trim()).join('\n');
    return {
      id: a.id,
      name: a.name,
      screen: a.screen || '',
      status: a.needsInput ? 'WAITING' : 'RUNNING',
      lastLines: last3.substring(0, 500),
      connectedAt: a.connectedAt
    };
  }

  function buildSummary() {
    const agents = getAgents();
    if (agents.length === 0) return { message: 'No agents connected', agents: [] };

    const summaries = agents.map(getAgentStatus);
    const lines = summaries.map(s =>
      `  [${s.status}] ${s.name} (${s.screen}) — ${s.lastLines.split('\n').pop() || '(no output)'}`
    );
    const message = `${summaries.length} agent(s):\n${lines.join('\n')}`;
    return { message, agents: summaries };
  }

  function notify(type, data) {
    const payload = {
      type,
      time: new Date().toISOString(),
      ...data
    };

    // Console
    if (type === 'summary') {
      console.log(`[SUPERVISOR] Periodic summary — ${data.message}`);
    } else if (type === 'idle_alert') {
      console.log(`[SUPERVISOR] IDLE ALERT — ${data.message}`);
    } else if (type === 'agent_connected') {
      console.log(`[SUPERVISOR] Agent connected: ${data.agent.name} (${data.agent.screen})`);
    } else if (type === 'agent_disconnected') {
      console.log(`[SUPERVISOR] Agent disconnected: ${data.agent.name} (${data.agent.screen})`);
    }

    // Webhook
    if (webhook) {
      sendWebhook(payload);
    }
  }

  function sendWebhook(payload) {
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
  }

  function checkIdle() {
    const agents = getAgents();
    for (const a of agents) {
      const status = a.needsInput ? 'WAITING' : 'RUNNING';
      const prev = agentActivity.get(a.id);

      if (!prev) {
        agentActivity.set(a.id, { lastChange: Date.now(), lastStatus: status });
        continue;
      }

      // Status changed → reset timer
      if (prev.lastStatus !== status) {
        prev.lastChange = Date.now();
        prev.lastStatus = status;
      }

      // Check idle
      if (status === 'WAITING' && (Date.now() - prev.lastChange) > idleTimeout) {
        const minutes = Math.round((Date.now() - prev.lastChange) / 60000);
        notify('idle_alert', {
          message: `${a.name} (${a.screen}) idle for ${minutes}min`,
          agent: getAgentStatus(a)
        });
        // Reset so we don't spam
        prev.lastChange = Date.now();
      }
    }

    // Clean up disconnected agents
    const activeIds = new Set(agents.map(a => a.id));
    for (const id of agentActivity.keys()) {
      if (!activeIds.has(id)) agentActivity.delete(id);
    }
  }

  function onAgentConnected(agentInfo) {
    agentActivity.set(agentInfo.id, { lastChange: Date.now(), lastStatus: 'RUNNING' });
    notify('agent_connected', { agent: getAgentStatus(agentInfo) });
  }

  function onAgentDisconnected(agentInfo) {
    agentActivity.delete(agentInfo.id);
    notify('agent_disconnected', { agent: { name: agentInfo.name, screen: agentInfo.screen } });
  }

  function start() {
    console.log(`[SUPERVISOR] Started (summary: ${summaryInterval / 1000}s, idle timeout: ${idleTimeout / 1000}s${webhook ? ', webhook: ' + webhook : ''})`);
    // Periodic summary
    summaryTimer = setInterval(() => {
      const { message, agents } = buildSummary();
      notify('summary', { message, agents });
    }, summaryInterval);
    // Idle detection
    idleTimer = setInterval(checkIdle, 60000);
  }

  function stop() {
    if (summaryTimer) clearInterval(summaryTimer);
    if (idleTimer) clearInterval(idleTimer);
    summaryTimer = null;
    idleTimer = null;
    console.log('[SUPERVISOR] Stopped');
  }

  return { start, stop, onAgentConnected, onAgentDisconnected };
}

module.exports = { createSupervisor };
