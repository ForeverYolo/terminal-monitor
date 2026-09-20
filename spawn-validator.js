/**
 * Pure validator for spawn_node requests. Extracted from client.js so it can
 * be unit-tested without loading the full client module (which self-starts).
 */
'use strict';

const SPAWN_MAX_NODES = 20;

const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const CMD_WHITELIST = /^(claude|bash|sh)$/;

function validateSpawnRequest({ screenName, cmd } = {}) {
  const sn = String(screenName || '').trim();
  const c = String(cmd || 'bash').trim();
  if (!NAME_RE.test(sn)) {
    return { ok: false, error: 'Invalid screenName (alphanum/_/- max 40)' };
  }
  if (!CMD_WHITELIST.test(c)) {
    return { ok: false, error: 'cmd must be one of: claude, bash, sh' };
  }
  return { ok: true, screenName: sn, cmd: c };
}

module.exports = { validateSpawnRequest, SPAWN_MAX_NODES, NAME_RE, CMD_WHITELIST };
