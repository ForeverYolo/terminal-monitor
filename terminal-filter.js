'use strict';
// Screen owns the outer alternate buffer. Keep browser scrollback while
// preserving application mouse, cursor and graphics modes. One filter per PTY.
function createAltScreenFilter() {
  let pending = null;  // head of an escape sequence split across chunks
  let orphanTail = false;  // dropping a BEL-split title garbage tail across chunks
  let orphanCount = 0;
  const PENDING_MAX = 4096;  // safety cap: a real sequence never gets this long

  return function filter(bytes) {
    let data = bytes;
    if (pending && pending.length > 0) {
      // Cap guards against a corrupt stream keeping an unterminated sequence
      // alive forever: past the cap the held head is flushed as literal text
      // (the cap applies to the held bytes, never to the incoming chunk —
      // truncating pending+chunk would silently drop the chunk's tail).
      if (pending.length > PENDING_MAX) {
        data = new Uint8Array(pending.length + bytes.length);
        data.set(pending, 0);
        data.set(bytes, pending.length);
        pending = null;
      } else {
        const merged = new Uint8Array(pending.length + bytes.length);
        merged.set(pending, 0);
        merged.set(bytes, pending.length);
        data = merged;
        pending = null;
      }
    }
    const len = data.length;
    if (len === 0) return data;
    const result = new Uint8Array(len);
    let out = 0;
    let i = 0;
    while (i < len) {
      // GNU screen re-encodes claude's UTF-8 window titles into mojibake whose
      // payload contains embedded BEL (0x07).  xterm.js terminates the OSC at
      // that first BEL, and the remainder lands on the glass as literal text
      // (the "ýå\î"-style fragments at the bottom of the screen).  After we
      // drop a title OSC, the tail up to the next BEL is that garbage — drop it
      // too, but ONLY when it contains no ESC (real redraw data interleaves
      // between screen's title re-emits and must be kept).  State spans chunks.
      if (orphanTail) {
        if (data[i] === 0x07) { orphanTail = false; orphanCount = 0; }
        else if (++orphanCount > 256) { orphanTail = false; orphanCount = 0; }  // BEL lost: stop dropping
        i++;
        continue;
      }
      if (data[i] !== 0x1b) {
        result[out++] = data[i++];
        continue;
      }
      if (i + 1 >= len) {
        // Lone ESC as the last byte — could be the head of any sequence, so
        // hold it for the next chunk rather than letting it through bare.
        pending = data.slice(i);
        break;
      }
      // ESC [ = 0x1b 0x5b
      if (i + 1 < len && data[i + 1] === 0x5b) {
        // Locate the final byte (0x40-0x7e) that terminates the sequence.
        // 0x5b/0x5d ("[" / "]") are excluded: when a lone "ESC[" ends a chunk
        // and the next chunk begins with an OSC ("]2;..."), concatenation
        // yields "ESC[]2;..." — treating "]" as a CSI final byte would then
        // pass the rest of screen's mangled title through as literal text.
        let end = i + 2;
        while (end < len && (data[end] < 0x40 || data[end] > 0x7e || data[end] === 0x5b || data[end] === 0x5d)) end++;
        if (end >= len) {
          // Sequence runs past the end of this chunk — hold it and prepend to
          // the next chunk instead of passing a half sequence through.
          pending = data.slice(i);
          break;
        }
        // Remove only Screen's outer alternate-buffer switches, including
        // combined private-mode commands; retain all application modes.
        if (data[i + 2] === 0x3f && (data[end] === 0x68 || data[end] === 0x6c)) {
          const modes = String.fromCharCode(...data.slice(i + 3, end)).split(';');
          const kept = modes.filter(value => !['47', '1047', '1049'].includes(value));
          if (kept.length !== modes.length) {
            if (kept.length) {
              const replacement = `\x1b[?${kept.join(';')}${String.fromCharCode(data[end])}`;
              result.set(Uint8Array.from(replacement, c => c.charCodeAt(0)), out);
              out += replacement.length;
            }
            i = end + 1;
            continue;
          }
        }
        // ESC [ 3 J  = clear scrollback (0x1b 0x5b 0x33 0x4a)
        if (end === i + 3 && data[i + 2] === 0x33 && data[end] === 0x4a) {
          i = end + 1;
          continue;
        }
      }
      // ESC ] = OSC.  GNU screen re-encodes the multibyte spinner characters in
      // claude's window-title updates ("<spinner> Unfurling…") as mojibake whose
      // payload contains raw LF.  xterm.js aborts an OSC on LF, so the tail of
      // the payload lands on the glass as literal text (the "hbÑ"-style stair
      // fragments next to the spinner).  The web terminal has its own UI and
      // never uses the window title, so drop title updates (0/1/2) entirely and
      // pass every other OSC through untouched.
      if (data[i + 1] === 0x5d) {
        let end = i + 2;
        let term = -1;
        while (end < len) {
          if (data[end] === 0x07) { term = end + 1; break; }
          if (data[end] === 0x1b) {
            if (end + 1 >= len) { term = -1; break; }
            if (data[end + 1] === 0x5c) { term = end + 2; break; }
            // A bare ESC inside the payload aborts the OSC (xterm reprocesses
            // it) — end our skip there and let the loop handle the ESC.
            term = end;
            break;
          }
          end++;
        }
        if (term < 0) {
          // OSC runs past this chunk — hold it until the terminator arrives.
          pending = data.slice(i);
          break;
        }
        let d = i + 2;
        let num = '';
        while (d < end && data[d] >= 0x30 && data[d] <= 0x39) {
          num += String.fromCharCode(data[d]);
          d++;
        }
        if (num === '0' || num === '1' || num === '2') {
          i = term;
          // Belt-and-braces against GNU screen's BEL-split title re-emit (see
          // orphanTail above): the garbage tail following a dropped title OSC
          // runs up to the next BEL.  Drop it only when free of ESC — if an
          // ESC appears, the "tail" is interleaved real redraw data.
          if (i < len && data[i] !== 0x1b) {
            let j = i;
            let hasEsc = false;
            while (j < len && data[j] !== 0x07) {
              if (data[j] === 0x1b) { hasEsc = true; break; }
              j++;
            }
            if (!hasEsc) {
              if (j < len) {
                i = j + 1;               // tail complete: consumed through BEL
              } else {
                // Tail continues into the next chunk; stay in orphan mode.
                orphanTail = true;
                i = len;
              }
            }
          }
        } else {
          for (; i < term; i++) result[out++] = data[i];
        }
        continue;
      }
    result[out++] = data[i++];
  }
  return out === len ? data : result.slice(0, out);
  };
}


