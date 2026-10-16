'use strict';

// --- File transfer state ---
const FILE_CHUNK_SIZE = 256 * 1024;   // 256KB raw per chunk (must match client)
let fileBrowserCwd = '';               // current dir in file browser (relative to fileRoot)
let fileBrowserAgentId = null;         // which agent the open file-browser targets
let pendingUpload = null;              // { file, uploadId, index, acked, chunks, sentBytes }
let activeDownload = null;             // { downloadId, name, size, totalChunks, chunks: [], received: 0 }
const fileReqQueue = [];               // outstanding reqIds for ls requests (to validate)
let fileReqCounter = 0;

// ========== File Transfer ==========

// Hidden file input change handler — agentId captured at click time (see onUploadClickFor).
document.getElementById('file-input').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';   // reset so selecting the same file again re-fires change
  if (f && pendingUploadAgentId) {
    startUpload(f, pendingUploadAgentId);
    pendingUploadAgentId = null;
  }
});

let pendingUploadAgentId = null;   // stashes agentId between upload-button click and file-picker callback

function onUploadClickFor(agentId) {
  if (!agentId || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (pendingUpload || activeDownload) { flashToast('请等当前传输完成'); return; }
  pendingUploadAgentId = agentId;
  document.getElementById('file-input').click();
}

function startUpload(file, agentId) {
  if (!agentId) return;
  if (pendingUpload || activeDownload) { flashToast('请等当前传输完成'); return; }
  const uploadId = 'up-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  pendingUpload = {
    file,
    uploadId,
    agentId,
    index: 0,
    acked: false,
    pumping: false,
    totalChunks: Math.max(1, Math.ceil(file.size / FILE_CHUNK_SIZE)),
    sentBytes: 0,
    totalBytes: file.size
  };
  showFileProgress('上传: ' + file.name, 0, '准备中…');
  ws.send(JSON.stringify({
    type: 'file_upload_start',
    agentId,
    uploadId,
    filename: file.name,
    size: file.size
  }));
}

// Stream chunks once the client acked the start.
// Continuous send, throttled by ws.bufferedAmount to avoid saturating the socket.
// file_chunk_ack messages only update progress — they don't drive the pump.
async function pumpUploadChunks() {
  if (!pendingUpload || !pendingUpload.acked || pendingUpload.pumping) return;
  const up = pendingUpload;
  up.pumping = true;
  try {
    while (up.index < up.totalChunks && pendingUpload === up) {
      // Backpressure: if the socket buffer is large, wait for it to drain.
      if (ws && ws.bufferedAmount > 2 * FILE_CHUNK_SIZE) {
        await new Promise(r => setTimeout(r, 30));
        continue;
      }
      const startByte = up.index * FILE_CHUNK_SIZE;
      const endByte = Math.min(startByte + FILE_CHUNK_SIZE, up.totalBytes);
      const slice = up.file.slice(startByte, endByte);
      const buf = await sliceToArrayBuffer(slice);
      up.index++;
      up.sentBytes = endByte;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        showFileProgress('上传中断: ' + up.file.name, 0, '连接已断开', 'error');
        pendingUpload = null;
        return;
      }
      ws.send(JSON.stringify({
        type: 'file_chunk',
        agentId: up.agentId,
        uploadId: up.uploadId,
        index: up.index - 1,
        data: arrayBufferToBase64(buf)
      }));
      updateFileProgress(up.sentBytes, up.totalBytes, '上传中…');
    }
    // All chunks sent — tell client to finalize.
    if (pendingUpload === up) {
      ws.send(JSON.stringify({ type: 'file_upload_end', agentId: up.agentId, uploadId: up.uploadId }));
    }
  } catch (e) {
    showFileProgress('上传失败: ' + up.file.name, 0, e.message || 'error', 'error');
    pendingUpload = null;
  } finally {
    up.pumping = false;
  }
}

