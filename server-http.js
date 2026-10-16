'use strict';
const fs = require('fs');
const path = require('path');
const { SERVER_FILES } = require('./managed-files');

function createHttpHandler({ root, config, agents, getSupervisor, hasPrompt, maxActionBody }) {
  const assets = new Map();
  const publicNames = SERVER_FILES.filter(name => name.startsWith('public/'));
  for (const name of [...publicNames, 'terminal-filter.js', 'claude-detector.js', 'managed-files.js']) {
    const url = '/' + name.replace(/^public\//, '');
    const type = name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
    assets.set(url, { content: fs.readFileSync(path.join(root, name)), type });
  }
  assets.set('/', assets.get('/index.html'));
  assets.set('/favicon.ico', assets.get('/favicon.svg'));
  const json = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  return (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost').pathname; }
    catch { json(res, 400, {ok:false,error:'Invalid URL'}); return; }
    if (assets.has(url) && req.method === 'GET') {
      const asset = assets.get(url);
      res.writeHead(200, { 'Content-Type': `${asset.type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
      res.end(asset.content);
      return;
    }
    if (url === '/api/agents' && req.method === 'GET') {
      const list = [...agents.values()].map(a => ({
        id: a.id, name: a.name, screen: a.screen || '', attrs: a.attrs || {}, sys: a.sys || {},
        connectedAt: a.connectedAt, lastLines: a.lastOutput.split('\n').slice(-10).join('\n'),
        needsInput: hasPrompt(a.lastOutput), scrollbackSize: a.term ? a.term.scrollback.length : 0,
        nativeTui: a.nativeTui, claudeState: a.claudeState || null, clientId: a.attrs?.clientId || null
      }));
      json(res, 200, { time: new Date().toISOString(), agents: list });
      return;
    }
    if (url === '/api/supervisor' && req.method === 'GET') {
      const supervisor = getSupervisor();
      json(res, supervisor ? 200 : 503, supervisor
        ? { time: new Date().toISOString(), ...supervisor.buildSummary() }
        : { ok: false, error: 'supervisor disabled' });
      return;
    }
    if (url === '/api/action' && req.method === 'POST') {
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      const identity = Object.prototype.hasOwnProperty.call(config.server.tokens || {}, token)
        ? config.server.tokens[token] : null;
      if (!identity) { json(res, 401, { ok: false, error: 'Bearer token required' }); return; }
      const chunks = [];
      let bytes = 0, rejected = false;
      req.on('data', chunk => {
        if (rejected) return;
        bytes += chunk.length;
        if (bytes > maxActionBody) { rejected = true; json(res, 413, { ok: false, error: 'Request body too large' }); return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (rejected) return;
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { json(res, 400, { ok: false, error: 'Invalid JSON' }); return; }
        if (!body || !body.agentId || typeof body.input !== 'string') {
          json(res, 400, { ok: false, error: 'agentId and string input required' }); return;
        }
        const match = [...agents].find(([socket, a]) => a.id === body.agentId && socket.readyState === socket.OPEN && a.user === (identity.user || 'user'));
        if (!match) { json(res, 404, { ok: false, error: 'Agent not found or offline' }); return; }
        match[0].send(JSON.stringify({ type: 'data', payload: Buffer.from(body.input).toString('base64') }));
        json(res, 200, { ok: true });
      });
      return;
    }
    res.writeHead(404); res.end('Not Found');
  };
}
module.exports = { createHttpHandler };
