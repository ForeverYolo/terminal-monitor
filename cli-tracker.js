'use strict';
const { emptyState, detectScreen, normalizeState } = require('./cli-state');
const EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Stop', 'StopFailure', 'Interrupt', 'SessionEnd', 'Notification']);
const sameProcess = (a, b) => a && b && a.pid === b.pid && a.start === b.start;

class CliTracker {
  constructor() { this.reset(); }
  reset() {
    this.state = emptyState();
    this.binding = this.hook = this.candidate = this.endedBinding = null;
    this.frame = this.frameAtEvent = null;
    this.exited = false;
    this.lastEventAt = 0;
  }
  publish(value) {
    const next = normalizeState(value);
    const fields = s => JSON.stringify({ ...s, changedAt: null });
    next.changedAt = fields(next) === fields(this.state) ? this.state.changedAt : new Date().toISOString();
    this.state = next;
    return next;
  }
  screen(lines, processes, now = Date.now()) {
    const frame = JSON.stringify(lines);
    if (this.endedBinding) {
      if (!processes || processes.clis.some(p => sameProcess(p, this.endedBinding))) return this.publish(emptyState());
      this.endedBinding = null; this.exited = true;
    }
    if (processes && this.binding && !processes.clis.some(p => sameProcess(p, this.binding))) { this.reset(); this.exited = true; }
    this.frame = frame;
    const screen = detectScreen(lines, this.binding?.app || (processes?.clis.length === 1 ? processes.clis[0].app : null) || (this.state.isCodeCli ? this.state.app : null));
    // A shell prompt alone can be printed by tool output: only clear a bound
    // live CLI when its process is gone. Unbound screen inference clears now.
    if (screen.shell && !this.binding) { this.hook = null; this.candidate = null; this.exited = false; return this.publish(emptyState()); }
    if (this.hook && this.binding) {
      // Parse once: only a fresh frame may settle a Stop or an interactive
      // request. A working hook remains authoritative during silent output.
      const needsScreen = this.hook.settling || ['waiting_permission', 'waiting_input'].includes(this.hook.status);
      if (needsScreen && frame !== this.frameAtEvent && screen.isCodeCli && screen.status !== 'unknown') {
        this.hook = { ...this.hook, status: screen.status, prompt: screen.prompt, options: screen.options, settling: screen.status === 'working' };
      }
      return this.publish(this.hook);
    }
    const matching = processes?.clis.filter(p => p.app === screen.app) || [];
    if (screen.isCodeCli && matching.length === 1) this.binding = matching[0];
    // If /proc is available and says there is no known CLI, stale brand text
    // must not keep a formerly bound known CLI alive after exit.
    if (processes && !processes.clis.length && this.exited) {
      this.candidate = null; return this.publish(emptyState());
    }
    if (this.binding) this.exited = false;
    if (this.binding && !screen.isCodeCli) return this.publish({ ...this.state, isCodeCli: true, app: this.binding.app, status: 'unknown', source: 'screen', prompt: '', options: [] });
    if (screen.isCodeCli && !this.state.isCodeCli) {
      const key = screen.app;
      if (!this.candidate || this.candidate.key !== key) this.candidate = { key, since: now };
      if (now - this.candidate.since < 300) return this.state;
    } else this.candidate = null;
    return this.publish(screen);
  }
  event(event, processes) {
    if (!event || !EVENTS.has(event.event) || !['codex', 'claude'].includes(event.app) || typeof event.sessionId !== 'string' || !event.sessionId || event.sessionId.length > 160) return false;
    if (event.event === 'Notification' && !['permission_prompt', 'idle_prompt'].includes(event.notificationType)) return false;
    const match = processes?.clis.find(p => sameProcess(p, event) && p.app === event.app);
    // Fail closed on ambiguous multi-window sessions; no cross-window hooks.
    if (!match || processes.clis.length !== 1) return false;
    if (this.endedBinding && event.event !== 'SessionStart') return false;
    if (event.sentAt !== undefined && (!Number.isFinite(event.sentAt) || event.sentAt < this.lastEventAt || Math.abs(Date.now() - event.sentAt) > 30000)) return false;
    if (this.binding && !sameProcess(match, this.binding)) return false;
    if (this.hook?.sessionId && this.hook.sessionId !== event.sessionId && event.event !== 'SessionStart') return false;
    if (this.hook?.turnId && event.turnId && this.hook.turnId !== event.turnId && !['UserPromptSubmit', 'SessionStart'].includes(event.event)) return false;
    this.binding = match;
    if (event.sentAt) this.lastEventAt = event.sentAt;
    const s = { ...emptyState(), ...this.hook, isCodeCli: true, app: event.app, source: 'hooks', sessionId: event.sessionId, turnId: event.turnId || this.hook?.turnId, prompt: '', options: [] };
    switch (event.event) {
      case 'SessionStart': this.endedBinding = null; s.status = 'unknown'; s.turnId = null; s.settling = true; break;
      case 'UserPromptSubmit': case 'PostToolUse': case 'PostToolUseFailure': s.status = 'working'; break;
      case 'PreToolUse': s.status = /^(?:AskUserQuestion|request_user_input)$/i.test(event.toolName || '') ? 'waiting_input' : 'working'; break;
      case 'PermissionRequest': s.status = 'waiting_permission'; s.prompt = '请求执行权限'; break;
      case 'PermissionDenied': s.status = 'unknown'; break;
      // Stop is pre-final and other hooks can continue the turn. Only a later
      // current idle screen settles it; do not announce completion prematurely.
      case 'Stop': case 'Interrupt': case 'StopFailure': s.status = 'unknown'; s.settling = true; break;
      case 'Notification':
        if (event.notificationType === 'permission_prompt') { s.status = 'waiting_permission'; s.prompt = '请求执行权限'; }
        else s.status = 'idle';
        break;
      case 'SessionEnd': this.endedBinding = match; this.hook = null; this.binding = null; this.candidate = null; this.publish(emptyState()); return true;
    }
    if (['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event.event)) s.settling = false;
    this.hook = s;
    this.frameAtEvent = this.frame;
    this.publish(s);
    return true;
  }
}
module.exports = { CliTracker, EVENTS };
