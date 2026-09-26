'use strict';

const { Terminal } = require('xterm-headless');
const { SerializeAddon } = require('xterm-addon-serialize');
const { createAltScreenFilter } = require('./terminal-filter');

// One ordered writer owns both the terminal model and the bytes sent to the
// server. Resize and snapshot operations wait for preceding writes to finish;
// subsequent output waits behind them. This preserves cursor and wrap state.
class TerminalState {
  constructor(cols, rows, emit) {
    this.term = new Terminal({ allowProposedApi: true, cols, rows, scrollback: 5000 });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.filter = createAltScreenFilter();
    this.emit = emit;
    this.pending = 0;
    this.blocked = false;
    this.waiting = [];
    this.draining = false;
    this.disposed = false;
  }

  write(raw) {
    if (this.disposed) return;
    if (this.blocked) { this.waiting.push(['write', raw]); return; }
    this.submitWrite(raw);
  }

  submitWrite(raw) {
    const bytes = this.filter(Buffer.from(raw));
    if (!bytes.length) return;
    this.pending++;
    this.term.write(bytes, () => {
      this.pending--;
      this.drain();
    });
    this.emit(Buffer.from(bytes).toString('base64'));
  }

  resize(cols, rows) {
    if (this.disposed) return;
    this.blocked = true;
    this.waiting.push(['resize', cols, rows]);
    this.drain();
  }

  snapshot(done) {
    if (this.disposed) return;
    this.blocked = true;
    this.waiting.push(['snapshot', done]);
    this.drain();
  }

  takeSnapshot(done) {
    let serialized = this.serializer.serialize();
    // Leave space for JSON/base64 within the server's 4 MB WS frame limit.
    for (let rows = 2500; Buffer.byteLength(serialized) > 2_000_000 && rows > 0; rows = rows <= 100 ? 0 : Math.floor(rows / 2)) {
      serialized = this.serializer.serialize({ scrollback: rows });
    }
    done(Buffer.byteLength(serialized) <= 2_000_000
      ? { payload: Buffer.from(serialized).toString('base64'), cols: this.term.cols, rows: this.term.rows }
      : { error: 'Viewport exceeds snapshot size limit' });
  }

  drain() {
    if (this.disposed || this.pending || this.draining) return;
    this.draining = true;
    try {
      while (this.waiting.length && !this.pending) {
        const [kind, ...args] = this.waiting.shift();
        if (kind === 'write') this.submitWrite(args[0]);
        else if (kind === 'resize') this.term.resize(args[0], args[1]);
        else this.takeSnapshot(args[0]);
      }
      if (!this.waiting.length && !this.pending) this.blocked = false;
    } finally {
      this.draining = false;
    }
  }

  dispose() {
    this.disposed = true;
    this.waiting = [];
    this.blocked = false;
    this.term.dispose();
  }
}

module.exports = { TerminalState };
