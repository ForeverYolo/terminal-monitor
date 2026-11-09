'use strict';

// Plain-text previews/transcripts only. CLI detection uses the parsed terminal
// screen instead: removing ANSI sequences cannot reconstruct a TUI viewport.
(function(root) {
  function stripAnsi(text) {
    if (!text) return '';
    return text
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
      .replace(/\x1b[@-Z\\-_]/g, '')
      .replace(/\r/g, '')
      .replace(/.\x08/g, '');
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { stripAnsi };
  else root.TerminalText = { stripAnsi };
})(globalThis);
