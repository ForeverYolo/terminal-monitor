'use strict';

const pendingUpdateReqs = new Map();
const pendingPullReqs = new Map();
const pendingRestartClients = new Set();

// --- Copy SSH / SCP command for an agent ---
function copySshCmd(agentId) {
  const a = lastAgents.find(x => x.id === agentId);
  if (!a || !a.sys) { flashToast('无系统信息', 'error'); return; }
  const ip = a.sys.ips && a.sys.ips[0] ? a.sys.ips[0].addr : '';
  const user = a.sys.username || 'zzb';
  if (!ip) { flashToast('无 IP 信息', 'error'); return; }
  const cmd = `ssh ${user}@${ip}`;
  const done = () => flashToast('已复制: ' + cmd);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(cmd).then(done).catch(() => fallbackCopy(cmd, done));
  } else {
    fallbackCopy(cmd, done);
  }
}

function fallbackCopy(text, cb) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy');
    ta.remove();
    cb && cb();
  } catch { flashToast('复制失败', 'error'); }
}

// --- Restart screen session on an agent (kills PTY → client re-attaches) ---
function restartScreen(agentId) {
  if (!agentId || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'restart_screen', agentId }));
  // Visual hint on the triggering panel button (if multi-view)
  const btns = document.querySelectorAll('.term-actions .restart-btn[data-agent="' + agentId + '"]');
  btns.forEach(b => { b.classList.add('restarting'); setTimeout(() => b.classList.remove('restarting'), 4000); });
  flashToast('已请求重新 attach screen');
}

// ========== Mode Switch ==========

document.querySelectorAll('#view-mode-switch button').forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode;
    setMode(mode);
  });
});

function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll('#view-mode-switch button').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  const multiBar = document.getElementById('dash-multi-bar');
  const mgmtPanel = document.getElementById('mgmt-panel');
  const agentList = document.getElementById('agent-list');
  if (mode === 'multi') {
    selectedAgents.clear();
    multiBar.style.display = 'flex';
  } else {
    multiBar.style.display = 'none';
  }
  if (mode === 'mgmt') {
    agentList.style.display = 'none';
    mgmtPanel.style.display = 'flex';
    renderMgmtPanel();
  } else {
    agentList.style.display = 'flex';
    mgmtPanel.style.display = 'none';
  }
  renderAgents(lastAgents);
}

// ========== Management Panel ==========

let lastSupervisorEvent = null;     // most recent supervisor_event payload
let lastSpawnResults = [];          // recent spawn_node_result messages
let supervisorConfig = null;        // current config.server.supervisor, from auth_ok / supervisor_config

function renderMgmtPanel() {
  renderMgmtClients();
  renderMgmtSummary();
  renderSupervisorSettings();
}

// --- Supervisor settings form ---
// Analyzer dropdown lists every agent name currently known, plus the
// configured value even if that agent isn't connected right now (e.g. editing
// settings before starting the analyzer node).
function buildAnalyzerOptions(selectedValue) {
  const names = new Set(lastAgents.map(a => a.name));
  if (selectedValue) names.add(selectedValue);
  return '<option value="">（不使用分析员）</option>' +
    Array.from(names).sort().map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
}

function renderSupervisorSettings() {
  const cfg = supervisorConfig || {};
  const enabledEl = document.getElementById('sup-enabled');
  const analyzerEl = document.getElementById('sup-analyzer');
  if (!enabledEl || !analyzerEl) return;   // panel not in DOM yet

  enabledEl.checked = !!cfg.enabled;
  document.getElementById('sup-summaryInterval').value = cfg.summaryInterval || 60;
  document.getElementById('sup-idleTimeout').value = cfg.idleTimeout || 600;
  document.getElementById('sup-analyzerInterval').value = cfg.analyzerInterval || 300;
  document.getElementById('sup-analyzerTimeout').value = cfg.analyzerTimeout || 120;
  document.getElementById('sup-webhook').value = cfg.webhook || '';

  const current = cfg.analyzerAgentName || '';
  analyzerEl.innerHTML = buildAnalyzerOptions(current);
  analyzerEl.value = current;
}

