// Shared terminal output filter: agent snapshot and browser legacy streams use identical rules.
'use strict';
// Virtualize the alternate screen so the browser can keep one scrollback
// buffer.  On exit, clear only the visible viewport (not scrollback) and reset
// SGR attributes; otherwise Claude's inverse-video notifications can remain on
// the shell prompt after the TUI exits.
//
// Each terminal stream needs its own filter instance (createAltScreenFilter).
// The filter is stateful: an escape sequence split across two WebSocket chunks
// is buffered until the rest arrives, then matched as a whole.  Without this,
// a split sequence misses the exact match and passes through unfiltered, and
// xterm switches buffers behind the TUI's back — every later incremental
// redraw then lands on the wrong canvas and overlays old frames.
// Private modes whose enable/disable switches we strip from the output stream:
// normal(1000), button(1002), any-motion(1003), focus(1004), utf8(1005),
// sgr(1006), alt-scroll(1007), urxvt(1015), sgtpix(1016).  xterm.js must never
// enter mouse/focus tracking: TUI apps (claude) that enable it expect the
// terminal to deliver events, but GNU screen between us and the app mangles
// SGR mouse sequences — the app then receives coordinate tails like "31;6M"
// as literal text.  With tracking suppressed, mouse actions stay native in
// the browser (selection, wheel scroll) and no event bytes are ever produced.
const MOUSE_REPORT_MODE = /^(100[0-7]|101[56])$/;

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
    // An 8-byte alt-screen exit is replaced by an 11-byte reset/clear/home
    // sequence.  Twice the input size safely covers multiple exits in a chunk.
    const result = new Uint8Array(len * 2 + 16);
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
        // ESC [ ? <mode> h/l — private mode switches.  Drop mouse/focus
        // reporting switches (see MOUSE_REPORT_MODE above) so tracking is
        // never enabled.  The enabling app simply never receives mouse bytes,
        // which is the safest steady state on this relayed link.
        if (data[i + 2] === 0x3f && (data[end] === 0x68 || data[end] === 0x6c)) {
          const mode = String.fromCharCode(...data.slice(i + 3, end));
          // Claude draws its text cursor as a one-cell reverse-video block and
          // also hides xterm's native cursor while the TUI is active.  Reverse
          // video is filtered below because it turns the virtual scrollback
          // into large background-colour blocks, so keep the native cursor
          // visible as a reliable replacement.  Convert every hide request to
          // show; the application still controls the cursor position.
          if (mode === '25' && data[end] === 0x6c) {
            result.set([0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x68], out);
            out += 6;
            i = end + 1;
            continue;
          }
          if (MOUSE_REPORT_MODE.test(mode)) {
            i = end + 1;
            continue;
          }
        }
        // ESC [ 3 J  = clear scrollback (0x1b 0x5b 0x33 0x4a)
        if (end === i + 3 && data[i + 2] === 0x33 && data[end] === 0x4a) {
          i = end + 1;
          continue;
        }
        // ESC [ ? 1049 h/l = alternate screen (1047 is the older variant).
        // Suppress entry to preserve scrollback.  When leaving, reset graphics
        // and erase only the viewport, which keeps history scrollable while
        // removing the temporary TUI/white inverse-video status blocks.
        if (end === i + 7 && data[i + 2] === 0x3f &&
            data[i + 3] === 0x31 && data[i + 4] === 0x30 && data[i + 5] === 0x34 &&
            (data[i + 6] === 0x39 || data[i + 6] === 0x37) &&
            (data[i + 7] === 0x68 || data[i + 7] === 0x6c)) {
          if (data[i + 7] === 0x6c) {
            // ESC[0m (reset SGR), ESC[2J (erase display), ESC[H (home).
            result.set([0x1b, 0x5b, 0x30, 0x6d, 0x1b, 0x5b, 0x32, 0x4a, 0x1b, 0x5b, 0x48], out);
            out += 11;
          }
          i = end + 1;
          continue;
        }

        // Claude uses reverse video and explicit ANSI background colours for
        // transient badges/status bars.  In the virtual main buffer these become
        // persistent white/red blocks in scrollback.  Keep text, foreground
        // colours and other attributes, but remove background-related SGR flags.
        if (data[end] === 0x6d) { // CSI ... m
          const params = String.fromCharCode(...data.slice(i + 2, end)).split(';');
        const kept = [];
        let changed = false;
        for (let p = 0; p < params.length; p++) {
          const value = params[p];
          // Do not mistake indexed/true-colour values (for example 38;5;7)
          // for the reverse-video flag.
          if (value === '48' || value.startsWith('48:') ||
              /^(4[0-9]|10[0-7])$/.test(value)) {
            // 40-49/100-107 are standard backgrounds; 48 is extended
            // background colour (48;5;n or 48;2;r;g;b).
            changed = true;
            if (value === '48') {
              if (params[p + 1] === '5') {
                p += Math.min(2, params.length - p - 1);
              } else if (params[p + 1] === '2') {
                p += Math.min(4, params.length - p - 1);
              }
            }
          } else if (value === '38' || value === '58') {
            kept.push(value);
            if (params[p + 1] === '5') {
              kept.push(params[++p]);
              if (p + 1 < params.length) kept.push(params[++p]);
            } else if (params[p + 1] === '2') {
              kept.push(params[++p]);
              for (let n = 0; n < 3 && p + 1 < params.length; n++) kept.push(params[++p]);
            }
          } else if (value === '7' || value === '27') {
            changed = true;
          } else {
            kept.push(value);
          }
        }
        if (changed && kept.length > 0) {
          result.set([0x1b, 0x5b], out);
          out += 2;
          for (let p = 0; p < kept.length; p++) {
            const value = kept[p];
            for (const ch of value) result[out++] = ch.charCodeAt(0);
            if (p < kept.length - 1) result[out++] = 0x3b;
          }
          result[out++] = 0x6d;
        } else if (!changed) {
          result.set(data.slice(i, end + 1), out);
          out += end + 1 - i;
        }
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


if (typeof module !== 'undefined' && module.exports) module.exports = { createAltScreenFilter };
