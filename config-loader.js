'use strict';
const fs = require('fs');
const path = require('path');

// Shared --config=<path> / --config <path> CLI parsing + JSON load, used by
// server.js, client.js and ai-overseer.js (each a standalone entry point).
// Returns both the parsed config and the resolved file path — callers that
// write back to disk (e.g. client.js persisting a generated clientId) need
// the exact path that was loaded from.
function loadConfig(defaultName, baseDir) {
  const configArg = process.argv.find(a => a.startsWith('--config='))?.split('=')[1]
    || (process.argv.indexOf('--config') !== -1 ? process.argv[process.argv.indexOf('--config') + 1] : null);
  const configFile = configArg || path.join(baseDir, defaultName);
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  return { config, configFile };
}

module.exports = { loadConfig };
