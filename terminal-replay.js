'use strict';
const crypto = require('crypto');

function createTerminalReplay({ agents, terminals, browsers, terminalKey, limits }) {
  const { SCROLLBACK_INIT, SCROLLBACK_INIT_BYTES, SCROLLBACK_SEND_BATCH } = limits;
  function sendScrollbackReplay(ws, ainfo, done, sinceSeq) {
    const term = terminals.get(terminalKey(ainfo.attrs, ainfo.screen)) || { scrollback: [] };
    const binfo = browsers.get(ws);
    if (binfo) {
      if (!binfo.replaying) binfo.replaying = new Set();
      binfo.replaying.add(ainfo.id);
    }
    const finish = () => {
      if (!binfo) return;
      binfo.replaying.delete(ainfo.id);
      const queued = binfo.pendingLive && binfo.pendingLive.get(ainfo.id);
      if (binfo.pendingLive) binfo.pendingLive.delete(ainfo.id);
      if (queued && ws.readyState === ws.OPEN) {
        for (const p of queued) ws.send(p);
      }
    };

    // Resolve the replay window. Delta mode needs the FIRST buffered chunk's seq
    // to prove contiguity: if sinceSeq sits before it, trimmed history is missing
    // and xterm cannot prepend — fall back to 'tail': append whatever the buffer
    // still has onto the browser's existing content. Clearing (the old full
    // fallback) destroyed the browser's local history whenever the SERVER had
    // less than the browser remembered (server restart empties the buffer) —
    // that erased history instead of restoring it. A full clear is only correct
    // on a fresh (non-resume) connect.
    let start = 0, mode = 'full';
    if (Number.isFinite(sinceSeq) && sinceSeq > 0) {
      if (term.scrollback.length === 0) {
        // Buffer empty (server restarted / nothing buffered yet): the browser's
        // own history is the only copy left — keep it, send nothing.
        mode = 'tail';
      } else {
        const first = term.scrollback[0];
        if (first.seq <= sinceSeq) {
          // Buffer covers the gap: replay only chunks after sinceSeq.
          start = term.scrollback.length;
          while (start > 0 && term.scrollback[start - 1].seq > sinceSeq) start--;
          mode = 'delta';
        } else {
          // Gap not coverable: keep browser content, append our tail.
          mode = 'tail';
        }
      }
    }

    const total = term.scrollback.length;
    if (total === 0 || (mode === 'delta' && start >= total)) {
      // Empty buffer (or nothing after sinceSeq) still reports info+end:
      // browsers treat scrollback_end as "replay finished" to trigger their
      // post-connect repaint; with no end message a fresh session's terminal
      // would never get one.
      ws.send(JSON.stringify({ type: 'scrollback_info', agentId: ainfo.id, total: 0, loadedFrom: 0, hasMore: false, mode }));
      ws.send(JSON.stringify({ type: 'scrollback_end', agentId: ainfo.id, lastSeq: sinceSeq || null }));
      finish();
      done();
      return;
    }
    // Walk back from the most recent chunk, stopping at whichever limit —
    // chunk count or total bytes — is hit first. Bounded to at most
    // SCROLLBACK_INIT iterations, so this is a cheap, one-time scan. Delta mode
    // already fixed `start`; tail/full modes narrow the window by size.
    if (mode !== 'delta') {
      let bytes = 0, count = 0;
      let s = total;
      while (s > 0 && count < SCROLLBACK_INIT && bytes < SCROLLBACK_INIT_BYTES) {
        s--;
        bytes += term.scrollback[s].payload.length;
        count++;
      }
      start = s;
    }
    ws.send(JSON.stringify({ type: 'scrollback_info', agentId: ainfo.id, total, loadedFrom: start, hasMore: start > 0, mode }));
    let i = start;
    function sendBatch() {
      if (ws.readyState !== ws.OPEN) { finish(); done(); return; } // browser gone mid-replay
      const end = Math.min(i + SCROLLBACK_SEND_BATCH, total);
      for (; i < end; i++) {
        const chunk = term.scrollback[i];
        ws.send(JSON.stringify({ type: 'data', payload: chunk.payload, agentId: ainfo.id, seq: chunk.seq, filtered: chunk.filtered }));
      }
      if (i < total) {
        setImmediate(sendBatch);
        return;
      }
      // Final info: NO `mode` field. The browser clears on info.mode==='full'
      // — sending the mode again here wiped everything the replay had just
      // drawn (intermittent blank terminal until a lucky repaint restored it).
      // The first info already told the browser what to do; this one only
      // carries the final window position.
      ws.send(JSON.stringify({ type: 'scrollback_info', agentId: ainfo.id, total, loadedFrom: start, hasMore: start > 0 }));
      const lastSeq = total > 0 ? term.scrollback[total - 1].seq : (sinceSeq || null);
      ws.send(JSON.stringify({ type: 'scrollback_end', agentId: ainfo.id, lastSeq }));
      finish();
      done();
    }
    sendBatch();
  }

  const pendingSnapshots = new Map();
  function canReplayDelta(ainfo, sinceSeq) {
    const sb = ainfo.term.scrollback;
    return Number.isFinite(sinceSeq) && sinceSeq > 0 && sb.length > 0 &&
      sb[0].seq <= sinceSeq && sinceSeq <= sb[sb.length - 1].seq;
  }

  function sendSnapshotReplay(ws, ainfo, delayMs = 0) {
    const binfo = browsers.get(ws);
    if (!binfo || ainfo.ws.readyState !== ainfo.ws.OPEN) return;
    if (!binfo.replaying) binfo.replaying = new Set();
    binfo.replaying.add(ainfo.id);
    if (!binfo.activeSnapshots) binfo.activeSnapshots = new Map();
    const previous = binfo.activeSnapshots.get(ainfo.id);
    if (previous && pendingSnapshots.has(previous)) {
      clearTimeout(pendingSnapshots.get(previous).timer);
      clearTimeout(pendingSnapshots.get(previous).requestTimer);
      pendingSnapshots.delete(previous);
    }
    const reqId = crypto.randomUUID();
    binfo.activeSnapshots.set(ainfo.id, reqId);
    const fail = () => {
      const pending = pendingSnapshots.get(reqId);
      if (!pending) return;
      pendingSnapshots.delete(reqId);
      clearTimeout(pending.requestTimer);
      clearTimeout(pending.timer);
      binfo.activeSnapshots.delete(ainfo.id);
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'terminal_snapshot_error', agentId: ainfo.id, message: 'Snapshot timed out' }));
      binfo.replaying.delete(ainfo.id);
      if (binfo.pendingLive) binfo.pendingLive.delete(ainfo.id);
    };
    const timer = setTimeout(fail, 10000 + delayMs);
    const pending = { ws, ainfo, binfo, timer, requestTimer: null };
    pendingSnapshots.set(reqId, pending);
    const request = () => {
      if (!pendingSnapshots.has(reqId)) return;
      if (ainfo.ws.readyState !== ainfo.ws.OPEN) return fail();
      ainfo.ws.send(JSON.stringify({ type: 'terminal_snapshot_request', reqId }));
    };
    if (delayMs > 0) pending.requestTimer = setTimeout(request, delayMs);
    else request();
  }

  function validTerminalSize(cols, rows) {
    return Number.isInteger(cols) && Number.isInteger(rows) &&
      cols >= 1 && cols <= 400 && rows >= 1 && rows <= 200;
  }

  // The last browser that opens, resizes, or sends input owns this screen's PTY
  // size. A size change is followed by fresh snapshots for every watcher, so
  // nobody continues parsing old-size output at the new dimensions.
  function claimTerminalSize(ws, ainfo, cols, rows) {
    const binfo = browsers.get(ws);
    if (!binfo || !ainfo.snapshotV1) return false;
    if (!binfo.preferredSizes) binfo.preferredSizes = new Map();
    if (!binfo.lastSizeClaim) binfo.lastSizeClaim = new Map();
    if (validTerminalSize(cols, rows)) binfo.preferredSizes.set(ainfo.id, { cols, rows });
    const preferred = binfo.preferredSizes.get(ainfo.id);
    if (!preferred) return false;
    const term = ainfo.term;
    const changed = term.cols !== preferred.cols || term.rows !== preferred.rows;
    const ownerChanged = term.sizeOwner !== ws;
    term.sizeOwner = ws;
    binfo.lastSizeClaim.set(ainfo.id, Date.now());
    if (changed) {
      term.cols = preferred.cols;
      term.rows = preferred.rows;
      ainfo.ws.send(JSON.stringify({ type: 'resize', ...preferred }));
    }
    if (changed || ownerChanged) {
      for (const [bws, watching] of browsers) {
        if (!watching.agentIds.has(ainfo.id) || bws.readyState !== bws.OPEN) continue;
        bws.send(JSON.stringify({ type: 'terminal_size', agentId: ainfo.id,
          ...preferred, owner: bws === ws, snapshot: changed }));
        // GNU Screen and the TUI repaint asynchronously after SIGWINCH. When a
        // follower claims the size by typing, the input-triggered redraw must
        // reach the agent model before we freeze it for every browser.
        if (changed) sendSnapshotReplay(bws, ainfo, 250);
      }
    }
    return changed;
  }

  function releaseTerminalOwner(ws, agentIds) {
    for (const agentId of agentIds) {
      const ainfo = [...agents.values()].find(a => a.id === agentId);
      if (!ainfo || ainfo.term.sizeOwner !== ws) continue;
      ainfo.term.sizeOwner = null;
      let next = null, latest = -1;
      for (const [bws, binfo] of browsers) {
        if (bws === ws || bws.readyState !== bws.OPEN || !binfo.agentIds.has(agentId)) continue;
        const at = binfo.lastSizeClaim && binfo.lastSizeClaim.get(agentId) || 0;
        if (at > latest) { next = bws; latest = at; }
      }
      if (next) {
        const size = browsers.get(next).preferredSizes?.get(agentId);
        if (size) claimTerminalSize(next, ainfo, size.cols, size.rows);
      }
    }
  }


  function cancelSocket(socket) {
    for (const [id, pending] of pendingSnapshots) {
      if (pending.ws !== socket && pending.ainfo.ws !== socket) continue;
      clearTimeout(pending.timer); clearTimeout(pending.requestTimer);
      pending.binfo.activeSnapshots?.delete(pending.ainfo.id);
      pending.binfo.replaying?.delete(pending.ainfo.id);
      pending.binfo.pendingLive?.delete(pending.ainfo.id);
      pendingSnapshots.delete(id);
    }
  }
  return { sendScrollbackReplay, pendingSnapshots, canReplayDelta, sendSnapshotReplay, claimTerminalSize, releaseTerminalOwner, cancelSocket };
}
module.exports = { createTerminalReplay };
