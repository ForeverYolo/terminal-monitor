'use strict';
const fs = require('fs');
const path = require('path');

// Shared --config=<path> / --config <path> CLI parsing + JSON load, used by
// server.js, client.js and ai-overseer.js (each a standalone entry point).
// Returns both the parsed config and the resolved file path — callers that
// write back to disk (e.g. client.js persisting a generated clientId) need
// the exact path that was loaded from.
function loadConfig(defaultName, baseDir) {
  const inline = process.argv.find(arg => arg.startsWith('--config='));
  const index = process.argv.indexOf('--config');
  const configArg = inline ? inline.slice('--config='.length) : index < 0 ? null : process.argv[index + 1];
  if ((inline || index >= 0) && (!configArg || configArg.startsWith('--'))) throw Error('--config requires a file path');
  const configFile = configArg || path.join(baseDir, defaultName);
  let config;
  try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); }
  catch (error) { throw Error(`Cannot load configuration ${configFile}: ${error.message}`); }
  return { config, configFile };
}

module.exports = { loadConfig };
