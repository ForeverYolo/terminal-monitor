'use strict';

// ========== Mobile structured view ==========
// Alternative to raw xterm on phones: render the terminal stream as a readable
// transcript + contextual action buttons (yes/no/options), driven by a JS port
// of claude-detector. Input goes through a normal <input> so IMEs work.

let termViewMode = 'xterm';        // 'xterm' | 'structured'
let structBuf = '';                // rolling ANSI-stripped transcript text
let structAgentId = null;
const STRUCT_BUF_MAX = 30000;
let structRenderTimer = null;
let structUserScrolled = false;

// --- Feed incoming data into the structured buffer ---
function feedStructured(base64Payload, agentId) {
  if (agentId !== structAgentId) return;
  let text;
  try { text = decodeURIComponent(escape(atob(base64Payload))); } catch { return; }
  text = ClaudeDetector.stripAnsi(text);
  // Normalize line ends: \r\n → \n; lone \r (spinner redraws) → \n
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  structBuf += text;
  if (structBuf.length > STRUCT_BUF_MAX) structBuf = structBuf.slice(-STRUCT_BUF_MAX);
  if (!structRenderTimer) structRenderTimer = setTimeout(renderStructured, 80);
}

// --- Render transcript + action bar ---
function renderStructured() {
  structRenderTimer = null;
  const el = document.getElementById('struct-transcript');
  if (!el) return;
  // Collapse runs of blank lines + dedupe consecutive identical lines (spinner noise)
  let lines = structBuf.split('\n');
  const out = [];
  let prev = null, blank = 0;
  for (const l of lines) {
    if (l.trim() === '') { blank++; continue; }
    if (blank > 0 && out.length) out.push('');   // one blank line between blocks
    blank = 0;
    if (l === prev) continue;                     // dedupe consecutive duplicates
    prev = l;
    out.push(l);
  }
  const shown = out.slice(-300);
  // Escape HTML then render
  el.innerHTML = shown.map(l => '<div class="struct-line">' + escapeHtml(l) + '</div>').join('');
  // Auto-scroll unless the user scrolled up
  if (!structUserScrolled) el.scrollTop = el.scrollHeight;

  // Action bar from detector
  renderStructActionbar();
}

function renderStructActionbar() {
  const bar = document.getElementById('struct-actionbar');
  if (!bar) return;
  const st = ClaudeDetector.detectClaudeState(structBuf);
  let html = '';
  if (st.running) {
    if (st.kind === 'yesno') {
      html = `<button class="primary" onclick="structAnswer('yes')">Yes</button>` +
             `<button class="danger" onclick="structAnswer('no')">No</button>`;
    } else if (st.kind === 'option' && st.options.length) {
      html = st.options.map(o =>
        `<button onclick="structAnswer('opt','${o.index}')">${escapeHtml(String(o.index))}. ${escapeHtml(o.label.slice(0,24))}</button>`
      ).join('');
    } else if (st.kind === 'working') {
      html = `<button disabled style="opacity:0.6">Claude 思考中…</button>`;
    } else if (st.kind === 'bash') {
      html = `<button class="primary" onclick="structAnswer('yes')">允许</button>` +
             `<button class="danger" onclick="structAnswer('no')">拒绝</button>`;
    }
  }
  if (html) { bar.innerHTML = html; bar.style.display = 'flex'; }
  else { bar.style.display = 'none'; }
}

// --- Input / actions ---
function structSendRaw(text) {
  sendRaw(text);
}
function structSendInput() {
  const inp = document.getElementById('struct-input');
  const v = inp.value;
  if (!v) return;
  structSendRaw(v + '\r');
  inp.value = '';
  inp.focus({ preventScroll: true });
}
function structKey(name) {
  const map = { ctrlc: '\x03', esc: '\x1b', tab: '\t', up: '\x1bOA', down: '\x1bOB', enter: '\r' };
  if (map[name]) structSendRaw(map[name]);
}
function structAnswer(kind, opt) {
  if (kind === 'yes') structSendRaw('y\r');
  else if (kind === 'no') structSendRaw('n\r');
  else if (kind === 'opt') structSendRaw(opt + '\r');
}

// --- Mode toggle (structured ↔ raw xterm) ---
function setTermViewMode(mode) {
  termViewMode = mode;
  const sv = document.getElementById('structured-view');
  const tc = document.getElementById('term-container');
  const mt = document.getElementById('mobile-toolbar');
  const toggle = document.getElementById('float-toggle-view');
  if (mode === 'structured') {
    sv.style.display = 'flex';
    tc.style.display = 'none';
    if (mt) mt.style.display = 'none';
    toggle.textContent = '原始';
    renderStructured();
    // Tell the PTY to render at a phone-friendly width so Claude wraps output
    // for reading instead of using the default 200-col layout.
    if (ws && ws.readyState === WebSocket.OPEN && currentAgentId) {
      sendViewportResize(currentAgentId, { cols: 100, rows: 40 });
    }
  } else {
    sv.style.display = 'none';
    tc.style.display = 'block';
    if (window.innerWidth < 600 && mt) mt.style.display = 'block';
    toggle.textContent = '结构';
    // Refit xterm to real size + re-send resize (it was hidden while sizing)
    if (singleSession) singleSession.scope.debounce('structured-fit', () => {
      if (ws && ws.readyState === WebSocket.OPEN && term) {
        sendViewportResize(currentAgentId, proposedSize(fitAddon, term));
      }
    }, 60);
  }
}
function toggleTermView() {
  setTermViewMode(termViewMode === 'structured' ? 'xterm' : 'structured');
}

