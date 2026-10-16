'use strict';

// xterm 5.3 suppresses forced-selection mousedown reports, but its mouseup
// handler still reports to the app and clears the selection as user input.
// Guard before report generation; filtering onData would already be too late.
function installTerminalSelectionGuard(target) {
  // Private API, pinned to xterm 5.3.0 just like snapshot parser-state restore.
  const core = target._core;
  const mouse = core.coreMouseService;
  const original = mouse.triggerMouseEvent;
  const element = target.element;
  const doc = element.ownerDocument;
  let selecting = false;
  let gesture = 0;
  let releaseTimer = null;
  const down = event => {
    if (event.button !== 0) return;
    clearTimeout(releaseTimer);
    gesture++;
    selecting = core._selectionService.shouldForceSelection(event);
  };
  const up = event => {
    if (event.button !== 0 || !selecting) return;
    const finished = gesture;
    // Keep protection through both element and document mouseup handlers.
    // Do not swallow the DOM event: xterm needs it to finish the selection.
    releaseTimer = setTimeout(() => { if (gesture === finished) selecting = false; }, 0);
  };
  mouse.triggerMouseEvent = function(event) {
    // CoreMouseButton.NONE=3, CoreMouseAction.MOVE=32 in pinned xterm 5.3.
    // Preserve selection for the browser context menu and for hover in
    // any-motion tracking mode. Right-button reports are still sent when
    // there is no selection; xterm handles the native context-menu setup.
    if (selecting || (target.hasSelection() &&
        (event.button === 2 || (event.button === 3 && event.action === 32)))) return false;
    return original.call(this, event);
  };
  // Use the terminal's existing copy-event handler. execCommand also works
  // on the HTTP staging site, where navigator.clipboard is unavailable.
  target.attachCustomKeyEventHandler(event => {
    if (event.type === 'keydown' && event.ctrlKey && event.shiftKey &&
        !event.altKey && !event.metaKey && event.code === 'KeyC' && target.hasSelection()) {
      event.preventDefault();
      doc.execCommand('copy');
      return false;
    }
    return true;
  });
  element.addEventListener('mousedown', down, true);
  doc.addEventListener('mouseup', up, true);
  core.register({ dispose() {
    clearTimeout(releaseTimer);
    element.removeEventListener('mousedown', down, true);
    doc.removeEventListener('mouseup', up, true);
    mouse.triggerMouseEvent = original;
    selecting = false;
    gesture++;
  }});
}

// ========== Terminal ==========

let singleSession = null;

function openTerminal(agentId, agentName) {
  if (singleSession) singleSession.dispose();
  currentAgentId = agentId;
  const meta = (lastAgents || []).find(a => a.id === agentId);
  currentTerminalKey = meta ? terminalKeyOf(meta) : null;
  markRecent(agentId);
  showView('term');

  // Show floating controls
  const floatBack = document.getElementById('float-back');
  floatBack.style.display = 'block';
  document.getElementById('float-upload').style.display = 'block';
  document.getElementById('float-download').style.display = 'block';
  const overlay = document.getElementById('term-overlay');
  overlay.textContent = agentName + ' · 原生 TUI';
  updateNativeTuiControls();
  overlay.style.display = 'block';
  // Fade out overlay after 3s


  const container = document.getElementById('term-container');
  container.innerHTML = '';

  // Reset structured-view state for this agent
  structBuf = '';
  structAgentId = agentId;
  structUserScrolled = false;

  const mobile = window.innerWidth < 600;
  // Default to the real terminal (xterm) even on mobile — 'structured' is a flattened,
  // ANSI-stripped text log with no cursor/redraw model, so it can't actually render a
  // full-screen TUI (vim, htop, Claude's interactive panels, ...); it only reads well
  // for Claude's plain chat-style output. Keep it reachable via the toggle for that case.
  const toggle = document.getElementById('float-toggle-view');
  if (mobile) {
    toggle.style.display = 'block';
    setTermViewMode('xterm');
  } else {
    toggle.style.display = 'none';
    setTermViewMode('xterm');
  }
  const session = createTerminalSession(container, {
    agentId, getAgentId: () => currentAgentId, fontSize: mobile ? 11 : 14, scrollback: 200000
  });
  singleSession = session;
  term = session.term;
  fitAddon = session.fitAddon;
  term.onWriteParsed(updateNativeTuiControls);
  session.scope.debounce('overlay', () => { overlay.style.opacity = '0'; }, 3000);

  // ResizeObserver: debounce BOTH fit() and the resize message.
  // Mobile keyboard show/hide fires many resize events in quick succession —
  // fit() is given a SHORT debounce on mobile so the terminal reflows promptly
  // when the soft keyboard appears (longer on desktop where it just smooths
  // window drags). The resize-*send* is debounced longer in both cases.
  const resizeObserver = new ResizeObserver(() => {
    if (!fitAddon || !term) return;
    // Skip while the xterm container is hidden (structured-view active) — fitting
    // a 0×0 box would produce a degenerate size and send a bogus resize to the PTY.
    if (termViewMode === 'structured') return;
    if (container.clientWidth === 0 || container.clientHeight === 0) return;
    session.scope.debounce('resize', () => {
      if (term) sendViewportResize(currentAgentId, proposedSize(fitAddon, term));
    }, mobile ? 200 : 500);
  });
  resizeObserver.observe(container);
  session.scope.add(() => resizeObserver.disconnect());

  // Mobile: tap anywhere on the terminal → focus the live input bar → keyboard pops.
  if (mobile) {
    session.scope.listen(container, 'click', () => {
      const mi = document.getElementById('mobile-text-input');
      if (mi) mi.focus({ preventScroll: true });
    });
  }

  // Initial fit + connect after layout settles.
  // connect MUST come before resize: the server only forwards a resize for an
  // agent the browser has already subscribed to via connect (binfo.agentIds) —
  // sending resize first meant it was silently dropped, so the PTY never
  // actually matched the browser's real viewport size (stayed at whatever
  // size it registered with, e.g. 200x50), which is what caused misaligned
  // layout/garbled wide-character output for anything that queries terminal
  // size (a TUI banner, a fancy prompt, etc.).
  session.scope.frame(() => {
    session.scope.frame(() => {
      fitAddon.fit();
      const size = proposedSize(fitAddon, term);
      rememberRequestedSize(agentId, size);
      ws.send(JSON.stringify({ type: 'connect', agentId, ...size }));
    });
  });

}

function closeTerminal() {
  if (singleSession) singleSession.dispose();
  singleSession = null; term = null; fitAddon = null;
  if (structRenderTimer) clearTimeout(structRenderTimer);
  structRenderTimer = null; structAgentId = null;
  forgetTerminalState(currentAgentId);
  currentAgentId = null;
  currentTerminalKey = null;
  closeMobileInput();
  closeFileBrowser();
  hideFileProgress();
  document.getElementById('float-back').style.display = 'none';
  document.getElementById('float-upload').style.display = 'none';
  document.getElementById('float-download').style.display = 'none';
  document.getElementById('term-overlay').style.display = 'none';
  document.getElementById('term-overlay').style.opacity = '';
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'connect', agentId: null }));
  showView('dash');
}
