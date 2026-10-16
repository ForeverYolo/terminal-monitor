'use strict';

// Version 2 requires rendered snapshots, parser state and stable client identity.
const PROTOCOL_VERSION = 2;
function validSize(cols, rows) {
  return Number.isInteger(cols) && Number.isInteger(rows) &&
    cols >= 1 && cols <= 400 && rows >= 1 && rows <= 200;
}
function validParserState(state, cols, rows) {
  if (!state || !validSize(cols, rows)) return false;
  const { scrollTop, scrollBottom, cursorX, cursorY } = state;
  return [scrollTop, scrollBottom, cursorX, cursorY].every(Number.isInteger) &&
    scrollTop >= 0 && scrollTop <= scrollBottom && scrollBottom < rows &&
    cursorX >= 0 && cursorX <= cols && cursorY >= 0 && cursorY < rows;
}
module.exports = { PROTOCOL_VERSION, validSize, validParserState };
