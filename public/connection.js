'use strict';

const views = { login: document.getElementById('login-view'), dash: document.getElementById('dash-view'), term: document.getElementById('term-view'), multi: document.getElementById('multi-view') };
let ws = null, currentAgentId = null, term = null, fitAddon = null;
let wasAuthenticated = false;     // true once auth_ok received — distinguishes "first connect" from "reconnect"
let reconnectTimer = null;        // setTimeout handle for reconnect
let isReconnecting = false;       // true while waiting for auth_ok after a drop
let ctrlActive = false;
let lastAgents = [];
let lastServerFiles = null;

let currentMode = 'card'; // 'card', 'multi'
let currentSort = localStorage.getItem('swt-sort') || 'name'; // 'name', 'id', 'recent'
let selectedAgents = new Set(); // for multi-select mode
let multiTerms = {}; // agentId -> { term, fitAddon, container, filter }
let termFilter = createAltScreenFilter(); // alt-screen filter for the single terminal

// --- Seq tracking + stable terminal identity ---
// Server stamps every data chunk with a per-terminal monotonic seq. We remember
// the last seq seen per agent so a reconnect resume can ask for "everything
// after N" instead of skipping the gap entirely (old resume:true behaviour).
const lastSeqByAgent = new Map();   // agentId -> number
const pendingSizeSnapshot = new Set(); // agentIds waiting for a canonical-size snapshot
const requestedSizeByAgent = new Map(); // this browser's latest viewport size claim
function forgetTerminalState(agentId) {
  lastSeqByAgent.delete(agentId);
  pendingSizeSnapshot.delete(agentId);
  requestedSizeByAgent.delete(agentId);
}
function isSnapshotAgent(id) {
  return (lastAgents || []).some(a => a.id === id && a.snapshotV1);
}
function rememberRequestedSize(id, size) {
  if (isSnapshotAgent(id)) requestedSizeByAgent.set(id, size);
}
function sendViewportResize(id, size) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !id) return;
  if (isSnapshotAgent(id)) {
    const previous = requestedSizeByAgent.get(id);
    if (previous && previous.cols === size.cols && previous.rows === size.rows) return;
    requestedSizeByAgent.set(id, size);
  }
  ws.send(JSON.stringify({ type: 'resize', agentId: id, ...size }));
}
function proposedSize(addon, terminal) {
  const proposed = addon && addon.proposeDimensions();
  return proposed && proposed.cols > 0 && proposed.rows > 0
    ? { cols: proposed.cols, rows: proposed.rows }
    : { cols: terminal.cols, rows: terminal.rows };
}
function multiSizes() {
  const sizes = {};
  for (const [id, entry] of Object.entries(multiTerms)) sizes[id] = proposedSize(entry.fitAddon, entry.term);
  return sizes;
}
// Stable terminal key (clientId|screen) -> agentId, refreshed on every agents
// broadcast. When an agent reconnects it gets a NEW agentId but the same key —
// watching browsers use this to re-subscribe to the new id automatically.
const agentIdByKey = new Map();     // terminalKey -> agentId (live agents only)
let currentTerminalKey = null;      // stable key of the single-terminal view's agent
function terminalKeyOf(a) {
  const cid = (a.attrs && a.attrs.clientId) || a.clientId || 'nokey';
  return `${cid}|${a.screen || ''}`;
}
// Resolve the CURRENT agentId for a previously-known terminal key. Returns null
// when no live agent carries that key (agent fully offline).
function resolveAgentId(stableKey) {
  return agentIdByKey.get(stableKey) || null;
}
function syncAgentIdMap(agents) {
  agentIdByKey.clear();
  for (const a of agents || []) agentIdByKey.set(terminalKeyOf(a), a.id);
}
// data payload for a resumed subscribe: carries per-agent lastSeq positions.
function resumePayloadFor(agentIds) {
  const sinceSeqs = {};
  for (const id of agentIds) sinceSeqs[id] = lastSeqByAgent.get(id) || 0;
  return sinceSeqs;
}
function remapMultiTerms() {
  let changed = false;
  for (const [oldId, entry] of Object.entries(multiTerms)) {
    const fresh = resolveAgentId(entry.terminalKey);
    if (!fresh || fresh === oldId) continue;
    delete multiTerms[oldId];
    forgetTerminalState(oldId);
    entry.agentId = fresh;
    entry.filter = createAltScreenFilter({ nativeTui: isNativeTuiAgent(fresh) });
    multiTerms[fresh] = entry;
    lastSeqByAgent.delete(fresh);
    selectedAgents.delete(oldId);
    selectedAgents.add(fresh);
    changed = true;
  }
  return changed;
}

