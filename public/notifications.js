'use strict';

// ========== Attention: pulse + notify when a Claude session needs input ==========
// "Needs input" is a deterministic fact from claudeState.kind — no LLM involved.
// Card/row pulsing (CSS) always reflects current membership in attentionAgents;
// the one-shot alert (desktop notification + toast) fires only on a genuinely
// NEW attention state per agent, tracked via notifiedKinds, so the periodic
// 10s `agents` snapshot re-broadcast doesn't re-alert for a still-pending prompt.
const ATTENTION_KINDS = new Set(['yesno', 'bash', 'option']);
const attentionAgents = new Set();     // agentIds currently needing attention
const notifiedKinds = new Map();       // agentId -> kind already alerted for
const BASE_TITLE = document.title;

function isAttentionState(cs) {
  return !!(cs && cs.running && ATTENTION_KINDS.has(cs.kind));
}

function setAgentAttention(agentId, agentName, cs) {
  if (isAttentionState(cs)) {
    attentionAgents.add(agentId);
    if (notifiedKinds.get(agentId) !== cs.kind) {
      notifiedKinds.set(agentId, cs.kind);
      notifyAttention(agentId, agentName, cs);
    }
  } else {
    attentionAgents.delete(agentId);
    notifiedKinds.delete(agentId);
  }
}

// Re-derive attention state for the whole fleet from a full agents snapshot
// (auth_ok / periodic broadcast) — also drops agents that disconnected.
function syncAttentionFromAgents(agents) {
  const currentIds = new Set(agents.map(a => a.id));
  for (const id of Array.from(attentionAgents)) {
    if (!currentIds.has(id)) { attentionAgents.delete(id); notifiedKinds.delete(id); }
  }
  for (const a of agents) setAgentAttention(a.id, a.name, a.claudeState);
  updateTitleBadge();
}

function currentBaseTitle() {
  return attentionAgents.size > 0 ? `(${attentionAgents.size}) ${BASE_TITLE}` : BASE_TITLE;
}

function updateTitleBadge() {
  if (titleFlashTimer) return; // a flash is owning document.title until the tab is seen
  document.title = currentBaseTitle();
}

// ========== Tab-title flashing: catches the eye when a new attention or
// supervisor message arrives while this tab isn't the one being looked at.
// Alternates document.title between a short description and the normal
// (badge-aware) title. Keeps flashing indefinitely while the tab is hidden;
// if it's already visible, flashes briefly (the toast already covers that
// case) then settles back down on its own. Either way it stops the moment
// the user actually looks at the tab.
let titleFlashTimer = null;
let titleFlashBurstTimer = null;
let titleFlashOn = false;

function startTitleFlash(text) {
  if (!text) return;
  if (titleFlashBurstTimer) { clearTimeout(titleFlashBurstTimer); titleFlashBurstTimer = null; }
  if (!titleFlashTimer) {
    titleFlashOn = false;
    titleFlashTimer = setInterval(() => {
      titleFlashOn = !titleFlashOn;
      document.title = titleFlashOn ? text : currentBaseTitle();
    }, 1000);
  }
  titleFlashText = text;
  if (!document.hidden) titleFlashBurstTimer = setTimeout(stopTitleFlash, 5000);
}
let titleFlashText = '';

function stopTitleFlash() {
  if (titleFlashTimer) { clearInterval(titleFlashTimer); titleFlashTimer = null; }
  if (titleFlashBurstTimer) { clearTimeout(titleFlashBurstTimer); titleFlashBurstTimer = null; }
  titleFlashOn = false;
  document.title = currentBaseTitle();
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) stopTitleFlash(); });
window.addEventListener('focus', stopTitleFlash);

const ATTENTION_LABELS = { yesno: '需要确认', bash: '请求执行权限', option: '需要选择' };

function notifyAttention(agentId, agentName, cs) {
  const label = ATTENTION_LABELS[cs.kind] || '需要输入';
  const body = (cs.prompt || '').substring(0, 120);
  try {
    if (window.Notification && Notification.permission === 'granted') {
      const n = new Notification(`${agentName} ${label}`, { body, tag: 'attn-' + agentId });
      n.onclick = () => {
        window.focus();
        if (currentMode !== 'multi') openTerminal(agentId, agentName);
        n.close();
      };
    }
  } catch { /* Notification not available/blocked — toast still fires below */ }
  flashToast(`${agentName}: ${label}${body ? ' — ' + body : ''}`, 'warn');
  // claude_state is a structured {kind, prompt} fact (not free-form text), so
  // "agentName label" is always a clean, short, reliable description — safe
  // to put straight into the tab title.
  startTitleFlash(`🔔 ${agentName} ${label}`);
}

// Supervisor events range from fixed-template alerts (idle_alert, analyzer_*)
// to free-form LLM prose (llm_summary). Only build a flash description for
// the ones with a predictable, short shape — anything else (raw multi-line
// AI summaries, periodic full-fleet summaries, connect/disconnect churn)
// would make a noisy or overlong tab title, so it's skipped.
function supervisorFlashText(ev) {
  if (!ev || !ev.type) return null;
  const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().substring(0, n);
  if (ev.type === 'idle_alert') return `⏳ ${clip(ev.message, 40)}`;
  if (ev.type === 'analyzer_missing' || ev.type === 'analyzer_timeout') return `⚠️ ${clip(ev.message, 40)}`;
  if (ev.type === 'llm_summary') {
    const firstLine = clip((ev.summary || '').split('\n')[0], 40);
    return `🧭 ${firstLine || '督工分析完成'}`;
  }
  return null;
}

function toggleNotifications() {
  if (!window.Notification) { flashToast('此浏览器不支持桌面通知', 'error'); return; }
  if (Notification.permission === 'granted') {
    flashToast('通知已开启');
    updateNotifToggleBtn();
    return;
  }
  Notification.requestPermission().then(() => {
    updateNotifToggleBtn();
    flashToast(Notification.permission === 'granted' ? '通知已开启' : '通知权限被拒绝');
  }).catch(() => {});
}

function updateNotifToggleBtn() {
  const btn = document.getElementById('notif-toggle');
  if (!btn) return;
  const granted = window.Notification && Notification.permission === 'granted';
  btn.classList.toggle('on', !!granted);
  btn.textContent = granted ? '🔔 已开启' : '🔔 通知';
}
updateNotifToggleBtn();
