"use strict";
const assert = require("assert"),
  fs = require("fs"),
  os = require("os"),
  path = require("path");
const { spawn, execFileSync } = require("child_process");
const {
  buildRelease,
  ReleaseReceiver,
  digest,
  writeJson,
  store,
  readJson,
} = require("../release-package");
const WebSocket = require("ws");
const project = path.resolve(__dirname, ".."),
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "swt-release-test-"));
const screens = path.join(scratch, "screens");
fs.mkdirSync(screens, { mode: 0o700 });
const env = { ...process.env, SCREENDIR: screens, SWT_HEALTH_TIMEOUT: "5000" };
delete env.SWT_WORKER;
delete env.SWT_INSTALL_ROOT;
delete env.SWT_RELEASE_ID;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const r = await fn();
      if (r) return r;
    } catch {}
    await sleep(100);
  }
  throw Error("Timed out: " + label);
}
function copyRelease(dest) {
  fs.mkdirSync(dest);
  for (const f of require("../managed-files").DEPLOY_FILES) {
    fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
    fs.copyFileSync(path.join(project, f), path.join(dest, f));
  }
  fs.symlinkSync(
    path.join(project, "node_modules"),
    path.join(dest, "node_modules"),
  );
}
function screen(name, args, cwd) {
  execFileSync("screen", ["-dmS", name, ...args], { cwd, env });
}
function writeConfig(root, name, value) {
  const file = path.join(root, name);
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return file;
}
let browser,
  browserMessages = [],
  agents = [],
  serverStatus;
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  return ws;
}
async function login(url) {
  if (browser) browser.close();
  browser = await connect(url);
  browser.on("message", (raw) => {
    const m = JSON.parse(raw);
    browserMessages.push(m);
    if (m.type === "auth_ok" || m.type === "agents") agents = m.agents;
    if (m.releaseStatus) serverStatus = m.releaseStatus;
    if (m.type === "release_server_status") serverStatus = m;
  });
  browser.send(
    JSON.stringify({ type: "auth", username: "test", password: "pw" }),
  );
  await until(
    () => browserMessages.find((m) => m.type === "auth_ok"),
    "browser auth",
  );
}
function request(body, type, timeout = 40000) {
  const reqId = cryptoId();
  const start = browserMessages.length;
  browser.send(JSON.stringify({ ...body, reqId }));
  return until(
    () =>
      browserMessages
        .slice(start)
        .find((m) => m.type === type && m.reqId === reqId),
    type,
    timeout,
  );
}
const cryptoId = () => require("crypto").randomUUID();
async function main() {
  const src = path.join(scratch, "source");
  copyRelease(src);
  const receiverRoot = path.join(scratch, "receiver");
  fs.mkdirSync(receiverRoot);
  for (const name of ["package.json", "package-lock.json"])
    fs.copyFileSync(path.join(src, name), path.join(receiverRoot, name));
  fs.symlinkSync(
    path.join(project, "node_modules"),
    path.join(receiverRoot, "node_modules"),
  );
  const manifest = buildRelease(src);
  const altered = structuredClone(manifest);
  altered.files[0].name = "../escape";
  const { id, ...body } = altered;
  altered.id = digest(JSON.stringify(body));
  assert.throws(() => new ReleaseReceiver(receiverRoot, altered));
  let receiver = new ReleaseReceiver(receiverRoot, manifest);
  assert.throws(() => new ReleaseReceiver(receiverRoot, manifest), /progress/);
  receiver.abort();
  assert(!fs.existsSync(path.join(store(receiverRoot), "current")));
  receiver = new ReleaseReceiver(receiverRoot, manifest);
  receiver.chunk(0, 0, Buffer.from("wrong").toString("base64"));
  await assert.rejects(receiver.finish(), /corrupt/);
  assert(!readJson(path.join(store(receiverRoot), "prepared.json")));
  console.log(
    "PASS manifest traversal, installation locking, corrupt/incomplete transfer leave active version unchanged",
  );

  const dependencySource = path.join(scratch, "dependency-source");
  fs.mkdirSync(dependencySource);
  const pkg = { name: "release-fixture", version: "2.0.0" };
  writeJson(path.join(dependencySource, "package.json"), pkg);
  writeJson(path.join(dependencySource, "package-lock.json"), {
    ...pkg,
    lockfileVersion: 3,
    requires: true,
    packages: { "": pkg },
  });
  for (const name of ["client.js", "server.js", "new-module.js"])
    fs.writeFileSync(
      path.join(dependencySource, name),
      "module.exports = 42;\n",
    );
  fs.writeFileSync(
    path.join(dependencySource, "managed-files.js"),
    "module.exports={DEPLOY_FILES:['client.js','server.js','new-module.js']};",
  );
  const dependencyManifest = buildRelease(dependencySource),
    dependencyReceiver = new ReleaseReceiver(receiverRoot, dependencyManifest);
  dependencyManifest.files.forEach((f, i) =>
    dependencyReceiver.chunk(
      i,
      0,
      fs.readFileSync(path.join(dependencySource, f.name)).toString("base64"),
    ),
  );
  await dependencyReceiver.finish();
  const prepared = path.join(
    store(receiverRoot),
    "releases",
    dependencyManifest.id,
  );
  assert(
    fs.existsSync(path.join(prepared, "dependency-install.log")),
    "changed dependency lock invokes npm ci",
  );
  assert.equal(
    require(path.join(prepared, "new-module.js")),
    42,
    "new filenames need no receiver whitelist update",
  );
  assert(
    !fs.existsSync(path.join(store(receiverRoot), "current")),
    "dependency preparation never activates a release",
  );
  console.log(
    "PASS dependency lock changes prepare with npm ci; new modules require no preloaded whitelist",
  );

  const broker = path.join(scratch, "broker"),
    publisher = path.join(scratch, "publisher"),
    target = path.join(scratch, "target");
  for (const dir of [broker, publisher, target]) copyRelease(dir);
  const rootServer = fs.readFileSync(path.join(broker, "server.js"));
  const port = 21000 + Math.floor(Math.random() * 8000), url = "ws://127.0.0.1:" + port;
  const serverConfig = writeConfig(broker, "config.json", {
    server: {port, host: "127.0.0.1", password: "pw", tokens: {token: {user: "test"}}, supervisor: {enabled: false}},
  });
  screen("swt-server", ["bash", "-c", 'exec "$1" server.js --config="$2" > server.log 2>&1', "_", process.execPath, serverConfig], broker);
  await until(async () => (await fetch("http://127.0.0.1:" + port)).ok, "current broker");
  for (const [root, name, cid, releaseSource] of [
    [publisher, "publisher", "publisher", src], [target, "target-a", "target"], [target, "target-b", "target"],
  ]) {
    screen(name, ["bash", "--noprofile", "--norc"], root);
    const cfg = writeConfig(root, "config.client-" + name + ".json", {
      client: {serverUrl: url, token: "token", name, screen: name, clientId: cid, releaseSource},
    });
    screen("swt-client-" + name, ["bash", "-c", 'exec "$1" client.js --config="$2" > "$3" 2>&1', "_", process.execPath, cfg, name + ".log"], root);
  }
  await login(url);
  await until(() => agents.length === 3, "three current agents");
  assert(agents.every(a => a.updateProtocol === 1));
  let result = await request({type: "restart_server"}, "restart_server_result");
  assert(!result.ok, "no prepared release must fail instead of restarting files in place");
  // A client without the complete-release protocol receives an explicit error;
  // the server must never send a bootstrap or a file-overwrite request.
  const unsupported = await connect(url), received = [];
  unsupported.on("message", raw => received.push(JSON.parse(raw)));
  unsupported.send(JSON.stringify({type: "register", protocolVersion: 2, token: "token", name: "unsupported", screen: "unsupported", attrs: {clientId: "unsupported"}, cols: 80, rows: 24}));
  await until(() => agents.some(a => a.clientId === "unsupported"), "unsupported agent registration");
  for (const type of ["push_update", "pull_update"]) {
    result = await request({type, clientId: "unsupported"}, type + "_result");
    assert(!result.ok && /协议/.test(result.error));
  }
  assert(!received.some(m => ["fetch_files", "update_files"].includes(m.type)));
  unsupported.close();
  console.log("PASS unsupported updaters rejected without a compatibility bridge or in-place file writes");
  result = await request({type: "pull_update", clientId: "publisher"}, "pull_update_result", 60000);
  assert(result.ok && result.prepared, JSON.stringify(result));
  assert(fs.readFileSync(path.join(broker, "server.js")).equals(rootServer), "preparation leaves running source untouched");
  await request({type: "restart_server"}, "restart_server_result");
  await until(() => browser.readyState !== 1, "version switch");
  browserMessages = [];
  await until(async () => { const ws = await connect(url); ws.close(); return true; }, "new broker listens");
  await login(url);
  await until(() => readJson(path.join(store(broker), "activation.json"))?.phase === "completed", "broker health");
  assert.equal(readJson(path.join(store(broker), "activation.json")).id, manifest.id);
  console.log("PASS complete release web pull and health-checked server activation");
  await until(() => agents.filter(a => a.clientId === "target").length === 2, "target agents reconnect");
  result = await request({type: "push_update", clientId: "target"}, "push_update_result", 90000);
  assert(result.ok, JSON.stringify(result));
  const state = readJson(path.join(store(target), "activation.json"));
  assert.equal(state.phase, "completed");
  assert.equal(state.expected.length, 2, "both monitors required for success");
  assert.equal(readJson(path.join(store(target), "releases", state.id, "release-manifest.json")).id, manifest.id);
  execFileSync("screen", ["-S", "target-a", "-Q", "windows"], {env});
  execFileSync("screen", ["-S", "target-b", "-Q", "windows"], {env});
  console.log("PASS complete release push verifies both monitors and preserves task Screens");

  const hookProject = path.join(scratch, "project 'quoted'");
  fs.mkdirSync(hookProject);
  fs.mkdirSync(path.join(hookProject, ".claude"));
  const hookFile = path.join(hookProject, ".claude", "settings.local.json");
  fs.writeFileSync(
    hookFile,
    JSON.stringify({
      permissions: { allow: ["Read"] },
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "echo custom" }] }],
      },
    }),
  );
  const runtime = require("../release-runtime");
  runtime.configureHooks(broker, { app: "claude", directory: hookProject });
  runtime.configureHooks(broker, { app: "claude", directory: hookProject });
  const hookBefore = fs.readFileSync(hookFile, "utf8"),
    hookConfig = JSON.parse(hookBefore);
  assert.equal(hookConfig.hooks.Stop.length, 2);
  assert.deepEqual(hookConfig.permissions, { allow: ["Read"] });
  assert(
    hookConfig.hooks.Stop[1].hooks[0].command.includes(
      path.join(broker, "file-update.js"),
    ),
  );
  console.log(
    "PASS project hooks preserve custom configuration and use a stable command across releases",
  );

  // A valid, checksummed release whose server exits must roll back without SSH.
  fs.appendFileSync(
    path.join(src, "server.js"),
    '\nthrow Error("intentional release health failure");\n',
  );
  result = await request(
    { type: "pull_update", clientId: "publisher" },
    "pull_update_result",
    60000,
  );
  assert(result.ok, JSON.stringify(result));
  const badId = result.releaseId;
  assert.notEqual(badId, manifest.id);
  await request({ type: "restart_server" }, "restart_server_result");
  await until(
    () =>
      readJson(path.join(store(broker), "activation.json"))?.phase ===
      "rolled_back",
    "automatic rollback",
  );
  assert.equal(
    fs.readlinkSync(path.join(store(broker), "current")),
    "releases/" + manifest.id,
  );
  assert.equal(
    fs.readFileSync(hookFile, "utf8"),
    hookBefore,
    "rollback restores prior hook configuration",
  );
  await until(async () => {
    const r = await fetch("http://127.0.0.1:" + port);
    return r.ok;
  }, "old server available after rollback");
  console.log(
    "PASS valid release with startup failure automatically restores previous server",
  );
}
main()
  .catch((e) => {
    console.error(e);
    for (const dir of ["broker", "publisher", "target"]) {
      const full = path.join(scratch, dir);
      if (fs.existsSync(full))
        for (const f of fs.readdirSync(full).filter((n) => n.endsWith(".log")))
          console.error(
            dir + "/" + f,
            fs.readFileSync(path.join(full, f), "utf8").slice(-5000),
          );
    }
    process.exitCode = 1;
  })
  .finally(() => {
    browser?.close();
    let output = "";
    try {
      output = execFileSync("screen", ["-ls"], { env, encoding: "utf8" });
    } catch (e) {
      output = e.stdout?.toString() || "";
    }
    for (const match of output.matchAll(/\s(\d+\.[^\s]+)\s/g))
      try {
        execFileSync("screen", ["-S", match[1], "-X", "quit"], {
          env,
          stdio: "ignore",
        });
      } catch {}
    fs.rmSync(scratch, { recursive: true, force: true });
  });
