'use strict';
const assert = require('assert');
const { Terminal } = require('xterm-headless');
const { TerminalState } = require('../terminal-state');

const emitted = [];
const source = new TerminalState(40, 8, payload => emitted.push(Buffer.from(payload, 'base64')));
const writes = [
  '\x1b[?1049h\x1b[2J\x1b[H',
  ...Array.from({length: 28}, (_, i) => `history-${i}\r\n`),
  '\x1b[4;2H\x1b[31mRED\x1b[0m\x1b[K',
  '\x1b[3A\x1b[8Cmark',
];
for (const chunk of writes) source.write(chunk);
// Output arriving while serialization waits must be emitted after the snapshot.
let snapshot;
const ready = new Promise(resolve => source.snapshot(s => { snapshot = s; resolve(); }));
source.write('later-1\r\n');
source.write('later-2\r\n');

function write(term, bytes) { return new Promise(resolve => term.write(bytes, resolve)); }
function state(term) {
  const b = term.buffer.active;
  return {
    lines: Array.from({length: b.length}, (_, i) => b.getLine(i).translateToString(true)),
    x: b.cursorX, y: b.cursorY, baseY: b.baseY,
  };
}
(async () => {
  await ready;
  const restored = new Terminal({allowProposedApi: true, cols: snapshot.cols, rows: snapshot.rows, scrollback: 5000});
  await write(restored, Buffer.from(snapshot.payload, 'base64'));
  assert(state(restored).lines.some(line => line.includes('history-2')), 'snapshot lost historical lines');
  // Drain the two writes queued behind the serialization barrier.
  await new Promise(resolve => source.term.write('', resolve));
  const suffix = emitted.slice(writes.length);
  for (const bytes of suffix) await write(restored, bytes);
  assert.deepStrictEqual(state(restored), state(source.term), 'restored terminal diverged after relative updates');
  source.dispose(); restored.dispose();
  const resized = new TerminalState(5, 3, () => {});
  const ordered = new Terminal({allowProposedApi: true, cols: 5, rows: 3});
  resized.write('ABCDEF');
  resized.resize(10, 3); // Must wait until ABCDEF has wrapped at width 5.
  await write(ordered, 'ABCDEF');
  ordered.resize(10, 3);
  await new Promise(resolve => resized.snapshot(resolve));
  assert.deepStrictEqual(state(resized.term), state(ordered), 'resize overtook queued output');
  resized.dispose(); ordered.dispose();
  console.log('snapshot restore and continuation match');
})().catch(e => { console.error(e); process.exitCode = 1; });