// Refresh just the dropdown's option list (agents connecting/disconnecting) —
// called from the periodic 10s agents broadcast, where re-running the full
// renderSupervisorSettings() would stomp on an in-progress, unsaved edit of
// the rest of the form every 10 seconds.
function refreshAnalyzerOptions() {
  const analyzerEl = document.getElementById('sup-analyzer');
  if (!analyzerEl) return;
  const selected = analyzerEl.value;
  analyzerEl.innerHTML = buildAnalyzerOptions(selected);
  analyzerEl.value = selected;
}

function saveSupervisorConfig() {
  const val = (id) => document.getElementById(id).value;
  const payload = {
    type: 'update_supervisor_config',
    enabled: document.getElementById('sup-enabled').checked,
    analyzerAgentName: val('sup-analyzer'),
    summaryInterval: Number(val('sup-summaryInterval')),
    idleTimeout: Number(val('sup-idleTimeout')),
    analyzerInterval: Number(val('sup-analyzerInterval')),
    analyzerTimeout: Number(val('sup-analyzerTimeout')),
    webhook: val('sup-webhook').trim()
  };
  const statusEl = document.getElementById('sup-save-status');
  if (statusEl) statusEl.textContent = '保存中…';
  ws.send(JSON.stringify(payload));
}

function renderMgmtSummary() {
  const txt = document.getElementById('mgmt-summary-text');
  const timeEl = document.getElementById('mgmt-summary-time');
  const suggEl = document.getElementById('mgmt-suggestions');
  if (!lastSupervisorEvent) {
    txt.textContent = '（等待督工事件…）';
    timeEl.textContent = '';
    suggEl.innerHTML = '';
    return;
  }
  const ev = lastSupervisorEvent.event || lastSupervisorEvent;
  if (ev.type === 'llm_summary') {
    txt.textContent = ev.summary || '(no summary)';
    timeEl.textContent = ' · LLM · ' + new Date(lastSupervisorEvent.time || Date.now()).toLocaleTimeString();
    if (ev.suggestions && ev.suggestions.length) {
      suggEl.innerHTML = '<div style="color:#8b949e; font-size:12px; margin-bottom:4px;">建议（只读，需手动确认）：</div>' +
        ev.suggestions.map(s => `
          <div style="display:flex; gap:6px; align-items:center; padding:6px; background:#161b22; border-radius:4px; margin-bottom:4px;">
            <span style="color:#c9d1d9; font-size:12px; flex:1;"><b>${escapeHtml(s.agentName||s.agentId||'')}</b>: <code>${escapeHtml(s.action||'')}</code> <span style="color:#6e7681;">(${escapeHtml(s.reason||'')})</span></span>
            <button onclick="applySuggestion('${(s.agentId||'').replace(/'/g,"\\'")}', '${escapeHtml((s.action||'').replace(/'/g,"\\'"))}')" style="background:#238636; color:#fff; border:none; padding:4px 8px; border-radius:3px; cursor:pointer; font-size:11px;">注入</button>
          </div>`).join('');
    } else {
      suggEl.innerHTML = '';
    }
  } else if (ev.type === 'summary') {
    txt.textContent = ev.message || '(no message)';
    timeEl.textContent = ' · ' + new Date(lastSupervisorEvent.time || Date.now()).toLocaleTimeString();
    suggEl.innerHTML = '';
  } else {
    txt.textContent = JSON.stringify(ev, null, 2);
    timeEl.textContent = ' · ' + ev.type;
    suggEl.innerHTML = '';
  }
}

