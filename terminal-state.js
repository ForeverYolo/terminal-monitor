'use strict';

const { Terminal } = require('xterm-headless');
const { SerializeAddon } = require('xterm-addon-serialize');
const { createAltScreenFilter } = require('./terminal-filter');

// One ordered writer owns both the terminal model and the bytes sent to the
// server. During a snapshot, output and resizes wait behind the serialization
// barrier, so the server can use its last data seq as the exact snapshot anchor.
class TerminalState {
  constructor(cols, rows, emit) {
    this.term = new Terminal({ allowProposedApi: true, cols, rows, scrollback: 5000 });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.filter = createAltScreenFilter();
    this.emit = emit;
    this.pending = 0;
    this.paused = false;
    this.waiting = [];
    this.snapshotDone = null;
  }

  write(raw) {
    if (this.paused) { this.waiting.push(['write', raw]); return; }
    const bytes = this.filter(Buffer.from(raw));
    if (!bytes.length) return;
    this.pending++;
    this.term.write(bytes, () => {
      this.pending--;
      this.maybeSnapshot();
    });
    this.emit(Buffer.from(bytes).toString('base64'));
  }

  resize(cols, rows) {
    if (this.paused) { this.waiting.push(['resize', cols, rows]); return; }
    this.term.resize(cols, rows);
  }

  snapshot(done) {
    if (this.paused) { this.waiting.push(['snapshot', done]); return; }
    this.paused = true;
    this.snapshotDone = done;
    this.maybeSnapshot();
  }

  maybeSnapshot() {
    if (!this.paused || this.pending || !this.snapshotDone) return;
    const done = this.snapshotDone;
    this.snapshotDone = null;
    let serialized = this.serializer.serialize();
    // Leave space for JSON/base64 within the server's 4 MB WS frame limit.
    for (let rows = 2500; Buffer.byteLength(serialized) > 2_000_000 && rows > 0; rows = rows <= 100 ? 0 : Math.floor(rows / 2)) {
      serialized = this.serializer.serialize({ scrollback: rows });
    }
    done(Buffer.byteLength(serialized) <= 2_000_000
      ? { payload: Buffer.from(serialized).toString('base64'), cols: this.term.cols, rows: this.term.rows }
      : { error: 'Viewport exceeds snapshot size limit' });
    this.paused = false;
    const waiting = this.waiting;
    this.waiting = [];
    for (const [kind, ...args] of waiting) this[kind](...args);
  }

  dispose() {
    this.snapshotDone = null;
    this.waiting = [];
    this.paused = false;
    this.term.dispose();
  }
}

module.exports = { TerminalState };
