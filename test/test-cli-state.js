'use strict';
const assert = require('assert');
const { detectScreen, normalizeState, legacyState, appLabel } = require('../cli-state');
const { CliTracker } = require('../cli-tracker');
const { TerminalState } = require('../terminal-state');
const pad = text => [...Array(8).fill(''), ...text.split('\n')];
const codex = pad('OpenAI Codex (v0.159.3)\n\n› Find a bug\n\n? for shortcuts                      100% context left');
const claude = pad('Claude Code v2.1.100\n\n────────────────────\n❯ \n────────────────────\n? for shortcuts');
const qoder = pad('Qoder CLI CN v1.1.84\n\n? for shortcuts\n────────────────────\nDefault Shift+Tab to Accept Edits\n────────────────────\n> Type your message or @path/to/file\n────────────────────\nDeepSeek-V4-Pro Model · ctx ░░░░░░░░░░ 0%');
let checks = 0;
function eq(actual, expected, reason) { checks++; assert.deepStrictEqual(actual, expected, reason); }
for (const [app, frame] of [['codex', codex], ['claude', claude], ['qoder', qoder]]) {
  const state = detectScreen(frame);
  eq([state.app, state.status], ['generic', 'idle'], app + ' real-layout input passes the same generic rule');
}
// Captured from locally installed CLIs on 2026-11-09 in empty disposable
// directories. Claude's isolated invocation has no login configuration.
for (const [app, frame] of Object.entries(require('./fixtures/cli-screens.json'))) {
  const state = detectScreen(frame);
  eq(state.app, 'generic', app + ' captured native viewport uses generic identity');
  eq(state.status, app === 'claude' ? 'unknown' : 'idle', app + ' captured state');
}
const taskScreens = require('./fixtures/cli-task-screens.json');
eq(detectScreen(taskScreens.qoderWorking).status, 'working', 'real Qoder generating while input remains visible');
eq(detectScreen(taskScreens.qoderIdle).status, 'idle', 'real Qoder completes and restores idle footer');
// Qoder 1.1.86, captured from monitor-4's actual coding footer. The banner
// scrolls out of view while a response is generated. No task content is kept.
const qoder186 = [' ⠋ Thinking... (esc to cancel, 1m 52s)       ? for shortcuts',
  '────────────────────', ' YOLO Shift+Tab to Auto Mode       21 skills',
  '────────────────────', ' *   Type your message or @path/to/file',
  '────────────────────', ' DeepSeek-V4-Pro Model · ctx ▓▓░░░░░░░░ 15% · <project>'];