// GNU Screen 4.09 can request SGR reports on its display yet consume only the
// classic six-byte mouse reports on input. Convert at the PTY boundary, where
// bytes can stay binary instead of being UTF-8 encoded by the browser.
function encodeScreenInput(text) {
  const chunks = [];
  const pattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[M([\s\S]{3})|\x1b\[(\d+);(\d+);(\d+)M/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    chunks.push(Buffer.from(text.slice(offset, match.index)));
    if (match[5]) {
      const bytes = Array.from(match[5], c => c.charCodeAt(0));
      if (bytes.every(b => b <= 255)) chunks.push(Buffer.from([27, 91, 77, ...bytes]));
      offset = match.index + match[0].length;
      continue;
    }
    const urxvt = match[6] !== undefined;
    let button = Number(match[1] ?? match[6]) - (urxvt ? 32 : 0);
    let x = Number(match[2] ?? match[7]), y = Number(match[3] ?? match[8]);
    // The classic protocol cannot address beyond 223 cells. Wheel scrolling
    // does not need a precise point in this single-window Screen relay.
    if (button & 64) { x = Math.min(x, 223); y = Math.min(y, 223); }
    if (button >= 0 && button <= 223 && x >= 1 && x <= 223 && y >= 1 && y <= 223) {
      if (match[4] === 'm') button = (button & ~3) | 3;
      chunks.push(Buffer.from([27, 91, 77, button + 32, x + 32, y + 32]));
    }
    offset = match.index + match[0].length;
  }
  chunks.push(Buffer.from(text.slice(offset)));
  return Buffer.concat(chunks);
}

module.exports = { createAltScreenFilter, encodeScreenInput };