function renderMgmtClients() {
  const c = document.getElementById('mgmt-clients');
  if (!lastAgents || lastAgents.length === 0) {
    c.innerHTML = '<div style="color:#6e7681;">No agents online</div>';
    return;
  }
  // Group by clientId
  const byClient = new Map();
  for (const a of lastAgents) {
    const cid = (a.attrs && a.attrs.clientId) || a.clientId || 'unknown';
    if (!byClient.has(cid)) byClient.set(cid, []);
    byClient.get(cid).push(a);
  }
  // This list re-renders on every agents broadcast (~10s) while innerHTML
  // rebuilds wipe typed text. Snapshot the in-progress inputs and select so
  // the user doesn't lose a half-typed screen name mid-broadcast.
  const saved = {};
  for (const cid of byClient.keys()) {
    const name = document.getElementById('spawn-name-' + cid);
    const disp = document.getElementById('spawn-display-' + cid);
    const cmd = document.getElementById('spawn-cmd-' + cid);
    saved[cid] = { name: name ? name.value : '', disp: disp ? disp.value : '', cmd: cmd ? cmd.value : 'bash' };
  }
  c.innerHTML = Array.from(byClient.entries()).map(([cid, agents]) => {
    const nodeCount = agents[0] && agents[0].reportedNodeCount;
    const overLimit = agents.length >= 20;
    const badge = versionBadge(agents[0]);
    // ⏳ 待应用 → offer a one-click restart of the monitoring process (the only
    // fix for disk-new/process-old, since a push has no diff to send).
    if (/待应用/.test(badge)) pendingRestartClients.add(cid); else pendingRestartClients.delete(cid);
    const sv = saved[cid] || { name: '', disp: '', cmd: 'bash' };
    return `<div class="mgmt-client">
      <h4>Client: ${escapeHtml(cid)} · ${agents.length} agent(s)${nodeCount != null ? ' / ' + nodeCount + ' screen(s)' : ''} ${badge}</h4>
      <div class="add-node-row">
        <input type="text" id="spawn-name-${escapeHtml(cid)}" placeholder="screen 名" maxlength="40" style="width:110px;" value="${escapeHtml(sv.name)}">
        <input type="text" id="spawn-display-${escapeHtml(cid)}" placeholder="显示名(默认 机器名-screen名)" maxlength="60" style="width:190px;" value="${escapeHtml(sv.disp)}">
        <select id="spawn-cmd-${escapeHtml(cid)}">
          <option value="bash"${sv.cmd === 'bash' ? ' selected' : ''}>bash</option>
          <option value="claude"${sv.cmd === 'claude' ? ' selected' : ''}>claude</option>
          <option value="sh"${sv.cmd === 'sh' ? ' selected' : ''}>sh</option>
        </select>
        <button onclick="spawnNodeOnClient('${escapeHtml(cid)}')" ${overLimit?'disabled':''}>
          ${overLimit ? '已达 20 上限' : '+ 新增节点'}
        </button>
        <button onclick="pushUpdateToClient('${escapeHtml(cid)}')" title="把服务器上的全部托管文件（客户端+服务端+页面）推送到这台机器；监控进程相关的文件有变化时自动重启">
          ⬆ 推送更新
        </button>
        <button onclick="pullUpdateFromClient('${escapeHtml(cid)}', '${escapeHtml(agents[0] ? agents[0].name : cid)}')" style="background:#3a6e2a; color:#fff; border:none; padding:6px 12px; border-radius:4px; cursor:pointer; font-size:12px;" title="把这台机器当作版本源：服务器从它拉取全部托管文件并覆盖自己的副本（覆盖前自动备份）">
          ⬇ 从此机拉取
        </button>${pendingRestartClients.has(cid) ? `<button onclick="restartNodeOnClient('${escapeHtml(cid)}')" style="background:#f0883e; color:#fff; border:none; padding:6px 12px; border-radius:4px; cursor:pointer; font-size:12px;" title="磁盘文件已最新但进程还是旧版：重启监控进程使新代码生效（不影响任务终端）">
          ⟳ 重启监控进程
        </button>` : ''}
      </div>
      <div class="mgmt-agent-list">
        ${agents.map(a => {
          const cs = a.claudeState;
          const csStr = (cs && cs.running) ? ` · claude:${cs.kind}${cs.prompt ? ' "' + escapeHtml(cs.prompt.substring(0,40)) + '"' : ''}` : '';
          const rowClass = `mgmt-agent-row${attentionAgents.has(a.id) ? ' attention' : ''}`;
          const safeName = a.name.replace(/'/g, "\\'");
          return `<div class="${rowClass}">
            <span class="name">${escapeHtml(a.name)}</span>
            <span class="screen">[${escapeHtml(a.screen||'')}]</span>
            <span class="state">${a.needsInput ? '⏳等待' : '▶运行'}${csStr}</span>
            <button class="kill-btn" onclick="killNode('${a.id}','${safeName}',false)" title="断开监控，保留任务 screen">停止监控</button>
            <button class="kill-btn danger" onclick="killNode('${a.id}','${safeName}',true)" title="断开监控并终止任务 screen">终止节点</button>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');
}

function spawnNodeOnClient(clientId) {
  const nameInput = document.getElementById('spawn-name-' + clientId);
  const displayInput = document.getElementById('spawn-display-' + clientId);
  const cmdSelect = document.getElementById('spawn-cmd-' + clientId);
  if (!nameInput || !cmdSelect) return;
  const screenName = nameInput.value.trim();
  const displayName = displayInput ? displayInput.value.trim() : '';
  const cmd = cmdSelect.value;
  if (!screenName) { alert('请输入 screen 名'); return; }
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(screenName)) { alert('screen 名仅允许字母/数字/_/-，最长40'); return; }
  const reqId = 'spawn-' + Date.now().toString(36);
  pendingSpawnReqs.set(reqId, { clientId, screenName, cmd, ts: Date.now() });
  const body = {
    type: 'spawn_node',
    reqId,
    target: { clientId },
    screenName,
    cmd
  };
  // Optional display name; empty → client.js falls back to
  // `${parentName}-${screenName}` (e.g. "2080-server-monitor-3").
  if (displayName) body.nodeName = displayName;
  ws.send(JSON.stringify(body));
  showFloatingNotice(`已请求在 ${clientId} 上新增节点 ${displayName || screenName}`);
}

const pendingSpawnReqs = new Map();

// --- Push-update UI ---

// Five-state version badge for one agent. Inputs:
//   S = lastServerFiles (server manifest)   A = agent.fileHashes (fresh disk
//   hashes via register + periodic query_files)   R = agent.runningHashes
//   (register-time snapshot = running version)   rPrev = previous register's
//   R.client.js for this clientId (server-tracked)
// States:
//   green   ✓ 最新     S==A==R for client files, no server-side drift
//   orange  ⏳ 待应用  A==S but R≠A: disk synced, old process still running.
//                  push_update canNOT fix this (no diff to send); needs the
//                  monitoring process restarted (restart.sh / next push)
//   yellow  ⬆ 待更新  A==R≠S (or ambiguous): server has a newer version the
//                  agent hasn't received — push_update fixes it
//   blue    ⬇ 待拉取  this machine's disk has unpublished changes: server-side
//                  file drift, or client-file edit on disk (A≠R with R==S), or
//                  agent restarted onto local code (A==R≠S with rPrev==S)
//   grey    ? 版本未知  old client without hashes
const CLIENT_FILES_UI = ManagedFiles.CLIENT_FILES;
const ALL_MANAGED_UI = ManagedFiles.SERVER_FILES;
function versionBadge(agent) {
  if (!lastServerFiles || !agent || !agent.fileHashes || !agent.runningHashes) {
    return '<span style="color:#8b949e;font-size:12px;">? 版本未知</span>';
  }
  const A = agent.fileHashes, R = agent.runningHashes, S = lastServerFiles;
  // Per-file three-way compare over ALL managed files. Server-side files
  // (server.js, public/*) don't run on the agent, but R still records the
  // disk state at client startup. That lets us distinguish a local edit made
  // after startup (待拉取) from a server update that arrived later (待更新).
  let yellow = false, orange = false, blue = false;
  for (const name of ALL_MANAGED_UI) {
    if (!S[name]) continue; // missing server copy — skip
    const a = A[name];
    if (a === S[name]) {
      // Disk current. Only running-state matters, and only for client files.
      if (!CLIENT_FILES_UI.includes(name)) continue;
      if (!(name in R)) return '<span style="color:#8b949e;font-size:12px;">? 版本未知</span>';
      if (R[name] !== a) {
        // Disk new, process old → push is a no-op, needs 应用 (restart).
        orange = true;
      }
    } else if (a === undefined) {
      // A missing client runtime file needs an update; optional server-side
      // copies on agents can still be absent without blocking the badge.
      if (CLIENT_FILES_UI.includes(name)) yellow = true;
      continue;
    } else {
      // Disk differs from server. For files that this process does not run,
      // the startup snapshot is still useful: R==S means this machine edited
      // its copy after connecting, while R!=S means it was already behind the
      // server when it connected.
      if (!CLIENT_FILES_UI.includes(name)) {
        if ((name in R) && R[name] === S[name] && a !== R[name]) blue = true;
        else yellow = true;
        continue;
      }
      if (!(name in R)) return '<span style="color:#8b949e;font-size:12px;">? 版本未知</span>';
      const r = R[name];
      if (r === S[name]) {
        // Process runs the server version, disk was edited locally
        // (published or not) → this machine is the source: pull from it.
        blue = true;
      } else if (a === r) {
        // Process runs the edited disk → agent restarted onto local code.
        // If it PREVIOUSLY ran the server version, someone is developing
        // here → 待拉取; otherwise (rPrev differs) the server just has a
        // newer published version → 待更新.
        if (name === 'client.js' && agent.rPrev && agent.rPrev === S[name]) blue = true;
        else yellow = true;
      } else {
        yellow = true; // three-way mismatch: ambiguous → conservative push
      }
    }
  }
  if (blue) return '<span style="color:#58a6ff;font-size:12px;">⬇ 待拉取</span>';
  if (orange) return '<span style="color:#f0883e;font-size:12px;">⏳ 待应用</span>';
  if (yellow) return '<span style="color:#d29922;font-size:12px;">⬆ 待更新</span>';
  return '<span style="color:#3fb950;font-size:12px;">✓ 最新</span>';
}

function sendPush(reqId, body, clientId) {
  const timer = setTimeout(() => {
    pendingUpdateReqs.delete(reqId);
    showFloatingNotice(`⏱ ${clientId} 更新无响应（可能正在重启，等待其重连）`);
  }, 30000);
  pendingUpdateReqs.set(reqId, { clientId, timer });
  ws.send(JSON.stringify(body));
}

function pushUpdateToClient(clientId) {
  const reqId = 'push-' + Date.now().toString(36);
  sendPush(reqId, { type: 'push_update', reqId, clientId }, clientId);
  showFloatingNotice(`已请求推送更新到 ${clientId}`);
}

// ⏳ 待应用 fix: disk files are current but the running process predates them.
// The agent relaunches its own service screen — task screens are untouched.
function restartNodeOnClient(clientId) {
  if (!confirm(`重启 ${clientId} 的监控进程，使磁盘上的新代码生效？\n\n只重启监控进程（swt-client screen），不会影响任何任务终端。`)) return;
  const reqId = 'rnode-' + Date.now().toString(36);
  sendPush(reqId, { type: 'restart_node', reqId, clientId }, clientId);
  showFloatingNotice(`已请求重启 ${clientId} 的监控进程，等待其重连…`);
}

// Treat this machine as the version source: server fetches its managed files
// from the agent, overwrites its own copies (after backing up), then a server
// restart + push_update_all distributes the new version everywhere.
function pullUpdateFromClient(clientId, agentName) {
  const reqId = 'pull-' + Date.now().toString(36);
  if (!confirm(`把 "${agentName || clientId}" 设为版本源？\n\n服务器将从这台机器拉取全部托管文件（client.js、server.js、前端页面等），并覆盖服务器磁盘上的副本（覆盖前自动备份）。\n\n之后需要重启服务器 + 全部推送更新，其他机器才会拿到新版本。`)) return;
  const timer = setTimeout(() => {
    pendingPullReqs.delete(reqId);
    showFloatingNotice(`⏱ ${clientId} 拉取无响应（agent 可能掉线）`);
  }, 30000);
  pendingPullReqs.set(reqId, { timer });
  ws.send(JSON.stringify({ type: 'pull_update', reqId, clientId }));
  showFloatingNotice(`正在从 ${agentName || clientId} 拉取更新…`);
}

function pushUpdateAll() {
  if (!confirm('向所有在线机器推送全部托管文件（客户端+服务端+页面）？\n\n监控进程相关文件有变化的机器会自动重启；旧版 server.js/index.html 残骸也会被对齐。')) return;
  const reqId = 'push-all-' + Date.now().toString(36);
  const clientIds = new Set();
  for (const a of lastAgents) {
    const cid = (a.attrs && a.attrs.clientId) || a.clientId;
    if (cid) clientIds.add(cid);
  }
  for (const cid of clientIds) {
    sendPush(reqId + '-' + cid, { type: 'push_update', reqId: reqId + '-' + cid, clientId: cid }, cid);
  }
  showFloatingNotice(`已请求推送更新到 ${clientIds.size} 台机器`);
}

function restartServer() {
  if (!confirm('确认重启服务器以应用磁盘上的更新文件？\n\n所有连接会断开几秒后自动恢复。')) return;
  ws.send(JSON.stringify({ type: 'restart_server', reqId: 'rst-' + Date.now().toString(36) }));
}

// Stop a node's monitoring agent, optionally also killing the task screen it
// was attached to. killTask=false leaves the underlying screen session (and
// whatever's running inside it) completely untouched — only the SWT agent
// disconnects; killTask=true tears both down.
function killNode(agentId, agentName, killTask) {
  const msg = killTask
    ? `确定要终止节点 "${agentName}" 吗？\n\n这会同时结束它监控的 screen 任务会话，任务本身也会被杀掉，无法撤销。`
    : `确定要停止监控 "${agentName}" 吗？\n\n只会断开 SWT 的监控 agent，它底下的 screen 任务会话不受影响，仍会继续运行。`;
  if (!confirm(msg)) return;
  const reqId = 'kill-' + Date.now().toString(36);
  ws.send(JSON.stringify({ type: 'kill_node', reqId, agentId, mode: killTask ? 'agent_and_task' : 'agent_only' }));
  showFloatingNotice(`已请求${killTask ? '终止' : '停止监控'} ${agentName}`);
}

function applySuggestion(agentId, action) {
  if (!agentId || !action) return;
  if (!confirm(`将注入只读命令到 ${agentId}:\n\n${action}\n\n确认？`)) return;
  // Use existing /api/action endpoint via fetch
  fetch('/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, input: action + '\n' })
  }).then(r => r.json()).then(r => {
    if (r.ok) showFloatingNotice('已注入: ' + action);
    else alert('注入失败: ' + (r.error || 'unknown'));
  }).catch(e => alert('注入错误: ' + e.message));
}