// Track transcript manual scroll so we don't yank the user back to bottom
(function () {
  document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById('struct-transcript');
    if (!el) return;
    el.addEventListener('scroll', () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      structUserScrolled = !atBottom;
    });
  });
})();

// Enter key in the structured input sends
document.addEventListener('DOMContentLoaded', () => {
  const inp = document.getElementById('struct-input');
  if (inp) inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); structSendInput(); }
  });
});

// ========== Mobile toolbar ==========

function sendRaw(data) {
  sendTerminalInput(singleSession, data);
}

function send(seq) {
  if (ctrlActive) {
    const code = seq.charCodeAt(0);
    if (code >= 97 && code <= 122) {
      sendRaw(String.fromCharCode(code - 96));
    } else {
      sendRaw(seq);
    }
    clearCtrl();
  } else {
    sendRaw(seq);
  }
}

function sendCtrl(letter) {
  sendRaw(String.fromCharCode(letter.charCodeAt(0) - 96));
  clearCtrl();
}

function toggleCtrl() {
  ctrlActive = !ctrlActive;
  document.getElementById('btn-ctrl').classList.toggle('active', ctrlActive);
}

function clearCtrl() {
  ctrlActive = false;
  document.getElementById('btn-ctrl').classList.remove('active');
}

function focusMobileInput() {
  const input = document.getElementById('mobile-text-input');
  if (input) input.focus({ preventScroll: true });
}

// Explicit scroll controls for mobile — xterm.js's own scrollback viewport is
// notoriously unreliable to touch-drag on some phones/browsers even with
// -webkit-overflow-scrolling: touch, so these drive the same scroll API a
// mouse wheel would, with no dependency on touch gesture handling at all.
function scrollTermPages(n) {
  if (!term) return;
  if (applicationOwnsScrolling(term)) {
    send(n < 0 ? '\x1b[5~' : '\x1b[6~');
  } else term.scrollPages(n);
}
function scrollTermToBottom() {
  if (term) term.scrollToBottom();
}

function closeMobileInput() {
  const input = document.getElementById('mobile-text-input');
  if (input) input.value = '';
  mobileComposing = false;
}

// Mobile live input: each committed character is sent to the PTY immediately,
// so it feels like a real terminal (echo, mid-line Tab completion, etc.).
// IME-safe: during composition (third-party keyboards on iOS) we never touch
// the textarea value — only send after the IME commits.
let mobileComposing = false;
const mobileInputEl = document.getElementById('mobile-text-input');

mobileInputEl.addEventListener('compositionstart', () => { mobileComposing = true; });
mobileInputEl.addEventListener('compositionend', () => {
  mobileComposing = false;
  mobileDrain();
});
mobileInputEl.addEventListener('input', (e) => {
  if (mobileComposing || e.isComposing) return;   // mid-composition: do NOT read/clear
  mobileDrain();
});
// Backspace should delete in the terminal (otherwise the textarea just empties itself).
mobileInputEl.addEventListener('keydown', (e) => {
  if (mobileComposing || e.isComposing) return;
  if (e.key === 'Backspace') {
    e.preventDefault();
    sendRaw('\x7f');
  }
  // Android keyboards honour enterkeyhint by firing a keydown Enter WITHOUT
  // inserting \n into the textarea (nothing is submitted — there is no form),
  // so the input-event path below never runs and pressing the keyboard's send
  // key appears to do nothing.  Handle keydown Enter for that case; the
  // mobileDrain() guard (empty value → no-op) keeps the input-event fallback
  // from double-sending.
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    mobileDrain();
  }
});

// Drain committed text from the bar into the terminal, then clear it so the
// bar stays a one-line "live" input. \n (iOS return key / pasted newline) → \r.
function mobileDrain() {
  const v = mobileInputEl.value;
  if (!v) return;
  mobileInputEl.value = '';
  sendRaw(v.replace(/\n/g, '\r'));
  mobileInputEl.focus({ preventScroll: true });
}

function mobileSendEnter() {
  sendRaw('\r');
  mobileInputEl.focus({ preventScroll: true });
}

// iOS Safari keyboard adaptation: make #term-view follow the visualViewport
// height so that when the soft keyboard pushes up, the terminal view (and the
// mobile toolbar inside it) shrinks instead of being obscured. On desktop,
// visualViewport.height === innerHeight, so this is a harmless no-op there.
// Size changes use the canonical PTY resize and snapshot path.
(function () {
  const termView = document.getElementById('term-view');
  if (!termView || !window.visualViewport) return;
  const vv = window.visualViewport;
  function syncTermHeight() {
    termView.style.height = vv.height + 'px';
    termView.style.bottom = 'auto';   // height drives sizing, not bottom:0
    termView.style.top = vv.offsetTop + 'px';
    if (singleSession) singleSession.scope.debounce('viewport-resize', () => {
      if (term && ws && ws.readyState === WebSocket.OPEN)
        sendViewportResize(currentAgentId, proposedSize(fitAddon, term));
    }, 200);
  }
  vv.addEventListener('resize', syncTermHeight);
  vv.addEventListener('scroll', syncTermHeight);
  syncTermHeight();
})();