// Legacy agents still send raw PTY output; modern agents filter before snapshotting.
// xterm answers OSC 10/11/12 colour queries itself.  onData also receives
// those protocol replies, but forwarding a replayed reply into screen makes
// the shell echo strings such as "11;rgb:0f0f/0f0f/2323".  These are never
// user keystrokes, so remove only complete OSC colour-report replies.
function isNativeTuiAgent(id) {
  return (lastAgents || []).some(a => a.id === id && a.nativeTui === true);
}

function updateNativeTuiControls() {
  const button = document.getElementById('btn-scroll-latest');
  const nativeTui = isNativeTuiAgent(currentAgentId) && applicationOwnsScrolling(term);
  button.disabled = nativeTui;
  button.title = nativeTui ? '原生 TUI 请用下翻、滚轮或应用快捷键回到末尾' : '回到最新输出';
}

function applicationOwnsScrolling(target) {
  return !!target && (target.buffer.active.type === 'alternate' || target.modes.mouseTrackingMode !== 'none');
}

function stripTerminalColorReplies(data, nativeTui = false) {
  data = data.replace(/\x1b]1[012];rgb:[0-9a-f]{1,4}\/[0-9a-f]{1,4}\/[0-9a-f]{1,4}(?:\x07|\x1b\\)/gi, '');
  // Belt-and-braces: drop SGR / urxvt mouse-event reports in case tracking
  // ever gets enabled despite the output-side suppression.  A user cannot
  // type these sequences, so removing them never loses real keystrokes.
  if (!nativeTui) data = data.replace(/\x1b\[<?[0-9;]+[Mm]/g, '');
  return data;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showView(name) {
  Object.values(views).forEach(v => v.style.display = 'none');
  if (views[name]) views[name].style.display = 'flex';
}

// ========== Auth ==========

function doLogin() {
  const user = document.getElementById('username-input').value.trim() || 'zzb';
  const pw = document.getElementById('password-input').value;
  if (!pw) return;
  localStorage.setItem('swt-user', user);
  localStorage.setItem('swt-pw', pw);
  connect(user, pw);
}

// Prefill username from saved value
document.getElementById('username-input').value = localStorage.getItem('swt-user') || 'zzb';

document.getElementById('password-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

function connect(username, password) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (ws) ws.close();
  const connection = new WebSocket(`${proto}//${location.host}`);
  ws = connection;

  connection.onopen = () => {
    if (ws !== connection) return;
    ws.send(JSON.stringify({ type: 'auth', password, username }));
  };

  connection.onmessage = (ev) => {
    if (ws !== connection) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    const viewMessages = ['data','terminal_size','terminal_snapshot','terminal_snapshot_error'];
    if (viewMessages.includes(msg.type) && msg.agentId !== currentAgentId && !multiTerms[msg.agentId]) return;

    if (msg.type === 'auth_ok') {
      const wasReconnecting = isReconnecting;
      wasAuthenticated = true;
      isReconnecting = false;
      hideNetworkOverlay();

      lastAgents = msg.agents || [];
      syncAttentionFromAgents(lastAgents);
      syncAgentIdMap(lastAgents);
      supervisorConfig = msg.supervisorConfig || {};
      if (msg.serverFiles) lastServerFiles = msg.serverFiles;

      const inTerm = views.term.style.display !== 'none';
      const inMulti = views.multi.style.display !== 'none';

      if (wasReconnecting && inTerm && currentAgentId) {
        // Resume single terminal. The agent may have reconnected while we were
        // away and changed its agentId — resolve through the stable terminal
        // key so we follow the NEW id rather than subscribing to a dead one
        // (the old behaviour froze the view when the id went stale).
        const fresh = resolveAgentId(currentTerminalKey) || currentAgentId;
        if (fresh !== currentAgentId) {
          forgetTerminalState(currentAgentId);
          currentAgentId = fresh;
          termFilter = createAltScreenFilter({ nativeTui: isNativeTuiAgent(fresh) });
          lastSeqByAgent.delete(fresh);   // new id: start from a full replay
          if (term) term.clear();
        }
        const size = proposedSize(fitAddon, term);
        updateNativeTuiControls();
        rememberRequestedSize(currentAgentId, size);
        ws.send(JSON.stringify({ type: 'connect', agentId: currentAgentId, ...size,
          resume: true, sinceSeq: lastSeqByAgent.get(currentAgentId) || 0 }));
        if (!isSnapshotAgent(currentAgentId)) ws.send(JSON.stringify({ type: 'resize', agentId: currentAgentId, ...size }));
      } else if (wasReconnecting && inMulti) {
        // Resume multi terminal: re-subscribe previously opened agents.
        // Remap stale ids through the stable key the same way.
        remapMultiTerms();
        subscribeMultiTerms(true);
      } else {
        // Fresh login (or reconnect while not in a terminal): show dashboard.
        document.getElementById('login-error').style.display = 'none';
        showView('dash');
        renderAgents(lastAgents);
      }
    } else if (msg.type === 'error') {
      if (isReconnecting) {
        // Auth rejected during reconnect (e.g. password changed): fall back to login.
        isReconnecting = false;
        wasAuthenticated = false;
        hideNetworkOverlay();
        localStorage.removeItem('swt-pw');
        document.getElementById('username-input').style.display = '';
        document.getElementById('password-input').style.display = '';
        document.querySelector('.login-box button').style.display = '';
        document.getElementById('login-error').textContent = msg.message || 'Auth failed, please login again';
        document.getElementById('login-error').style.display = 'block';
        showView('login');
      } else if (views.login.style.display !== 'none') {
        localStorage.removeItem('swt-pw');
        document.getElementById('login-error').textContent = msg.message;
        document.getElementById('login-error').style.display = 'block';
      }
    } else if (msg.type === 'agents') {
      lastAgents = msg.agents || [];
      syncAttentionFromAgents(lastAgents);
      syncAgentIdMap(lastAgents);
      if (msg.serverFiles) lastServerFiles = msg.serverFiles;
      renderAgents(lastAgents);
      if (currentMode === 'mgmt') { renderMgmtClients(); refreshAnalyzerOptions(); }
      // Mid-session id rotation: if the agent we're watching reconnected (new
      // agentId, same stable key), re-subscribe to the new id with an
      // incremental replay so the view keeps updating without user action.
      // Server-side replay ordering holds live frames until replay completes,
      // so the redraw lands cleanly before fresh output resumes.
      if (views.term.style.display !== 'none' && currentTerminalKey && term) {
        const fresh = resolveAgentId(currentTerminalKey);
        if (fresh && fresh !== currentAgentId && ws.readyState === WebSocket.OPEN) {
          forgetTerminalState(currentAgentId);
          currentAgentId = fresh;
          termFilter = createAltScreenFilter({ nativeTui: isNativeTuiAgent(fresh) });
          lastSeqByAgent.delete(fresh);
          term.clear();
          const size = proposedSize(fitAddon, term);
          rememberRequestedSize(fresh, size);
          ws.send(JSON.stringify({ type: 'connect', agentId: fresh, ...size, sinceSeq: 0 }));
        }
        updateNativeTuiControls();
      }
      if (views.multi.style.display !== 'none' && remapMultiTerms() && ws.readyState === WebSocket.OPEN) {
        subscribeMultiTerms(true);
      }
    } else if (msg.type === 'terminal_size') {
      if (msg.snapshot) pendingSizeSnapshot.add(msg.agentId);
    } else if (msg.type === 'data') {
      if (pendingSizeSnapshot.has(msg.agentId)) return;
      // Track the per-terminal seq position for later incremental resumes.
      // Replay frames carry seq too, so the position advances through both
      // live and replayed data.
      if (typeof msg.seq === 'number') lastSeqByAgent.set(msg.agentId, msg.seq);
      // Single terminal mode
      if (term && msg.agentId === currentAgentId) {
        const bytes = Uint8Array.from(atob(msg.payload), c => c.charCodeAt(0));
        term.write(msg.filtered ? bytes : termFilter(bytes));
      }
      // Multi terminal mode
      if (multiTerms[msg.agentId]) {
        const bytes = Uint8Array.from(atob(msg.payload), c => c.charCodeAt(0));
        multiTerms[msg.agentId].term.write(msg.filtered ? bytes : multiTerms[msg.agentId].filter(bytes));
      }
      // Mobile structured view (also feeds when in structured mode)
      if (msg.agentId === currentAgentId) {
        feedStructured(msg.payload, msg.agentId);
      }
    } else if (msg.type === 'terminal_snapshot') {
      pendingSizeSnapshot.delete(msg.agentId);
      if (typeof msg.seq === 'number') lastSeqByAgent.set(msg.agentId, msg.seq);
      const entry = msg.agentId === currentAgentId ? singleSession : multiTerms[msg.agentId];
      if (entry && msg.cols > 0 && msg.rows > 0) {
        const target = entry.term;
        // Queue the reset with xterm writes already in flight from before the
        // reconnect; a synchronous reset could be undone by those old writes.
        target.write('\x1bc');
        target.resize(msg.cols, msg.rows);
        const bytes = Uint8Array.from(atob(msg.payload), c => c.charCodeAt(0));
        target.write(bytes, () => {
          if (entry.scope.disposed) return;
          const state = msg.parserState;
          if (!state) return; // Snapshots from older clients remain supported.
          const { scrollTop, scrollBottom, cursorX, cursorY } = state;
          if (![scrollTop, scrollBottom, cursorX, cursorY].every(Number.isInteger) ||
              scrollTop < 0 || scrollTop > scrollBottom || scrollBottom >= target.rows ||
              cursorX < 0 || cursorX > target.cols || cursorY < 0 || cursorY >= target.rows) return;
          // Restore margins without sending DECSTBM here: that command also
          // moves the cursor and discards a pending wrap at the right edge.
          // The snapshot callback runs before subsequent live writes parse.
          const buffer = target._core._bufferService.buffer;
          buffer.scrollTop = scrollTop;
          buffer.scrollBottom = scrollBottom;
          buffer.x = cursorX;
          buffer.y = cursorY;
          target.refresh(0, target.rows - 1);
        });
      }
    } else if (msg.type === 'terminal_snapshot_error') {
      pendingSizeSnapshot.delete(msg.agentId);
      console.error('Terminal snapshot failed:', msg.message);
      showFloatingNotice('终端历史恢复失败，请重新打开：' + (msg.message || '未知错误'));
    } else if (msg.type === 'scrollback_info') {
      // hasMore=true just notes that older history exists beyond the initial
      // replay window. We deliberately do NOT auto-load it: xterm.js writes
      // sequentially and cannot prepend, so older pages would land BELOW the
      // newer content — the chained pages end with the OLDEST chunk as the
      // visible screen, burying the live output ("replay shows days-old
      // content / latest output missing"). Loading arbitrary older history
      // into a live xterm buffer correctly needs a different architecture
      // (server-side rendered-text buffer), not this byte-stream replay.
      // mode:'full' means the server could NOT serve an incremental delta
      // (history trimmed past our position, or we asked for a fresh window) —
      // it is about to replay a full recent window, so clear our buffer first
      // or the replayed history would stack below/behind stale local content.
      if (msg.mode === 'full' && msg.agentId === currentAgentId && term) {
        term.clear();
      }
      if (msg.mode === 'full' && multiTerms[msg.agentId]) {
        multiTerms[msg.agentId].term.clear();
      }
    } else if (msg.type === 'scrollback_end') {
      if (msg.snapshot) return;
      // All history written. Replay draws with whatever PTY size the agent had;
      // make sure the app inside repaints at OUR size: send one resize
      // round-trip (shrink a row, restore after 250ms). The gap matters —
      // back-to-back resizes (50ms) arrive faster than screen/codex can
      // repaint, and the two overlapping redraws pile frames on the screen.
      if (msg.agentId === currentAgentId && term && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', agentId: msg.agentId, cols: term.cols, rows: Math.max(1, term.rows - 1) }));
        const session = singleSession;
        session.scope.debounce('legacy-redraw', () => {
          if (ws && ws.readyState === WebSocket.OPEN && term) {
            ws.send(JSON.stringify({ type: 'resize', agentId: currentAgentId, cols: term.cols, rows: term.rows }));
          }
        }, 250);
      }
    } else if (typeof msg.type === 'string' && msg.type.startsWith('file_')) {
      handleFileMsg(msg);
    } else if (msg.type === 'claude_state') {
      // Update single agent's claudeState in cache + re-render.
      // Server only sends this on an actual kind/prompt change, so this is the
      // authoritative transition point for the attention pulse + notification.
      if (lastAgents && msg.agentId) {
        const a = lastAgents.find(x => x.id === msg.agentId);
        if (a) {
          a.claudeState = msg.state;
          setAgentAttention(a.id, a.name, a.claudeState);
          updateTitleBadge();
          if (currentMode === 'card') renderAgents(lastAgents);
          if (currentMode === 'mgmt') renderMgmtClients();
        }
      }
    } else if (msg.type === 'supervisor_event') {
      lastSupervisorEvent = msg;
      if (currentMode === 'mgmt') renderMgmtSummary();
      startTitleFlash(supervisorFlashText(msg.event));
    } else if (msg.type === 'supervisor_config') {
      // Broadcast to all browsers whenever anyone saves settings, so every
      // open management panel (including the one that just saved) stays in sync.
      supervisorConfig = msg.config || {};
      if (currentMode === 'mgmt') renderSupervisorSettings();
    } else if (msg.type === 'supervisor_config_result') {
      const statusEl = document.getElementById('sup-save-status');
      if (msg.ok) {
        if (statusEl) { statusEl.textContent = '已保存'; setTimeout(() => { if (statusEl.textContent === '已保存') statusEl.textContent = ''; }, 2500); }
        flashToast('督工配置已保存');
      } else {
        if (statusEl) statusEl.textContent = '保存失败';
        flashToast('保存失败: ' + (msg.error || 'unknown'), 'error');
      }
    } else if (msg.type === 'spawn_node_result') {
      if (pendingSpawnReqs.has(msg.reqId)) pendingSpawnReqs.delete(msg.reqId);
      const okMsg = msg.ok
        ? `✓ 新增节点成功: ${msg.screenName} (PID ${msg.childPid||'?'})`
        : `✗ 新增节点失败: ${msg.error || 'unknown'}`;
      showFloatingNotice(okMsg);
      // Refresh supervisor view (agent will register shortly)
      setTimeout(() => { if (currentMode === 'mgmt') renderMgmtClients(); }, 1500);
    } else if (msg.type === 'kill_node_result') {
      // Success isn't acked further — the agent disappearing from the list
      // (via its own disconnect, broadcast automatically) is the real
      // confirmation. Only surface the failure case.
      if (!msg.ok) flashToast('操作失败: ' + (msg.error || 'unknown'), 'error');
    } else if (msg.type === 'list_screens_result') {
      // Update node count for this client
      if (lastAgents && msg.clientId) {
        for (const a of lastAgents) {
          if (a && (a.attrs && a.attrs.clientId) === msg.clientId) a.reportedNodeCount = (msg.screens||[]).length;
        }
        if (currentMode === 'mgmt') renderMgmtClients();
      }
    } else if (msg.type === 'push_update_result') {
      const p = msg.reqId && pendingUpdateReqs.get(msg.reqId);
      if (p) { clearTimeout(p.timer); pendingUpdateReqs.delete(msg.reqId); }
      showFloatingNotice(msg.ok
        ? `✓ ${msg.agentName} 已更新` + (msg.updated && msg.updated.length ? `: ${msg.updated.join(', ')}` : '（已是最新）')
        : `✗ ${msg.agentName} 更新失败: ${msg.error || 'unknown'}`);
      if (currentMode === 'mgmt') renderMgmtClients();
    } else if (msg.type === 'query_files_result') {
      const p = msg.reqId && pendingUpdateReqs.get(msg.reqId);
      if (p) { clearTimeout(p.timer); pendingUpdateReqs.delete(msg.reqId); }
      if (currentMode === 'mgmt') renderMgmtClients();
    } else if (msg.type === 'restart_server_result') {
      showFloatingNotice(msg.ok ? (msg.message || '服务器重启中…') : `✗ 重启失败: ${msg.error || 'unknown'}`);
    } else if (msg.type === 'pull_update_result') {
      const p = pendingPullReqs.get(msg.reqId);
      if (p) { clearTimeout(p.timer); pendingPullReqs.delete(msg.reqId); }
      showFloatingNotice(msg.ok
        ? `✓ 已从 ${msg.agentName} 拉取: ${(msg.updated || []).join(', ')} — 重启服务器后生效`
        : `✗ 从 ${msg.agentName} 拉取失败: ${msg.error || 'unknown'}`);
    }
  };

  connection.onclose = () => {
    if (ws !== connection) return;
    clearManagementRequests();
    fileReqQueue.length = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    // Abort any in-flight file transfer — uploadId/downloadId won't survive reconnect.
    if (pendingUpload) {
      showFileProgress('上传中断: ' + pendingUpload.file.name, 0, '连接断开，请重试', 'error');
      pendingUpload = null;
    }
    if (activeDownload) {
      showFileProgress('下载中断: ' + activeDownload.name, 0, '连接断开，请重试', 'error');
      activeDownload = null;
    }
    const pw = localStorage.getItem('swt-pw');
    const user = localStorage.getItem('swt-user') || 'zzb';
    if (wasAuthenticated && pw) {
      // Reconnect mode: keep current view + terminal content intact, show floating notice.
      isReconnecting = true;
      showNetworkOverlay();
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (localStorage.getItem('swt-pw')) {
          connect(user, localStorage.getItem('swt-pw'));
        }
      }, 2000);
    } else {
      showView('login');
      document.getElementById('login-error').textContent = 'Connection lost';
      document.getElementById('login-error').style.display = 'block';
    }
  };
}

function showNetworkOverlay() {
  const el = document.getElementById('network-overlay');
  if (el) { el.style.display = 'block'; el.style.opacity = '1'; }
}

function hideNetworkOverlay() {
  const el = document.getElementById('network-overlay');
  if (el) { el.style.display = 'none'; el.style.opacity = ''; }
}

function doLogout() {
  localStorage.removeItem('swt-pw');
  wasAuthenticated = false;
  isReconnecting = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  hideNetworkOverlay();
  if (ws) ws.close();
  document.getElementById('username-input').style.display = '';
  document.getElementById('password-input').style.display = '';
  document.querySelector('.login-box button').style.display = '';
  showView('login');
}