function sliceToArrayBuffer(slice) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(fr.error || new Error('read error'));
    fr.readAsArrayBuffer(slice);
  });
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// --- File browser ---
function openFileBrowserFor(agentId) {
  if (!agentId || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (pendingUpload || activeDownload) { flashToast('请等当前传输完成'); return; }
  fileBrowserAgentId = agentId;
  fileBrowserCwd = '';
  document.getElementById('file-modal').classList.add('show');
  requestFileLs('');
}

function closeFileBrowser() {
  document.getElementById('file-modal').classList.remove('show');
  fileBrowserAgentId = null;
}

function fileBrowserUp() {
  if (!fileBrowserCwd) return;   // already at root
  const parts = fileBrowserCwd.split('/').filter(Boolean);
  parts.pop();
  fileBrowserCwd = parts.join('/');
  requestFileLs(fileBrowserCwd);
}

function requestFileLs(dir) {
  if (!fileBrowserAgentId) return;
  const reqId = 'ls-' + (++fileReqCounter);
  ws.send(JSON.stringify({ type: 'file_ls', agentId: fileBrowserAgentId, reqId, dir }));
  document.getElementById('file-modal-cwd').textContent = '/ ' + (dir || '');
  const list = document.getElementById('file-modal-list');
  list.innerHTML = '<div class="file-entry" style="color:#6e7681;">加载中…</div>';
}

function shortenHome(p) {
  // Display helper: replace /home/<user> with ~ for readability.
  if (!p) return p;
  const m = p.match(/^\/home\/[^/]+/);
  return m ? '~' + p.slice(m[0].length) : p;
}

function renderFileLsResult(msg) {
  if (msg.error) {
    document.getElementById('file-modal-list').innerHTML =
      '<div class="file-entry" style="color:#f85149;">无法打开: ' + escapeHtml(msg.error) + '</div>';
    return;
  }
  fileBrowserCwd = msg.dir || '';
  // Modal header shows the actual shell cwd; the path row shows where we are *within* it.
  const titleEl = document.querySelector('.file-modal-title');
  if (titleEl) titleEl.textContent = '📁 ' + shortenHome(msg.cwd || '');
  const display = msg.displayPath || fileBrowserCwd || '.';
  document.getElementById('file-modal-cwd').textContent = shortenHome((msg.cwd ? msg.cwd + '/' : '') + display).replace(/\/$/, '') || '~';
  const upBtn = document.getElementById('file-up-btn');
  upBtn.style.visibility = fileBrowserCwd ? 'visible' : 'hidden';
  const list = document.getElementById('file-modal-list');
  list.innerHTML = '';
  const entries = msg.entries || [];
  if (entries.length === 0) {
    list.innerHTML = '<div class="file-entry" style="color:#6e7681;">（空文件夹）</div>';
    return;
  }
  for (const ent of entries) {
    const row = document.createElement('div');
    row.className = 'file-entry' + (ent.isDir ? ' is-dir' : '');
    row.innerHTML =
      '<span class="fe-icon">' + (ent.isDir ? '📁' : '📄') + '</span>' +
      '<span class="fe-name">' + escapeHtml(ent.name) + '</span>' +
      '<span class="fe-size">' + (ent.isDir ? '' : humanSize(ent.size)) + '</span>';
    row.onclick = () => {
      if (ent.isDir) {
        const next = fileBrowserCwd ? fileBrowserCwd + '/' + ent.name : ent.name;
        requestFileLs(next);
      } else {
        startDownload(fileBrowserCwd ? fileBrowserCwd + '/' + ent.name : ent.name, ent.name, ent.size, fileBrowserAgentId);
      }
    };
    list.appendChild(row);
  }
}

function startDownload(relPath, displayName, knownSize, agentId) {
  if (!agentId) return;
  if (pendingUpload || activeDownload) { flashToast('请等当前传输完成'); return; }
  const downloadId = 'dl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  activeDownload = {
    downloadId,
    agentId,
    name: displayName || relPath.split('/').pop(),
    size: knownSize || 0,
    totalChunks: 0,
    chunks: [],
    received: 0
  };
  showFileProgress('下载: ' + activeDownload.name, 0, '准备中…');
  ws.send(JSON.stringify({
    type: 'file_download_start',
    agentId,
    downloadId,
    path: relPath
  }));
}

function humanSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

