#!/usr/bin/env node
"use strict";
// Build the one-time publisher for installations predating versioned releases.
const fs = require("fs"),
  path = require("path"),
  { execFileSync } = require("child_process");
const {
  patchClient,
  patchServer,
  patchRestart,
  bundle,
} = require("../release-bridge");
const source = path.resolve(__dirname, "..");
function buildBridge(output, baseline = "7cd9b52") {
  fs.mkdirSync(output); // refuse to overwrite an existing directory
  const archive = execFileSync("git", ["archive", baseline], {
    cwd: source,
    maxBuffer: 32 * 1024 * 1024,
  });
  execFileSync("tar", ["-x", "-C", output], { input: archive });
  for (const [name, patch] of [
    ["client.js", patchClient],
    ["server.js", patchServer],
    ["service-restart.js", patchRestart],
  ])
    fs.writeFileSync(
      path.join(output, name),
      patch(fs.readFileSync(path.join(output, name), "utf8")),
    );
  fs.writeFileSync(path.join(output, "file-update.js"), bundle(source));
  fs.copyFileSync(path.join(source, "terminal-state.js"), path.join(output, "terminal-state.js"));
  return output;
}
if (require.main === module) {
  if (!process.argv[2])
    throw Error(
      "Usage: node infra/build-update-bridge.js OUTPUT_DIRECTORY [BASELINE_REF]",
    );
  console.log(buildBridge(path.resolve(process.argv[2]), process.argv[3]));
}
module.exports = { buildBridge };
