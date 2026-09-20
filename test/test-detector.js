/**
 * Unit tests for claude-detector.js — pure, no I/O, no network.
 * Run: node test/test-detector.js
 */
'use strict';
const { detectClaudeState, stripAnsi } = require('../claude-detector');

let passed = 0, failed = 0;
function eq(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`); }
}

console.log('--- claude-detector unit tests ---');

// plain shell — no claude
const r1 = detectClaudeState('user@host:~$ ls\nfile1.txt\nuser@host:~$ ');
eq({ running: r1.running, kind: r1.kind }, { running: false, kind: 'none' }, 'plain shell → not claude');

// claude banner + idle prompt
const r2 = detectClaudeState('Welcome to Claude Code!\n> ');
eq({ running: r2.running, kind: r2.kind }, { running: true, kind: 'input' }, 'claude banner + > idle');

// yes/no
const r3 = detectClaudeState('Welcome to Claude Code!\n\nDo you want to commit these changes?\n  ❯ Yes\n    No\n');
eq({ running: r3.running, kind: r3.kind }, { running: true, kind: 'yesno' }, 'yes/no prompt detected');
eq(r3.prompt.includes('Do you want to commit'), true, 'yesno prompt text extracted');

// option list
const r4 = detectClaudeState('Welcome to Claude Code!\nPick strategy:\n  1. aggressive\n  2. conservative\n  3. hybrid\n');
eq({ running: r4.running, kind: r4.kind }, { running: true, kind: 'option' }, 'option list detected');
eq(r4.options.length, 3, 'option list has 3 items');
eq(r4.options[0].label, 'aggressive', 'option[0] label');

// spinner / working
const r5 = detectClaudeState('✻ Welcome to Claude Code!\n⠙ Thinking through the problem...\n');
eq({ running: r5.running, kind: r5.kind }, { running: true, kind: 'working' }, 'spinner detected');

// bash permission
const r6 = detectClaudeState('Welcome to Claude Code!\nAllow Claude to run: cat /etc/passwd ?\n(Y/n)');
eq({ running: r6.running, kind: r6.kind }, { running: true, kind: 'bash' }, 'bash permission detected');

// ANSI sequences stripped
const ansiText = '\x1b[32mWelcome to Claude Code!\x1b[0m\n\x1b[1mDo you want to proceed?\x1b[0m\n  \x1b[36m❯ Yes\x1b[0m\n    No';
const r7 = detectClaudeState(ansiText);
eq({ running: r7.running, kind: r7.kind }, { running: true, kind: 'yesno' }, 'ANSI yesno detected');

// empty input
const r8 = detectClaudeState('');
eq({ running: r8.running, kind: r8.kind }, { running: false, kind: 'none' }, 'empty input → none');

// null input
const r9 = detectClaudeState(null);
eq({ running: r9.running, kind: r9.kind }, { running: false, kind: 'none' }, 'null input → none');

// stripAnsi helper
const stripped = stripAnsi('\x1b[1;32mhello\x1b[0m \x1b]0;title\x07world');
eq(stripped, 'hello world', 'stripAnsi removes SGR + OSC');

// long output is truncated properly (no crash)
const big = ('Welcome to Claude Code!\n' + 'x'.repeat(50000) + '\n> ');
const r10 = detectClaudeState(big);
eq({ running: r10.running, kind: r10.kind }, { running: true, kind: 'input' }, 'large input handled');

console.log(`\n=== detector RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);

// ---------------- spawn validator tests ----------------
console.log('\n--- spawn validator unit tests ---');
const { validateSpawnRequest } = require('../spawn-validator');

function vEq(input, expectOk, msg) {
  const r = validateSpawnRequest(input);
  eq({ ok: r.ok }, { ok: expectOk }, msg);
}

vEq({ screenName: 'my-node-1', cmd: 'bash' }, true, 'valid name+cmd accepted');
vEq({ screenName: 'my_node', cmd: 'claude' }, true, 'underscore name accepted');
vEq({ screenName: 'a'.repeat(40), cmd: 'sh' }, true, '40-char name accepted');
vEq({ screenName: '', cmd: 'bash' }, false, 'empty name rejected');
vEq({ screenName: 'has space', cmd: 'bash' }, false, 'name with space rejected');
vEq({ screenName: 'a'.repeat(41), cmd: 'bash' }, false, '41-char name rejected');
vEq({ screenName: 'ok;rm', cmd: 'bash' }, false, 'name with shell chars rejected');
vEq({ screenName: 'ok', cmd: 'rm' }, false, 'cmd rm rejected');
vEq({ screenName: 'ok', cmd: '' }, true, 'empty cmd defaults to bash');
vEq({ screenName: 'ok', cmd: 'reboot' }, false, 'cmd reboot rejected');
vEq({ screenName: undefined, cmd: undefined }, false, 'undefined fields rejected');

console.log(`\n=== TOTAL: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