// --- Progress overlay ---
function showFileProgress(name, pct, status, cls) {
  const box = document.getElementById('file-progress');
  box.classList.remove('success', 'error');
  if (cls) box.classList.add(cls);
  box.classList.add('show');
  document.getElementById('file-progress-name').textContent = name;
  document.getElementById('file-progress-fill').style.width = pct + '%';
  document.getElementById('file-progress-status').textContent = status || '';
}
function updateFileProgress(done, total, status) {
  const pct = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0;
  document.getElementById('file-progress-fill').style.width = pct + '%';
  if (status) document.getElementById('file-progress-status').textContent = status;
}
function hideFileProgress() {
  document.getElementById('file-progress').classList.remove('show');
}

// --- Toast (quick non-blocking feedback) ---
let toastTimer = null;
function flashToast(msg, kind) {
  const el = document.getElementById('toast');
  el.classList.remove('error', 'warn');
  if (kind === 'error' || kind === 'warn') el.classList.add(kind);
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

  function handleFileMsg(msg) {
    if (msg.type === 'file_ls_result') {
      renderFileLsResult(msg);
      return;
    }
    if (msg.type === 'file_upload_ack') {
      if (pendingUpload && pendingUpload.uploadId === msg.uploadId) {
        if (msg.ok) {
          pendingUpload.acked = true;
          pumpUploadChunks();
        } else {
          showFileProgress('上传被拒: ' + pendingUpload.file.name, 0, msg.error || 'rejected', 'error');
          pendingUpload = null;
        }
      }
      return;
    }
    if (msg.type === 'file_chunk_ack') {
      // Progress-only signal from client; the pump runs independently.
      if (pendingUpload && pendingUpload.uploadId === msg.uploadId) {
        updateFileProgress(msg.received, pendingUpload.totalBytes, '上传中…');
      }
      return;
    }
    if (msg.type === 'file_upload_done') {
      if (pendingUpload && pendingUpload.uploadId === msg.uploadId) {
        if (msg.ok) {
          showFileProgress('上传完成: ' + pendingUpload.file.name, 100,
            '已保存' + (msg.savedPath ? ' → ' + msg.savedPath : ''), 'success');
          setTimeout(hideFileProgress, 3000);
        } else {
          showFileProgress('上传失败: ' + pendingUpload.file.name, 0, msg.error || 'failed', 'error');
        }
        pendingUpload = null;
      }
      return;
    }
    if (msg.type === 'file_download_meta') {
      if (activeDownload && activeDownload.downloadId === msg.downloadId) {
        activeDownload.size = msg.size;
        activeDownload.totalChunks = msg.totalChunks;
        activeDownload.chunks = new Array(msg.totalChunks);
        updateFileProgress(0, msg.size, '下载中… 0 / ' + humanSize(msg.size));
      }
      return;
    }
    if (msg.type === 'file_download_chunk') {
      if (activeDownload && activeDownload.downloadId === msg.downloadId) {
        activeDownload.chunks[msg.index] = msg.data;
        activeDownload.received++;
        const bytes = Math.min((msg.index + 1) * FILE_CHUNK_SIZE, activeDownload.size);
        updateFileProgress(bytes, activeDownload.size, '下载中… ' + humanSize(bytes) + ' / ' + humanSize(activeDownload.size));
      }
      return;
    }
    if (msg.type === 'file_download_end') {
      if (activeDownload && activeDownload.downloadId === msg.downloadId) {
        if (msg.ok) {
          // Assemble base64 chunks into a Blob and trigger download.
          const parts = [];
          for (let i = 0; i < activeDownload.chunks.length; i++) {
            const b64 = activeDownload.chunks[i];
            if (!b64) continue;
            parts.push(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
          }
          const blob = new Blob(parts, { type: 'application/octet-stream' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = activeDownload.name;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
          showFileProgress('下载完成: ' + activeDownload.name, 100, '已保存到浏览器下载目录', 'success');
          setTimeout(hideFileProgress, 3000);
        } else {
          showFileProgress('下载失败: ' + activeDownload.name, 0, msg.error || 'failed', 'error');
        }
        activeDownload = null;
      }
      return;
    }
  }