function requestLlmSummary() {
  // Manually trigger via supervisor HTTP endpoint - we just refresh view;
  // server's supervisor will emit a supervisor_event on its next interval.
  fetch('/api/supervisor').then(r => r.json()).then(s => {
    if (s && s.message) {
      lastSupervisorEvent = { event: { type: 'summary', message: s.message }, time: new Date().toISOString() };
      renderMgmtSummary();
      showFloatingNotice('已刷新督工摘要');
    }
  }).catch(e => alert('刷新失败: ' + e.message));
}

function showFloatingNotice(text) {
  const el = document.getElementById('float-notice') || (() => {
    const d = document.createElement('div');
    d.id = 'float-notice';
    d.style.cssText = 'position:fixed; bottom:20px; right:20px; background:rgba(40,80,40,0.95); color:#fff; padding:10px 16px; border-radius:6px; z-index:300; font-size:12px; max-width:300px;';
    document.body.appendChild(d);
    return d;
  })();
  el.textContent = text;
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = 'none'; }, 3000);
}

function clearManagementRequests() {
  for (const pending of [...pendingUpdateReqs.values(), ...pendingPullReqs.values()]) clearTimeout(pending.timer);
  pendingUpdateReqs.clear(); pendingPullReqs.clear(); pendingSpawnReqs.clear();
}
