'use strict';

// Shared wire contract and pure screen heuristics. Input is a PARSED viewport,
// never a transcript or an ANSI-stripped byte stream.
(function(root) {
  const STATUSES = new Set(['working', 'idle', 'waiting_permission', 'waiting_input', 'unknown']);
  const APPS = new Set(['codex', 'claude', 'qoder', 'generic']);
  const labels = { working: '工作中', idle: '空闲', waiting_permission: '等待授权', waiting_input: '等待输入', unknown: '状态未知' };
  const appLabels = { codex: 'Codex', claude: 'Claude', qoder: 'Qoder', generic: 'Code CLI' };
  function emptyState() { return { isCodeCli: false, app: null, status: 'unknown', source: 'screen', prompt: '', options: [], sessionId: null, changedAt: null }; }
  function normalizeState(value) {
    if (!value || !value.isCodeCli || !APPS.has(value.app)) return emptyState();
    return {
      isCodeCli: true, app: value.app, status: STATUSES.has(value.status) ? value.status : 'unknown',
      source: value.source === 'hooks' ? 'hooks' : 'screen',
      prompt: String(value.prompt || '').slice(0, 300),
      options: Array.isArray(value.options) ? value.options.slice(0, 12).filter(o => o && Number.isInteger(o.index) && typeof o.label === 'string').map(o => ({ index: o.index, label: o.label.slice(0, 150) })) : [],
      sessionId: typeof value.sessionId === 'string' ? value.sessionId.slice(0, 160) : null,
      changedAt: typeof value.changedAt === 'string' ? value.changedAt.slice(0, 40) : null
    };
  }
  function legacyState(state) {
    const s = normalizeState(state);
    const kind = !s.isCodeCli ? 'none' : ({ working: 'working', idle: 'input', waiting_permission: 'bash', waiting_input: s.options.length ? 'option' : 'yesno', unknown: 'unknown' })[s.status];
    return { running: s.isCodeCli, kind, prompt: s.prompt, options: s.options, app: s.app, source: s.source, lastLine: s.prompt };
  }
  function fromLegacy(value) {
    if (!value || !value.running) return emptyState();
    return normalizeState({ isCodeCli: true, app: value.app || 'claude', status: ({ working: 'working', input: 'idle', done: 'idle', bash: 'waiting_permission', yesno: 'waiting_input', option: 'waiting_input' })[value.kind], prompt: value.prompt, options: value.options });
  }
  function detectScreen(view, previousApp = null) {
    const lines = (Array.isArray(view) ? view : String(view || '').split('\n')).slice(-300).map(l => String(l).trimEnd());
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    const top = lines.slice(0, 16).join('\n');
    const bottom = lines.slice(-14).join('\n');
    const all = lines.join('\n');
    const input = /^\s*[>❯›]\s*(?!\d+[.)])[^\n]*$/m.test(bottom);
    const hints = /(?:\?\s+for shortcuts|shift\s*\+\s*(?:tab|enter)|(?:enter|return)\s+(?:to\s+)?(?:send|submit)|esc\s+to\s+(?:interrupt|cancel)|\/\w+\s+for\s+(?:commands|help)|\d+%\s+context\s+(?:left|remaining))/i.test(bottom);
    const model = /(?:\bctx\b[^\n]*\d+%|\bcontext\b[^\n]*(?:\d+%|\d+\s*(?:tokens|left))|\bmodel\s*[:：]|\b\S+\s+Model\s*[·|]|^\s*(?:gpt-|claude-|sonnet\b|opus\b|haiku\b|deepseek-|qwen|gemini-)\S*[^\n]*\s[·|])/im.test(bottom);
    const trust = /(?:trust (?:the files|this (?:folder|directory))|Trust folder)/i.test(all) && /(?:enter\s+(?:to\s+)?(?:select|confirm)|↑\/↓\s+navigate)/i.test(bottom);
    const selection = /^\s*[❯>]\s*\d+[.)]\s+\S/m.test(bottom) && /(?:enter|esc|↑|↓)/i.test(bottom);
    let app = null;
    if (/^\s*[│┃╭─*✻ ]*(?:Welcome to\s+)?(?:OpenAI\s+Codex)(?:\s|$|\()/im.test(top)) app = 'codex';
    else if (/^\s*[│┃╭─*✻ ]*(?:Welcome to\s+)?Claude Code(?:\s|$|[!v])/im.test(top)) app = 'claude';
    else if (/^\s*[│┃╭─█ ]*Qoder\s+CLI(?:\s+CN)?\s+v?\d/im.test(top)) app = 'qoder';
    else if (/^\s*›\s+Ask Codex to do anything\s*$/m.test(bottom) && hints && model) app = 'codex';
    // A brand mentioned in prose is insufficient. Require an actual UI region.
    if (app && !((input && (hints || model)) || trust || selection || /esc to interrupt/i.test(bottom))) app = null;
    if (!app && input && hints && model) app = previousApp || 'generic';
    if (!app && previousApp && (input && hints)) app = previousApp;
    if (!app && previousApp && (selection || /esc\s+to\s+interrupt/i.test(bottom))) app = previousApp;
    const last = lines.filter(l => l.trim()).at(-1) || '';
    const shell = /(?:^|\s)(?:[\w.-]+@[\w.-]+:[^\n]*|(?:bash|sh|zsh)[-\w.]*|staging-2080:[^\n]*)[#$]\s*$/.test(last) || /^\s*[$#]\s*$/.test(last);
    if (shell) return { ...emptyState(), shell: true };
    if (!app) return emptyState();
    const result = { ...emptyState(), isCodeCli: true, app, prompt: '', status: 'unknown' };
    if (/Not logged in|Run \/login|Waiting for authentication/i.test(bottom)) return { ...result, prompt: '需要登录' };
    const selected = lines.findLastIndex(l => /^\s*[❯>]\s*\d+[.)]\s+\S/.test(l));
    const panel = selected >= Math.max(0, lines.length - 22) ? lines.slice(Math.max(0, selected - 6), selected + 9).join('\n') : '';
    const options = panel.split('\n').map(l => l.match(/^\s*[❯>]?\s*(\d+)[.)]\s+(.+?)\s*$/)).filter(Boolean).map(m => ({ index: +m[1], label: m[2] }));
    const actionable = options.length >= 2 && /(?:enter|esc|↑|↓|allow|approve|yes|no|trust)/i.test(panel + '\n' + bottom);
    if (actionable || /\([Yy]\/[Nn]\)\s*$/.test(bottom.trim())) {
      result.status = /(?:permission|allow|approve|run (?:this )?command|execute|trust|accept.*edit)/i.test(panel || bottom) ? 'waiting_permission' : 'waiting_input';
      result.options = options;
      result.prompt = (panel || bottom).split('\n').find(l => /[?？]\s*$/.test(l.trim()))?.trim() || options[0]?.label || '需要确认';
    } else {
      // Match task indicators in the interaction area, excluding updater and
      // download spinners. A bullet list or the word "working" in prose isn't one.
      const inputAt = lines.findLastIndex(l => /^\s*[>❯›]\s*(?!\d+[.)])[^\n]*$/.test(l));
      const interactionStart = inputAt >= 0 ? Math.max(0, inputAt - 5) : Math.max(0, lines.length - 8);
      const task = lines.slice(interactionStart).find(l => !/\b(?:updat(?:e|ing)|download(?:ing)?|install(?:ing)?)\b/i.test(l) && (
        /esc\s+to\s+interrupt/i.test(l) ||
        /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✻✽✢✶✳*•]\s+\S.*(?:\(\s*\d+(?:m|s)|…|\.\.\.)/.test(l)
      ));
      if (task) { result.status = 'working'; result.prompt = task.trim(); }
      else if (input && (hints || model)) result.status = 'idle';
    }
    return result;
  }
  function stateLabel(state) { return state?.isCodeCli ? labels[state.status] || labels.unknown : ''; }
  function appLabel(state) { return appLabels[state?.app] || ''; }
  function stateText(state) { return state?.isCodeCli ? `${stateLabel(state)} · ${appLabel(state)} · ${state.source === 'hooks' ? '事件' : '推断'}` : ''; }
  function needsInput(state) { return !!state?.isCodeCli && ['idle', 'waiting_input', 'waiting_permission'].includes(state.status); }
  const api = { emptyState, normalizeState, legacyState, fromLegacy, detectScreen, stateLabel, appLabel, stateText, needsInput };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CliState = api;
})(globalThis);