eq([detectScreen(qoder186).app, detectScreen(qoder186).status], ['generic', 'working'], 'star input with scrolled banner uses generic structure');
const qoder186Idle = qoder186.map((line, i) => i === 0 ? '                         ? for shortcuts' : line);
eq(detectScreen(qoder186Idle).status, 'idle', 'framed star input idle');
eq(detectScreen(['Qoder CLI CN v1.1.86', ...qoder186Idle]), detectScreen(['Unrelated Product', ...qoder186Idle]), 'brand text cannot affect generic detection');
eq(detectScreen(['* a bullet item', '? for shortcuts']).isCodeCli, false, 'star and shortcut text without input structure are insufficient');
eq(detectScreen(qoder186.slice(0, -1)).isCodeCli, false, 'ambiguous marker needs model metadata');
const qoderTracker = new CliTracker(), qoderProcess = {clis: [{pid: 44, start: '101', app: 'qoder'}]};
qoderTracker.screen(qoder186, qoderProcess, 0);
eq(qoderTracker.screen(qoder186, qoderProcess, 400).status, 'working', 'foreground Qoder binds without visible banner');
eq(qoderTracker.screen(qoder186Idle, qoderProcess, 500).status, 'idle', 'Qoder task completes while same input stays visible');
eq(qoderTracker.screen(['user@host:~$ '], {clis: []}, 600).isCodeCli, false, 'Qoder exit restores shell with no state');
for (const app of ['codex', 'claude', 'qoder', 'generic']) {
  const namedTracker = new CliTracker();
  const p = {pid: 45, start: '102', app, ...(app === 'generic' ? {appName: 'starlight'} : {})};
  const processes = {clis: app === 'generic' ? [] : [p], foreground: [p]};
  namedTracker.screen(qoder186, processes, 0);
  const named = namedTracker.screen(qoder186, processes, 400);
  eq([named.app, named.status], [app, 'working'], 'same unbranded UI is named only by foreground process: ' + app);
  if (app === 'generic') eq(appLabel(named), 'starlight', 'unknown foreground program provides its own display name');
  eq(new CliTracker().screen(['normal application output'], processes, 400).isCodeCli, false, 'process name alone cannot establish Code CLI: ' + app);
}
const anonymous = new CliTracker(); anonymous.screen(qoder186, {clis: []}, 0);
eq(anonymous.screen(qoder186, {clis: []}, 400).app, 'generic', 'unknown process is not required for generic identity');
const noHints = qoder186Idle.filter(l => !/shortcuts|Shift\+Tab/.test(l));
eq(detectScreen(noHints).isCodeCli, false, 'framed prompt and model without operation hints are insufficient');
eq(detectScreen(['* notes...', 'model: example', '? for shortcuts']).isCodeCli, false, 'ordinary bullet/model/help text without input frame rejected');
for (const brand of ['OpenAI Codex', 'Claude Code', 'Qoder CLI CN v1.1.86'])
  eq(detectScreen([brand, '> quoted text', '? for shortcuts']).isCodeCli, false, 'brand cannot weaken the structural gate: ' + brand);
eq(detectScreen(qoder186Idle.map(l => l.replace('Type your message or @path/to/file', 'Think...'))).status, 'idle', 'typed input with ellipsis cannot act as work spinner');
const transient = new CliTracker(); transient.screen(qoder186, qoderProcess, 0);
eq(transient.screen(['ordinary text'], qoderProcess, 100).isCodeCli, false, 'a transient UI match cannot leave a process binding before the stable window');
const generic = qoder.filter(l => !l.startsWith('Qoder'));
eq(detectScreen(generic).app, 'generic', 'unbranded coherent footer still detected');
for (const frame of [
  'user@host:~$ ', 'Working...\nuser@host:~$ ', 'Downloading:\n⠋ Updating...',
  'README: use Claude Code or OpenAI Codex\n> quoted text',
  'Welcome to Claude Code!\n- fixed bug\nuser@host:~$ ',
  'vim: README.md\nmodel: foo\n> quote\n1. Work\n2. Sleep',
  'htop\nTasks: 10\nCPU 50%\nF1Help F10Quit',
  'esc to interrupt\n⠋ Working...',
  'OpenAI Codex\nThis document describes it.\n1. Setup\n2. Install'
]) eq(detectScreen(frame).isCodeCli, false, 'ordinary shell/prose/TUI is not a code CLI: ' + frame);
eq(detectScreen([...qoder, '⠋ Updating from 1.1.84 to 1.1.85']).status, 'idle', 'updater spinner is not task activity');
eq(detectScreen([...codex, '• Working (5s • esc to interrupt)']).status, 'working', 'task indicator');
const permission = [...claude, 'Allow Claude to run this command?', '❯ 1. Yes', '  2. No', 'Enter to confirm · Esc to cancel'];
eq(detectScreen(permission).status, 'waiting_permission', 'active permission panel');
eq(detectScreen([...claude, 'The documentation says: Do you want to proceed?']).status, 'idle', 'prose question is not an actionable prompt');
eq(detectScreen([...claude, '1. Write tests', '2. Fix code']).status, 'idle', 'ordinary list is not a permission panel');

