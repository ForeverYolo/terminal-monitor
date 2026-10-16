'use strict';

// ========== Multi Select ==========

function toggleAgentSelect(agentId) {
  if (selectedAgents.has(agentId)) {
    selectedAgents.delete(agentId);
  } else {
    selectedAgents.add(agentId);
  }
  renderAgents(lastAgents);
}

function cancelMultiSelect() {
  selectedAgents.clear();
  document.getElementById('dash-multi-bar').style.display = 'none';
  setMode('card');
}

let multiScope = null;

function openMultiTerminal() {
  if (selectedAgents.size === 0) return;
  if (multiScope) multiScope.dispose();
  multiScope = createViewScope();
  const scope = multiScope;
  showView('multi');
  document.getElementById('multi-title').textContent = `已选 ${selectedAgents.size} 台设备`;

  const container = document.getElementById('multi-container');
  container.innerHTML = '';

  // Close existing multi terms
  Object.values(multiTerms).forEach(t => { t.dispose(); forgetTerminalState(t.agentId); });
  multiTerms = {};

  const agentIds = Array.from(selectedAgents);

  // Create terminal for each agent
  agentIds.forEach(agentId => {
    const agent = lastAgents.find(a => a.id === agentId);
    const name = agent ? agent.name : agentId;

    const wrap = document.createElement('div');
    wrap.className = 'multi-term-wrap';
    wrap.innerHTML = `
      <div class="multi-term-header">
        <span class="name">${escapeHtml(name)}</span>
        <div class="term-actions">
          <button title="上传到终端当前目录">📤</button>
          <button title="从终端当前目录下载">📥</button>
          <button title="复制SSH命令">🔗</button>
          <button class="restart-btn" data-agent="${agentId}" title="重新attach screen会话">🔄</button>
        </div>
        <span class="close">关闭</span>
      </div>
      <div class="multi-term-container" id="multi-term-${agentId}"></div>
    `;
    container.appendChild(wrap);

    const entry = createTerminalSession(wrap.querySelector('.multi-term-container'), {
      agentId, fontSize: 12, scrollback: 50000
    });
    entry.scope.add(() => wrap.remove());
    entry.terminalKey = agent ? terminalKeyOf(agent) : null;
    multiTerms[agentId] = entry;
    const buttons = wrap.querySelectorAll('.term-actions button');
    buttons[0].onclick = () => onUploadClickFor(entry.agentId);
    buttons[1].onclick = () => openFileBrowserFor(entry.agentId);
    buttons[2].onclick = () => copySshCmd(entry.agentId);
    buttons[3].onclick = () => restartScreen(entry.agentId);
    wrap.querySelector('.close').onclick = () => closeMultiTerm(entry.agentId);

  });

  scope.frame(() => scope.frame(() => {
    for (const entry of Object.values(multiTerms)) entry.fitAddon.fit();
    subscribeMultiTerms();
  }));

  // Handle resize
  scope.listen(window, 'resize', () => {
    scope.debounce('resize', () => {
      Object.values(multiTerms).forEach(t => {
        sendViewportResize(t.agentId, proposedSize(t.fitAddon, t.term));
      });
    }, 200);
  });
}

function closeMultiTerm(agentId) {
  if (multiTerms[agentId]) {
    multiTerms[agentId].dispose();
    forgetTerminalState(agentId);
    delete multiTerms[agentId];
  }
  selectedAgents.delete(agentId);
  if (Object.keys(multiTerms).length === 0) {
    closeMultiView();
  } else {
    document.getElementById('multi-title').textContent = `已选 ${Object.keys(multiTerms).length} 台设备`;
    subscribeMultiTerms(true);
  }
}

function closeMultiView() {
  if (multiScope) multiScope.dispose();
  multiScope = null;
  Object.values(multiTerms).forEach(t => { t.dispose(); forgetTerminalState(t.agentId); });
  multiTerms = {};
  selectedAgents.clear();
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'disconnect_multi' }));
  showView('dash');
  renderAgents(lastAgents);
}

function subscribeMultiTerms(resume = false) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const ids = Object.keys(multiTerms);
  if (!ids.length) return;
  const sizes = multiSizes();
  for (const id of ids) rememberRequestedSize(id, sizes[id]);
  ws.send(JSON.stringify({ type: 'connect_multi', agentIds: ids, sizes,
    ...(resume ? { resume: true, sinceSeqs: resumePayloadFor(ids) } : {}) }));
}
