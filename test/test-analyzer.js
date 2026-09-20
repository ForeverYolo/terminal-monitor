/**
 * Supervisor analyzer state-machine test (mock, no real Claude).
 * Verifies: resolveAnalyzer → send prompt → extract <SUMMARY cycle=N> → broadcast.
 */
'use strict';
const { createSupervisor } = require('../supervisor');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg); }
}

// --- Mock agents ---
const MOCK_AGENTS = [
  { id: 'agent-1', name: 'overseer', screen: 'overseer', attrs: { clientId: 'C1' }, connectedAt: 't',
    needsInput: false, claudeState: { running: true, kind: 'input', prompt: '' }, lastLines: 'claude> ' },
  { id: 'agent-2', name: 'worker1', screen: 'w1', attrs: { clientId: 'C1' }, connectedAt: 't',
    needsInput: true, claudeState: { running: true, kind: 'yesno', prompt: 'Proceed?', options: [] }, lastLines: 'Proceed?' },
  { id: 'agent-3', name: 'shell1', screen: 's1', attrs: { clientId: 'C2' }, connectedAt: 't',
    needsInput: false, claudeState: null, lastLines: '$ ls' }
];

let rawOutputForAnalyzer = '';
const sentTo = [];
const broadcasts = [];

const sup = createSupervisor(
  { enabled: true, analyzerAgentName: 'overseer', analyzerInterval: 999, analyzerTimeout: 60 },
  {
    getAgents: () => MOCK_AGENTS,
    getAgentRawOutput: (id) => id === 'agent-1' ? rawOutputForAnalyzer : '',
    sendToAgent: (id, input) => { sentTo.push({ id, input }); return true; },
    sendToAgentObj: () => true,
    broadcastToBrowsers: (obj) => broadcasts.push(obj),
    requestAgentListScreens: () => Promise.resolve({ ok: true, screens: ['overseer'] })
  }
);

console.log('--- supervisor analyzer tests ---');

// Before raw output contains a SUMMARY, no llm_summary should broadcast.
// We drive one cycle where the analyzer hasn't answered yet.
rawOutputForAnalyzer = '';
sup.runAnalyzerCycleNow();
assert(sentTo.length === 1 && sentTo[0].id === 'agent-1', 'cycle 1: prompt sent to analyzer (agent-1)');
assert(/第 1 次集群巡检/.test(sentTo[0].input), 'cycle 1: prompt text includes cycle number');
assert(/worker1/.test(sentTo[0].input), 'cycle 1: snapshot includes Claude agent worker1');
assert(/<SUMMARY cycle="1">/.test(sentTo[0].input), 'cycle 1: prompt tells analyzer the SUMMARY marker format');
// No SUMMARY in output yet → no llm_summary broadcast (the immediate watch tick found nothing)
const noSummaryYet = broadcasts.filter(b => b.event && b.event.type === 'llm_summary');
assert(noSummaryYet.length === 0, 'cycle 1: no llm_summary broadcast yet (analyzer silent)');

// Now simulate the analyzer having produced its answer in its terminal output.
// Give the watcher a tick (the immediate tick already ran; force another by waiting for the interval)
rawOutputForAnalyzer = 'some reasoning...\n<SUMMARY cycle="1">进展顺利。\n建议：\n- worker1: 等待确认</SUMMARY>\n';
// The watcher runs on a 3s interval. Trigger a re-evaluation by calling cycle again is guarded by phase.
// Instead, wait briefly for one interval tick.
setTimeout(() => {
  const summaries = broadcasts.filter(b => b.event && b.event.type === 'llm_summary');
  assert(summaries.length === 1, 'cycle 1: llm_summary broadcast after analyzer answered');
  if (summaries[0]) {
    assert(/进展顺利/.test(summaries[0].event.summary), 'cycle 1: extracted summary content correct');
    assert(summaries[0].event.cycle === 1, 'cycle 1: event carries cycle number');
  }

  // --- Safety net test: analyzer raises a bash permission prompt → denied ---
  sentTo.length = 0;
  MOCK_AGENTS[0].claudeState = { running: true, kind: 'bash', prompt: 'Allow Claude to run rm?' };
  rawOutputForAnalyzer = '';   // no SUMMARY → watcher stays in reading phase... but it already stopped.
  // Restart a cycle to re-arm the watcher, then on its first tick it should deny the bash prompt.
  sup.runAnalyzerCycleNow();
  // Immediate watch tick: kind==='bash' → send 'n\r' (deny)
  const deny = sentTo.find(s => s.input === 'n\r');
  assert(!!deny, 'cycle 2: bash permission prompt auto-denied with n\\r (safety net)');

  console.log(`\n=== analyzer RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}, 3200);
