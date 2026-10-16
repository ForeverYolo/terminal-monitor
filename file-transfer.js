'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const MAX_FILE_SIZE = 200 * 1024 * 1024;
const CHUNK_SIZE = 256 * 1024;

function safeResolveAgainst(base, rel) {
  const resolved = path.resolve(base, rel || '.');
  const home = os.homedir();
  // Allow navigation anywhere under the user's home directory.
  if (resolved !== home && !resolved.startsWith(home + path.sep)) return null;
  return resolved;
}

function createFileTransfer({ send, getSocket, getShellCwd }) {
  const activeUploads = new Map();
  const activeDownloads = new Map();
  let closed = false;
  const sendMsg = msg => !closed && send(msg);
  // --- File transfer handlers ---
  async function handleFileMsg(msg) {
    try {
      if (msg.type === 'file_ls') return await handleFileLs(msg);
      if (msg.type === 'file_upload_start') return await handleUploadStart(msg);
      if (msg.type === 'file_chunk') return handleUploadChunk(msg);
      if (msg.type === 'file_upload_end') return handleUploadEnd(msg);
      if (msg.type === 'file_download_start') return await handleDownloadStart(msg);
    } catch (e) {
      console.error('[file] error:', e.message);
    }
  }

  async function handleFileLs(msg) {
    console.log('[file] file_ls start, dir=', msg.dir);
    const base = getShellCwd();
    const target = safeResolveAgainst(base, msg.dir || '.');
    if (!target) {
      sendMsg({ type: 'file_ls_result', agentId: msg.agentId, reqId: msg.reqId, dir: msg.dir || '', error: '路径超出允许范围（仅限 $HOME 内）' });
      return;
    }
    try {
      const entries = await fs.promises.readdir(target, { withFileTypes: true });
      const result = [];
      for (const ent of entries) {
        const full = path.join(target, ent.name);
        let size = 0, mtime = 0, isDir = ent.isDirectory();
        try {
          const st = await fs.promises.stat(full);
          size = st.size; mtime = st.mtimeMs; isDir = st.isDirectory();
        } catch { /* unreadable entry: include with zero stat */ }
        result.push({ name: ent.name, size, mtime, isDir });
      }
      result.sort((a, b) => (a.isDir === b.isDir) ? a.name.localeCompare(b.name) : (a.isDir ? -1 : 1));
      // Compute display path: relative to base when inside, else absolute
      let displayPath;
      if (target === base) displayPath = '.';
      else if (target.startsWith(base + path.sep)) displayPath = path.relative(base, target);
      else displayPath = target;
      console.log('[file] file_ls ok, cwd=', base, 'target=', target, 'n=', result.length);
      sendMsg({
        type: 'file_ls_result',
        agentId: msg.agentId,
        reqId: msg.reqId,
        dir: msg.dir || '',
        cwd: base,
        displayPath,
        entries: result
      });
    } catch (e) {
      sendMsg({ type: 'file_ls_result', agentId: msg.agentId, reqId: msg.reqId, dir: msg.dir || '', cwd: base, error: e.message });
    }
  }

  async function handleUploadStart(msg) {
    const filename = path.basename(msg.filename || '');   // strip any dir components
    if (!filename || filename === '.' || filename === '..') {
      sendMsg({ type: 'file_upload_ack', agentId: msg.agentId, uploadId: msg.uploadId, ok: false, error: 'Invalid filename' });
      return;
    }
    if (!Number.isFinite(msg.size) || msg.size <= 0 || msg.size > MAX_FILE_SIZE) {
      sendMsg({ type: 'file_upload_ack', agentId: msg.agentId, uploadId: msg.uploadId, ok: false, error: `Size out of range (max ${MAX_FILE_SIZE} bytes)` });
      return;
    }
    const base = getShellCwd();
    const target = safeResolveAgainst(base, filename);
    if (!target) {
      sendMsg({ type: 'file_upload_ack', agentId: msg.agentId, uploadId: msg.uploadId, ok: false, error: 'Invalid target path' });
      return;
    }
    try {
      const stream = fs.createWriteStream(target, { flags: 'w' });
      await new Promise((res, rej) => {
        stream.once('open', res);
        stream.once('error', rej);
      });
      if (closed) { stream.destroy(); return; }
      stream.removeAllListeners('error');
      stream.on('error', (e) => {
        if (activeUploads.get(msg.uploadId)?.stream !== stream) return;
        console.error('[file] upload stream error:', e.message);
        activeUploads.delete(msg.uploadId);
        try { stream.destroy(); } catch {}
        sendMsg({ type: 'file_upload_done', agentId: msg.agentId, uploadId: msg.uploadId, ok: false, error: e.message });
      });
      activeUploads.set(msg.uploadId, { stream, size: msg.size, received: 0, target });
      console.log(`[file] upload start: ${filename} (${msg.size} bytes) → ${target}`);
      sendMsg({ type: 'file_upload_ack', agentId: msg.agentId, uploadId: msg.uploadId, ok: true });
    } catch (e) {
      sendMsg({ type: 'file_upload_ack', agentId: msg.agentId, uploadId: msg.uploadId, ok: false, error: e.message });
    }
  }

  function handleUploadChunk(msg) {
    const up = activeUploads.get(msg.uploadId);
    if (!up) return;  // unknown / already finished — drop silently
    const buf = Buffer.from(msg.data || '', 'base64');
    if (up.received + buf.length > up.size) {
      activeUploads.delete(msg.uploadId); up.stream.destroy();
      sendMsg({ type: 'file_upload_done', agentId: msg.agentId, uploadId: msg.uploadId, ok: false, error: 'Upload exceeds declared size' });
      return;
    }
    up.received += buf.length;
    const ack = () => sendMsg({ type: 'file_chunk_ack', agentId: msg.agentId, uploadId: msg.uploadId, index: msg.index, received: up.received });
    if (up.stream.write(buf)) ack();
    else up.stream.once('drain', ack);
  }

  function handleUploadEnd(msg) {
    const up = activeUploads.get(msg.uploadId);
    if (!up) return;
    if (up.received !== up.size) {
      activeUploads.delete(msg.uploadId); up.stream.destroy();
      sendMsg({ type: 'file_upload_done', agentId: msg.agentId, uploadId: msg.uploadId, ok: false, error: 'Incomplete upload' });
      return;
    }
    up.stream.end(() => {
      console.log(`[file] upload done: ${path.basename(up.target)} (${up.received} bytes)`);
      activeUploads.delete(msg.uploadId);
      sendMsg({ type: 'file_upload_done', agentId: msg.agentId, uploadId: msg.uploadId, ok: true, savedPath: path.basename(up.target) });
    });
  }

  async function handleDownloadStart(msg) {
    const socket = getSocket();
    const rel = msg.path || '';
    const base = getShellCwd();
    const target = safeResolveAgainst(base, rel);
    if (!target) {
      sendMsg({ type: 'file_download_end', agentId: msg.agentId, downloadId: msg.downloadId, ok: false, error: 'Invalid path' });
      return;
    }
    let st;
    try {
      st = await fs.promises.stat(target);
    } catch (e) {
      sendMsg({ type: 'file_download_end', agentId: msg.agentId, downloadId: msg.downloadId, ok: false, error: e.message });
      return;
    }
    if (closed) return;
    if (st.isDirectory()) {
      sendMsg({ type: 'file_download_end', agentId: msg.agentId, downloadId: msg.downloadId, ok: false, error: 'Is a directory' });
      return;
    }
    if (st.size > MAX_FILE_SIZE) {
      sendMsg({ type: 'file_download_end', agentId: msg.agentId, downloadId: msg.downloadId, ok: false, error: `File too large (max ${MAX_FILE_SIZE} bytes)` });
      return;
    }
    const name = path.basename(target);
    const totalChunks = Math.max(1, Math.ceil(st.size / CHUNK_SIZE));
    const state = { rs: fs.createReadStream(target, { highWaterMark: CHUNK_SIZE }), aborted: false, index: 0 };
    activeDownloads.set(msg.downloadId, state);
    sendMsg({ type: 'file_download_meta', agentId: msg.agentId, downloadId: msg.downloadId, name, size: st.size, totalChunks });
    console.log(`[file] download start: ${name} (${st.size} bytes)`);

    state.rs.on('data', (chunk) => {
      if (state.aborted) return;
      // Pause until the ws send buffer drains — crude backpressure.
      const ok = sendMsg({
        type: 'file_download_chunk',
        agentId: msg.agentId,
        downloadId: msg.downloadId,
        index: state.index++,
        data: chunk.toString('base64')
      });
      if (!ok || socket.bufferedAmount > 4 * CHUNK_SIZE) {
        state.rs.pause();
        const resume = () => {
          if (state.aborted || closed) return;
          if (socket.readyState !== socket.OPEN) return dispose();
          if (socket.bufferedAmount <= 2 * CHUNK_SIZE) state.rs.resume();
          else state.timer = setTimeout(resume, 25);
        };
        state.timer = setTimeout(resume, 25);
      }
    });
    state.rs.on('end', () => {
      console.log(`[file] download done: ${name}`);
      clearTimeout(state.timer);
      activeDownloads.delete(msg.downloadId);
      sendMsg({ type: 'file_download_end', agentId: msg.agentId, downloadId: msg.downloadId, ok: true });
    });
    state.rs.on('error', (e) => {
      console.error('[file] download stream error:', e.message);
      state.aborted = true;
      clearTimeout(state.timer);
      activeDownloads.delete(msg.downloadId);
      sendMsg({ type: 'file_download_end', agentId: msg.agentId, downloadId: msg.downloadId, ok: false, error: e.message });
    });
  }


  function dispose() {
    closed = true;
    for (const up of activeUploads.values()) up.stream.destroy();
    activeUploads.clear();
    for (const dl of activeDownloads.values()) {
      dl.aborted = true;
      clearTimeout(dl.timer);
      dl.rs.destroy();
    }
    activeDownloads.clear();
  }
  return { handle: msg => closed ? Promise.resolve() : handleFileMsg(msg), dispose };
}
module.exports = { createFileTransfer };
