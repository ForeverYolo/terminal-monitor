'use strict';
const crypto = require('crypto');
const { validSize } = require('./terminal-protocol');

function createTerminalReplay({ agents, browsers, batchSize = 200 }) {
  const replayTokens = new WeakMap();
  const pendingSnapshots = new Map();
  function beginReplay(ws, ainfo) {
    const binfo = browsers.get(ws);
    if (!binfo) return;
    let tokens = replayTokens.get(ws);
    if (!tokens) replayTokens.set(ws, tokens = new Map());
    const token = {};
    tokens.set(ainfo.id, token);
    if (!binfo.replaying) binfo.replaying = new Set();
    binfo.replaying.add(ainfo.id);
    if (!binfo.activeSnapshots) binfo.activeSnapshots = new Map();
    const previous = binfo.activeSnapshots.get(ainfo.id);
    const pending = pendingSnapshots.get(previous);
    if (pending) {
      clearTimeout(pending.timer); clearTimeout(pending.requestTimer);
      pendingSnapshots.delete(previous);
    }
    binfo.activeSnapshots.delete(ainfo.id);
    binfo.pendingLive?.delete(ainfo.id);
    return { binfo, current: () => replayTokens.get(ws)?.get(ainfo.id) === token };
  }
  // Capture a contiguous delta before yielding: cache trimming during a batch
  // must not move its indices. New live frames wait until this replay ends.
  function sendDeltaReplay(ws, ainfo, sinceSeq) {
    const chunks = ainfo.term.scrollback.filter(chunk => chunk.seq > sinceSeq);
    const replay = beginReplay(ws, ainfo);
    if (!replay) return;
    const { binfo, current } = replay;
    let i = 0;
    function sendBatch() {
      if (!current()) return;
      if (ws.readyState !== ws.OPEN || !binfo.agentIds.has(ainfo.id)) return finish();
      const end = Math.min(i + batchSize, chunks.length);
      for (; i < end; i++) ws.send(JSON.stringify({ type: 'data', ...chunks[i], agentId: ainfo.id }));
      if (i < chunks.length) return setImmediate(sendBatch);
      ws.send(JSON.stringify({ type: 'terminal_ready', agentId: ainfo.id,
        lastSeq: chunks.at(-1)?.seq || sinceSeq }));
      finish();
    }
    function finish() {
      if (!current()) return;
      binfo.replaying.delete(ainfo.id);
      const queued = binfo.pendingLive?.get(ainfo.id);
      binfo.pendingLive?.delete(ainfo.id);
      if (queued && ws.readyState === ws.OPEN && binfo.agentIds.has(ainfo.id)) {
        for (const frame of queued) ws.send(frame);
      }
    }
    sendBatch();
  }

  function canReplayDelta(ainfo, sinceSeq) {
    const sb = ainfo.term.scrollback;
    return Number.isFinite(sinceSeq) && sinceSeq > 0 && sb.length > 0 &&
      sb[0].seq <= sinceSeq && sinceSeq <= sb[sb.length - 1].seq;
  }

  function sendSnapshotReplay(ws, ainfo, delayMs = 0) {
    if (ainfo.ws.readyState !== ainfo.ws.OPEN) return;
    const replay = beginReplay(ws, ainfo);
    if (!replay) return;
    const { binfo } = replay;
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

  // The last browser that opens, resizes, or sends input owns this screen's PTY
  // size. A size change is followed by fresh snapshots for every watcher, so
  // nobody continues parsing old-size output at the new dimensions.
  function claimTerminalSize(ws, ainfo, cols, rows) {
    const binfo = browsers.get(ws);
    if (!binfo) return false;
    if (!binfo.preferredSizes) binfo.preferredSizes = new Map();
    if (!binfo.lastSizeClaim) binfo.lastSizeClaim = new Map();
    if (validSize(cols, rows)) binfo.preferredSizes.set(ainfo.id, { cols, rows });
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

  function subscribe(ws, ainfo, { cols, rows, resume, sinceSeq }) {
    if (claimTerminalSize(ws, ainfo, cols, rows)) return;
    if (resume && canReplayDelta(ainfo, sinceSeq)) sendDeltaReplay(ws, ainfo, sinceSeq);
    else sendSnapshotReplay(ws, ainfo);
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
    replayTokens.delete(socket);
    for (const [id, pending] of pendingSnapshots) {
      if (pending.ws !== socket && pending.ainfo.ws !== socket) continue;
      clearTimeout(pending.timer); clearTimeout(pending.requestTimer);
      pending.binfo.activeSnapshots?.delete(pending.ainfo.id);
      pending.binfo.replaying?.delete(pending.ainfo.id);
      pending.binfo.pendingLive?.delete(pending.ainfo.id);
      pendingSnapshots.delete(id);
    }
  }
  return { subscribe, pendingSnapshots, claimTerminalSize, releaseTerminalOwner, cancelSocket };
}
module.exports = { createTerminalReplay };
