'use strict';

const { Terminal } = require('xterm-headless');
const { SerializeAddon } = require('xterm-addon-serialize');
const { createAltScreenFilter } = require('./terminal-filter');

// One ordered writer owns both the terminal model and the bytes sent to the
// server. Resize and snapshot operations wait for preceding writes to finish;
// subsequent output waits behind them. This preserves cursor and wrap state.
class TerminalState {
  constructor(cols, rows, emit, options = {}) {
    this.term = new Terminal({ allowProposedApi: true, cols, rows, scrollback: 5000 });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.filter = createAltScreenFilter(options);
    this.nativeTui = options.nativeTui === true;
    // SerializeAddon 0.11 restores tracking, but omits mouse encoding and
    // cursor visibility. Record parsed switches (including split sequences)
    // so a fresh browser uses the same protocol after a snapshot.
    this.privateModes = new Map();
    if (this.nativeTui) {
      // Tracking (1000/1002/1003) is mutually exclusive and is already
      // serialized from the effective terminal state by SerializeAddon.
      const tracked = new Set([25, 1004, 1005, 1006, 1007, 1015, 1016]);
      for (const [final, enabled] of [['h', true], ['l', false]]) {
        this.term.parser.registerCsiHandler({ prefix: '?', final }, params => {
          for (const mode of params) if (tracked.has(mode)) this.privateModes.set(mode, enabled);
          return false;
        });
      }
      this.term.parser.registerEscHandler({ final: 'c' }, () => {
        this.privateModes.clear();
        return false;
      });
    }
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
    const modes = [...this.privateModes].map(([mode, enabled]) => `\x1b[?${mode}${enabled ? 'h' : 'l'}`).join('');
    let serialized = this.serializer.serialize() + modes;
    // Leave space for JSON/base64 within the server's 4 MB WS frame limit.
    for (let rows = 2500; Buffer.byteLength(serialized) > 2_000_000 && rows > 0; rows = rows <= 100 ? 0 : Math.floor(rows / 2)) {
      serialized = this.serializer.serialize({ scrollback: rows }) + modes;
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
