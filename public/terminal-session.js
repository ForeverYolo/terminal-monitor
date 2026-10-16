'use strict';

// A view owns its timers, animation frames and DOM subscriptions. Disposal is
// idempotent and makes already queued callbacks harmless after view changes.
function createViewScope() {
  let disposed = false;
  const cleanup = [], timers = new Map(), frames = new Set();
  return {
    get disposed() { return disposed; },
    add(fn) { if (disposed) fn(); else cleanup.push(fn); },
    listen(target, event, callback) {
      target.addEventListener(event, callback);
      this.add(() => target.removeEventListener(event, callback));
    },
    debounce(key, callback, ms) {
      if (disposed) return;
      clearTimeout(timers.get(key));
      const timer = setTimeout(() => { timers.delete(key); if (!disposed) callback(); }, ms);
      timers.set(key, timer);
    },
    frame(callback) {
      if (disposed) return;
      const id = requestAnimationFrame(() => { frames.delete(id); if (!disposed) callback(); });
      frames.add(id);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const frame of frames) cancelAnimationFrame(frame);
      frames.clear();
      for (const fn of cleanup.reverse()) fn();
      cleanup.length = 0;
    }
  };
}

function sendTerminalInput(session, data) {
  if (!session || session.scope.disposed || !ws || ws.readyState !== WebSocket.OPEN) return;
  const agentId = session.getAgentId();
  if (!agentId) return;
  data = stripTerminalColorReplies(data, isNativeTuiAgent(agentId));
  if (!data) return;
  const bytes = new TextEncoder().encode(data);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const size = isSnapshotAgent(agentId) ? proposedSize(session.fitAddon, session.term) : null;
  if (size) rememberRequestedSize(agentId, size);
  ws.send(JSON.stringify({ type: 'data', payload: btoa(binary), agentId, ...(size || {}) }));
}

function createTerminalSession(container, { agentId, getAgentId, fontSize, scrollback, legacyResize = false }) {
  const scope = createViewScope();
  const target = new Terminal({
    theme: { background: '#0f0f23', cursor: '#e0e0e0', cursorAccent: '#0f0f23' },
    fontSize, scrollback, cursorBlink: true, macOptionClickForcesSelection: true
  });
  const addon = new FitAddon.FitAddon();
  target.loadAddon(addon);
  target.open(container);
  installTerminalSelectionGuard(target);
  // Screen expects SS3 arrows; its own attach-time smkx is not reliable.
  target.write('\x1b[?1h');
  const session = {
    agentId, container, term: target, fitAddon: addon, scope,
    getAgentId: getAgentId || (() => session.agentId),
    filter: createAltScreenFilter({ nativeTui: isNativeTuiAgent(agentId) }),
    dispose() { scope.dispose(); }
  };
  scope.add(() => {
    // xterm 5.3's Viewport leaves constructor/reset/refresh callbacks queued
    // after dispose. They otherwise access a renderer that has been freed.
    const viewport = target._core.viewport;
    if (viewport) {
      cancelAnimationFrame(viewport._refreshAnimationFrame);
      viewport.syncScrollArea = () => {};
      viewport._innerRefresh = () => {};
    }
    target.dispose();
  });
  target.onData(data => sendTerminalInput(session, data));
  if (legacyResize) target.onResize(({ cols, rows }) => {
    const id = session.getAgentId();
    if (ws && ws.readyState === WebSocket.OPEN && !isSnapshotAgent(id)) ws.send(JSON.stringify({ type: 'resize', agentId: id, cols, rows }));
  });
  return session;
}
