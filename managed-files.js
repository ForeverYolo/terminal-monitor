'use strict';

(function(root) {
  const CLIENT_FILES = [
  "client.js",
  "claude-detector.js",
  "spawn-validator.js",
  "config-loader.js",
  "terminal-state.js",
  "terminal-filter.js",
  "managed-files.js",
  "file-update.js",
  "file-transfer.js",
  "service-restart.js",
  "service-runtime.sh"
];
  const SERVER_FILES = [...CLIENT_FILES, ...[
  "server.js",
  "supervisor.js",
  "server-http.js",
  "pending-requests.js",
  "terminal-replay.js",
  "public/index.html",
  "public/guide.html",
  "public/favicon.svg",
  "public/app.css",
  "public/connection.js",
  "public/dashboard.js",
  "public/terminal-view.js",
  "public/terminal-session.js",
  "public/file-browser.js",
  "public/notifications.js",
  "public/management.js",
  "public/multi-terminal.js",
  "public/mobile.js",
  "public/bootstrap.js"
]];
  const DEPLOY_FILES = [...SERVER_FILES, 'ai-overseer.js', 'package.json', 'package-lock.json', 'install.sh', 'restart.sh'];
  const manifest = Object.freeze({
    CLIENT_FILES: Object.freeze(CLIENT_FILES),
    SERVER_FILES: Object.freeze(SERVER_FILES),
    FETCHABLE_FILES: Object.freeze(SERVER_FILES),
    DEPLOY_FILES: Object.freeze(DEPLOY_FILES)
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = manifest;
  else root.ManagedFiles = manifest;
})(globalThis);
