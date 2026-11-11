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
      changedAt: typeof value.changedAt === 'string' ? value.changedAt.slice(0, 40) : null,
      ...(value.app === 'generic' && typeof value.appName === 'string' && value.appName.trim()
        ? {appName: value.appName.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 64)} : {}),
      ...(['installing', 'configured', 'blocked', 'error', 'disabled', 'connected'].includes(value.hookSetup?.phase)
        ? {hookSetup: {phase: value.hookSetup.phase, message: String(value.hookSetup.message || '').slice(0, 300)}} : {})
    };
  }
  function detectScreen(view) {
    const lines = (Array.isArray(view) ? view : String(view || '').split('\n')).slice(-300).map(l => String(l).trimEnd());
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    const bottom = lines.slice(-14).join('\n');
    const hints = /(?:\?\s+for shortcuts|shift\s*\+\s*(?:tab|enter)|(?:enter|return)\s+(?:to\s+)?(?:send|submit)|esc\s+to\s+(?:interrupt|cancel)|\/\w+\s+for\s+(?:commands|help)|\d+%\s+context\s+(?:left|remaining))/i.test(bottom);
    // Metadata syntax, never provider/model names. A framed input plus its
    // controls can establish a UI even when model metadata is not displayed.
    const model = /(?:\bctx\b[^\n]*\d+%|\d+%\s+context\b|\bcontext\b[^\n]*(?:\d+%|\d+\s*(?:tokens|left))|\bmodel\s*[:：]|\b\S+\s+Model\s*[·|]|^\s*\S+\s+(?:default|low|medium|high|xhigh|max)\s*[·|])/im.test(bottom);
    const separator = line => /^\s*[╭╰┌└]?[-=─━═_]{6,}[╮╯┐┘]?\s*$/.test(line);
    const framed = i => lines.slice(Math.max(0, i - 2), i).some(separator) && lines.slice(i + 1, i + 3).some(separator);
    const inputAt = lines.findLastIndex((line, i) => {
      if (i < lines.length - 14) return false;
      const match = line.match(/^\s*([>❯›*»➜])(?!\s*\d+[.)])(?:\s+[^\n]*|$)/);
      // A bullet-like marker needs an actual input frame and metadata. This
      // requirement depends on its structure, not a CLI name or process.
      return !!match && (!/[*»➜]/.test(match[1]) || (framed(i) && model));
    });
    const input = inputAt >= 0;
    const selection = /^\s*[❯>]\s*\d+[.)]\s+\S/m.test(bottom) && /(?:enter|esc|↑|↓)/i.test(bottom);
    const identified = hints && ((input && (model || framed(inputAt))) || (selection && model));
    const last = lines.filter(l => l.trim()).at(-1) || '';
    const shell = /(?:^|\s)(?:[\w.-]+@[\w.-]+:[^\n]*|(?:bash|sh|zsh)[-\w.]*|staging-2080:[^\n]*)[#$]\s*$/.test(last) || /^\s*[$#]\s*$/.test(last);
    if (shell) return { ...emptyState(), shell: true };
    if (!identified) return emptyState();
    const result = { ...emptyState(), isCodeCli: true, app: 'generic', prompt: '', status: 'unknown' };
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
      const interactionStart = inputAt >= 0 ? Math.max(0, inputAt - 5) : Math.max(0, lines.length - 8);
      const task = lines.slice(interactionStart).find((l, i) => interactionStart + i !== inputAt && !/\b(?:updat(?:e|ing)|download(?:ing)?|install(?:ing)?)\b/i.test(l) && (
        /esc\s+to\s+interrupt/i.test(l) ||
        /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✻✽✢✶✳*•]\s+\S.*(?:\(\s*\d+(?:m|s)|…|\.\.\.)/.test(l)
      ));
      if (task) { result.status = 'working'; result.prompt = task.trim(); }
      else if (input && (hints || model)) result.status = 'idle';
    }
    return result;
  }
  function stateLabel(state) { return state?.isCodeCli ? labels[state.status] || labels.unknown : ''; }
  function appLabel(state) { return state?.app === 'generic' ? state.appName || appLabels.generic : appLabels[state?.app] || ''; }
  function hookHint(state) { return state?.isCodeCli && state.source !== 'hooks' ? state.hookSetup?.message || '' : ''; }
  function stateText(state) {
    const setup = {configured:'事件待接通',installing:'正在接入',blocked:'事件未接通',error:'事件未接通',disabled:'自动接入关闭'};
    return state?.isCodeCli ? `${stateLabel(state)} · ${appLabel(state)} · ${state.source === 'hooks' ? '事件' : '推断'}${hookHint(state) ? ' · ' + (setup[state.hookSetup.phase] || '事件待接通') : ''}` : '';
  }
  function needsInput(state) { return !!state?.isCodeCli && ['idle', 'waiting_input', 'waiting_permission'].includes(state.status); }
  const api = { emptyState, normalizeState, detectScreen, stateLabel, appLabel, stateText, hookHint, needsInput };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CliState = api;
})(globalThis);
