'use strict';

// ========== Dashboard ==========

function renderAgents(agents) {
  if (agents) agents.sort((a, b) => {
    // Pinned agents always sort first (regardless of currentSort)
    const pa = isPinned(a.id) ? 1 : 0, pb = isPinned(b.id) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    if (currentSort === 'id') {
      return (a.id || '').localeCompare(b.id || '');
    }
    if (currentSort === 'recent') {
      const ra = getRecentTime(a.id), rb = getRecentTime(b.id);
      if (rb !== ra) return rb - ra; // most recent first
    }
    // default: by name, then screen
    const cmp = (a.name || '').localeCompare(b.name || '');
    return cmp !== 0 ? cmp : (a.screen || '').localeCompare(b.screen || '');
  });
  const c = document.getElementById('agent-list');
  if (!agents || !agents.length) {
    c.innerHTML = '<div class="no-agents">No machines online</div>';
    return;
  }
  c.innerHTML = agents.map(a => {
    const s = a.sys || {};
    const tags = (a.attrs && a.attrs.tags) ? a.attrs.tags : [];
    const ip = s.ips && s.ips.length ? s.ips.map(i => i.addr).join(', ') : '-';
    const memPct = s.memTotal ? Math.round(s.memUsed / s.memTotal * 100) : 0;
    const memColor = memPct > 85 ? '#ff6b6b' : memPct > 60 ? '#f0a500' : '#4caf50';
    const memBar = s.memTotal ? `<div class="bar-label"><span>Memory</span><span>${s.memUsed}/${s.memTotal} MB (${memPct}%)</span></div><div class="bar-wrap"><div class="bar-fill" style="width:${memPct}%;background:${memColor}"></div></div>` : '';
    const diskBar = s.diskPercent ? `<div class="bar-label"><span>Disk</span><span>${s.diskUsed}/${s.diskTotal} (${s.diskPercent})</span></div><div class="bar-wrap"><div class="bar-fill" style="width:${parseInt(s.diskPercent)}%;background:${parseInt(s.diskPercent)>85?'#ff6b6b':'#4caf50'}"></div></div>` : '';
    const gpuHtml = s.gpu && s.gpu.length ? `<div class="gpu-list">${s.gpu.map(g => `<div class="gpu-item">GPU: ${g}</div>`).join('')}</div>` : '';
    const loadStr = s.loadAvg ? s.loadAvg.join(' / ') : '';
    const uptimeStr = s.uptime ? fmtUptime(s.uptime) : '';
    const tagHtml = tags.length ? `<div class="tags">${tags.map(t => `<span class="tag">${t}</span>`).join('')}</div>` : '';
    const dotClass = a.needsInput ? 'idle' : 'busy';
    const dotTitle = a.needsInput ? '等待输入' : '运行中';
    const statusHtml = a.lastLines ? `<div class="status-row"><div class="status-dot ${dotClass}" title="${dotTitle}"></div><div class="status-text">${escapeHtml(a.lastLines.split('\n').pop())}</div></div>` : '';

    // Claude state badge
    const cs = a.claudeState;
    const claudeBadgeHtml = (cs && cs.running) ? `<div><span class="claude-badge kind-${cs.kind}" title="${escapeHtml(cs.prompt||'')}">claude:${cs.kind}${cs.prompt ? ' — ' + escapeHtml(cs.prompt.substring(0,50)) : ''}</span></div>` : '';

    // Multi-select mode adds checkbox
    const isSelected = selectedAgents.has(a.id);
    const checkboxHtml = currentMode === 'multi' ? `<input type="checkbox" class="card-checkbox" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation(); toggleAgentSelect('${a.id}')">` : '';
    const cardClass = `agent-card${currentMode === 'multi' ? ' selectable' : ''}${isSelected ? ' selected' : ''}${attentionAgents.has(a.id) ? ' attention' : ''}`;
    const clickHandler = currentMode === 'multi' ? `toggleAgentSelect('${a.id}')` : `openTerminal('${a.id}','${a.name.replace(/'/g,"\\'")}')`;

    return `<div class="${cardClass}" onclick="${clickHandler}">
      ${checkboxHtml}
      <div class="name-row"><div class="name"><button class="pin-btn ${isPinned(a.id) ? 'pinned' : ''}" onclick="event.stopPropagation(); togglePin('${a.id}')" title="置顶">⭐</button>${a.name}</div>${a.screen ? `<span class="screen-badge">screen: ${a.screen}</span>` : ''}</div>
      <div class="hostname">${s.hostname||''} &middot; ${s.username||''}@${ip}</div>
      <div class="info-grid">
        ${s.os ? `<div class="info-item">OS: <span>${s.os}</span></div>` : ''}
        ${s.cpu ? `<div class="info-item">CPU: <span>${s.cpuCount}x ${s.cpu.substring(0,30)}</span></div>` : ''}
        ${loadStr ? `<div class="info-item">Load: <span>${loadStr}</span></div>` : ''}
        ${uptimeStr ? `<div class="info-item">Uptime: <span>${uptimeStr}</span></div>` : ''}
      </div>
      ${memBar}${diskBar}${gpuHtml}${tagHtml}${statusHtml}${claudeBadgeHtml}
    </div>`;
  }).join('');

  // Update multi-select bar
  if (currentMode === 'multi') {
    document.getElementById('dash-multi-count').textContent = `已选 ${selectedAgents.size} 台`;
    document.getElementById('dash-multi-open').disabled = selectedAgents.size === 0;
  }
}

function fmtUptime(s) {
  const d = Math.floor(s/86400), h = Math.floor(s%86400/3600);
  if (d > 0) return `${d}d ${h}h`;
  return `${h}h ${Math.floor(s%3600/60)}m`;
}

// ========== Sort ==========

// Track recently opened agents (persisted in localStorage)
function getRecentTime(agentId) {
  const map = JSON.parse(localStorage.getItem('swt-recent') || '{}');
  return map[agentId] || 0;
}

function markRecent(agentId) {
  const map = JSON.parse(localStorage.getItem('swt-recent') || '{}');
  map[agentId] = Date.now();
  localStorage.setItem('swt-recent', JSON.stringify(map));
}

// Pinned agents (favorites) — persisted in localStorage, sorted first
function isPinned(agentId) {
  const arr = JSON.parse(localStorage.getItem('swt-pinned') || '[]');
  return arr.indexOf(agentId) !== -1;
}
function togglePin(agentId) {
  let arr = JSON.parse(localStorage.getItem('swt-pinned') || '[]');
  if (arr.indexOf(agentId) === -1) arr.push(agentId);
  else arr = arr.filter(x => x !== agentId);
  localStorage.setItem('swt-pinned', JSON.stringify(arr));
  renderAgents(lastAgents);
}

// Sort switch buttons
document.querySelectorAll('#sort-switch button').forEach(btn => {
  btn.addEventListener('click', () => {
    currentSort = btn.dataset.sort;
    localStorage.setItem('swt-sort', currentSort);
    document.querySelectorAll('#sort-switch button').forEach(b => {
      b.classList.toggle('active', b.dataset.sort === currentSort);
    });
    renderAgents(lastAgents);
  });
});
// Set initial active state from saved sort
document.querySelectorAll('#sort-switch button').forEach(b => {
  b.classList.toggle('active', b.dataset.sort === currentSort);
});
