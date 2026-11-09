"use strict";
const fs = require("fs"),
  path = require("path");
const { digest } = require("./release-package");
const MODULES = [
  "file-update",
  "release-package",
  "release-runtime",
  "release-transport",
  "release-bridge",
];
function bundle(root) {
  const existing = fs.readFileSync(path.join(root, "file-update.js"), "utf8");
  if (existing.startsWith("// SWT update bridge v1")) return existing;
  const factories = MODULES.map(
    (name) =>
      JSON.stringify("./" + name) +
      ":function(module,exports,require,__dirname,__filename){\n" +
      fs.readFileSync(path.join(root, name + ".js"), "utf8") +
      "\n}",
  ).join(",\n");
  return `// SWT update bridge v1\n'use strict';\nconst outerRequire=require,cache={},factories={${factories}};\nfunction localRequire(name){const key=name.replace(/\\.js$/,'');if(!factories[key])return outerRequire(name);if(cache[key])return cache[key].exports;const m=cache[key]={exports:{}};factories[key](m,m.exports,localRequire,__dirname,require('path').join(__dirname,key.slice(2)+'.js'));return m.exports;}\nObject.assign(localRequire,{resolve:outerRequire.resolve,cache:outerRequire.cache,main:outerRequire.main});\nmodule.exports=localRequire('./file-update');\nif(require.main===module&&process.argv[2]==='--hook')module.exports.runHook(process.argv[3],__dirname);\nif(require.main===module&&process.argv[2]==='--configure-hooks')console.log(JSON.stringify(module.exports.configureHooks(__dirname,{app:process.argv[3],directory:require('path').resolve(process.argv[4]||'.')})));\n`;
}
function replaceOnce(text, needle, replacement) {
  if (text.split(needle).length !== 2)
    throw Error("This installation needs an explicitly supported bridge");
  return text.replace(needle, replacement);
}
function patchClient(source) {
  if (source.includes("createReleaseClient")) return source;
  source =
    `if (require('./file-update').runManaged('client', __dirname)) return;\n` +
    source;
  source = replaceOnce(
    source,
    "const { buildFileManifest, installFiles } = require('./file-update');",
    "const { buildFileManifest, installFiles } = require('./file-update');\nconst releaseClient = require('./file-update').createReleaseClient({root:__dirname,config,send:sendMsg});",
  );
  source = replaceOnce(
    source,
    "    console.log('Connected to server');",
    "    releaseClient.connected(ws);\n    console.log('Connected to server');",
  );
  source = replaceOnce(
    source,
    "        protocolVersion: PROTOCOL_VERSION,",
    "        ...releaseClient.identity(),\n        protocolVersion: PROTOCOL_VERSION,",
  );
  source = replaceOnce(
    source,
    "    if (msg.type === 'resize' && ptyProcess)",
    "    if (releaseClient.handle(msg,ws)) return;\n\n    if (msg.type === 'resize' && ptyProcess)",
  );
  source = replaceOnce(
    source,
    "    console.log('Disconnected from server');",
    "    releaseClient.disconnected(ws);\n    console.log('Disconnected from server');",
  );
  return source;
}
function patchServer(source) {
  if (source.includes("createReleaseServer")) return source;
  source =
    `if (require('./file-update').runManaged('server', __dirname)) return;\n` +
    source;
  source = replaceOnce(
    source,
    "const wss = new WebSocketServer(",
    "const releaseService = require('./file-update').createReleaseServer({root:__dirname,config,agents,browsers,httpServer});\nconst wss = new WebSocketServer(",
  );
  source = replaceOnce(
    source,
    "      agents.set(ws, info);",
    "      agents.set(ws, info);\n      releaseService.registered(ws,info,msg);",
  );
  source = replaceOnce(
    source,
    "        protocolVersion: a.protocolVersion,",
    "        protocolVersion: a.protocolVersion,\n        updateProtocol:a.updateProtocol, installationId:a.installationId, releaseId:a.releaseId, updateState:a.updateState,",
  );
  source = replaceOnce(
    source,
    "    // --- Agent messages ---",
    "    if (releaseService.handle(role,ws,msg)) return;\n\n    // --- Agent messages ---",
  );
  source = replaceOnce(
    source,
    "    if (role === 'agent') {\n      const info = agents.get(ws);",
    "    releaseService.disconnected(ws);\n    if (role === 'agent') {\n      const info = agents.get(ws);",
  );
  return source;
}
function bridgeFiles(root, files) {
  const byName = new Map(
    files.map((f) => [
      f.name,
      Buffer.from(f.content, "base64").toString("utf8"),
    ]),
  );
  const values = {
    "terminal-state.js": fs.readFileSync(path.join(root, "terminal-state.js"), "utf8"),
    "client.js": patchClient(byName.get("client.js") || ""),
    "server.js": patchServer(byName.get("server.js") || ""),
    "file-update.js": bundle(root),
    "service-restart.js": patchRestart(byName.get("service-restart.js") || ""),
  };
  return Object.entries(values).map(([name, data]) => ({
    name,
    content: Buffer.from(data).toString("base64"),
    sha256: digest(data),
  }));
}
function patchRestart(source) {
  if (source.includes(".restartWorker()")) return source;
  for (const name of ["restartClient", "restartServer"])
    source = source.replace(
      new RegExp("(function " + name + "\\([^\\n]+\\{\\n)"),
      "$1  const updater = require.resolve('./file-update');\n  delete require.cache[updater];\n  if (require(updater).restartWorker()) return;\n",
    );
  if (!source.includes(".restartWorker()"))
    throw Error("Unsupported restart helper");
  return source;
}
module.exports = {
  bundle,
  patchClient,
  patchServer,
  patchRestart,
  bridgeFiles,
};