const proc = { clis: [{ pid: 42, start: '100', app: 'codex' }] };
const tracker = new CliTracker();
tracker.screen(codex, proc, 0);
eq(tracker.screen(codex, proc, 400).app, 'codex', 'stable detection');
const event = (name, extra = {}) => ({ app: 'codex', pid: 42, start: '100', sessionId: 'session-a', turnId: 'turn-a', event: name, ...extra });
eq(tracker.event(event('UserPromptSubmit'), proc), true, 'valid bound event accepted');
eq(tracker.screen(codex, proc, 10000000).status, 'working', 'silent model remains working despite old idle viewport');
eq(tracker.event(event('PermissionRequest', { pid: 43 }), proc), false, 'wrong process rejected');
eq(tracker.event(event('PermissionRequest', { start: '99' }), proc), false, 'PID reuse rejected');
eq(tracker.event(event('PermissionRequest', { sessionId: 'session-b' }), proc), false, 'old session rejected');
eq(tracker.event(event('Stop', { turnId: 'old-turn' }), proc), false, 'old turn rejected');
eq(tracker.event(event('PermissionRequest'), { clis: [...proc.clis, {pid:43,app:'claude'}] }), false, 'ambiguous windows rejected');
eq(tracker.event(event('PermissionRequest'), {...proc, foreground: [...proc.clis, {pid:43,app:'generic',appName:'other'}]}), false, 'unknown foreground window also makes hook attribution ambiguous');
tracker.event(event('PermissionRequest'), proc);
eq(tracker.screen(codex, proc).status, 'waiting_permission', 'old idle screen cannot override permission event');
tracker.event(event('PostToolUse'), proc);
eq(tracker.screen(codex, proc).status, 'working', 'permission completed resumes work');
tracker.event(event('Stop'), proc);
eq(tracker.screen(codex, proc).status, 'unknown', 'Stop is pre-final, not immediately idle');
eq(tracker.screen([...codex, ' '], proc).status, 'idle', 'fresh idle frame confirms completion');
tracker.event(event('PreToolUse'), proc);
eq(tracker.screen(codex, proc).status, 'working', 'continuation resumes');
eq(tracker.screen(codex, { clis: [] }).isCodeCli, false, 'exit suppresses stale branded screen');
eq(tracker.screen(codex, { clis: [] }, 99999999).isCodeCli, false, 'stale banner cannot resurrect exited identity');
const ended = new CliTracker();
ended.event(event('SessionStart'),proc); ended.event(event('SessionEnd'),proc);
eq(ended.screen(codex,proc).isCodeCli,false,'SessionEnd stays hidden while process is still exiting');
eq(ended.event(event('Stop'),proc),false,'late Stop cannot reopen ended session');
ended.event(event('SessionStart',{sessionId:'new-session'}),proc);
eq(ended.state.isCodeCli,true,'new session on same CLI process is allowed');
eq(ended.event(event('UserPromptSubmit',{sessionId:'new-session',sentAt:Date.now()-60000}),proc),false,'stale event rejected');
const ignored = new CliTracker();
eq(ignored.event(event('Notification',{notificationType:'auth_success'}),proc),false,'unrelated notification ignored');
eq(ignored.screen(['user@host:~$ '],null).isCodeCli,false,'ignored event cannot bind a CLI and mislabel a shell');
eq(normalizeState({isCodeCli: true, app: 'bad'}).isCodeCli, false, 'wire identity validation');
eq(legacyState({isCodeCli: true, app: 'qoder', status: 'unknown'}).kind, 'unknown', 'unknown is not converted to waiting');

(async () => {
  const term = new TerminalState(100, 20, () => {});
  const flush = () => new Promise(resolve => term.snapshot(resolve));
  term.write('OpenAI Codex\r\n• Working (5s • esc to interrupt)\r\n');
  term.write('\x1b[2J\x1b[H' + codex.join('\r\n'));
  await flush();
  eq(detectScreen(term.readScreen()).status, 'idle', 'erased spinner does not survive parsed screen');
  term.write('\r\nuser@host:~$ '); await flush();
  eq(detectScreen(term.readScreen()).isCodeCli, false, 'shell after CLI clears screen identity');
  term.dispose();
  console.log(`PASS ${checks} CLI identity, negative screens, transitions, hook ownership and parsed redraw checks`);
})().catch(e => { console.error(e); process.exitCode = 1; });
