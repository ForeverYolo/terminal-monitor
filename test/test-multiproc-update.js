"use strict";
// A shared installation downloads once, but success requires every monitor.
const assert = require("assert"),
  fs = require("fs"),
  os = require("os"),
  path = require("path");
const { fork } = require("child_process");
const WebSocket = require("ws");
const root = path.resolve(__dirname, ".."),
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "swt-multi-release-"));
const port = 19600 + Math.floor(Math.random() * 300),
  url = "ws://127.0.0.1:" + port,
  sockets = [];
const config = path.join(scratch, "config.json");
fs.writeFileSync(
  config,
  JSON.stringify({
    server: {
      port,
      password: "pw",
      tokens: { token: { user: "user" } },
      supervisor: { enabled: false },
    },
  }),
);
const server = fork(path.join(root, "server.js"), ["--config=" + config], {
  stdio: "ignore",
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const r = fn();
    if (r) return r;
    await sleep(30);
  }
  throw Error("Protocol test timed out");
}
async function connect() {
  const ws = new WebSocket(url);
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  sockets.push(ws);
  ws.messages = [];
  ws.on("message", (raw) => ws.messages.push(JSON.parse(raw)));
  return ws;
}
const send = (ws, msg) => ws.send(JSON.stringify(msg));
(async () => {
  await sleep(700);
  const a = await connect(),
    b = await connect();
  for (const [ws, screen] of [
    [a, "a"],
    [b, "b"],
  ])
    send(ws, {
      type: "register",
      token: "token",
      protocolVersion: 2,
      name: "multi",
      screen,
      attrs: { clientId: "multi" },
      cols: 80,
      rows: 24,
      updateProtocol: 1,
      installationId: "shared",
      releaseId: null,
    });
  const browser = await connect();
  send(browser, { type: "auth", username: "user", password: "pw" });
  await until(() => browser.messages.some((m) => m.type === "auth_ok"));
  send(browser, { type: "push_update", reqId: "push", clientId: "multi" });
  const begin = await until(() =>
    a.messages.find((m) => m.type === "release_begin"),
  );
  await until(() => a.messages.some((m) => m.type === "release_end"));
  assert(
    !b.messages.some((m) => m.type === "release_begin"),
    "shared directory receives only one download",
  );
  send(a, {
    type: "release_prepared",
    reqId: begin.reqId,
    releaseId: begin.manifest.id,
    ok: true,
  });
  await until(() => a.messages.find((m) => m.type === "release_activate"));
  const state = { id: begin.manifest.id, phase: "completed" };
  send(a, {
    type: "release_state",
    reqId: begin.reqId,
    installationId: "shared",
    releaseId: begin.manifest.id,
    updateState: state,
  });
  await sleep(800);
  assert(
    !browser.messages.some((m) => m.type === "push_update_result"),
    "first healthy monitor cannot complete the job",
  );
  send(b, {
    type: "release_state",
    reqId: begin.reqId,
    installationId: "shared",
    releaseId: begin.manifest.id,
    updateState: state,
  });
  const result = await until(() =>
    browser.messages.find((m) => m.type === "push_update_result"),
  );
  assert(result.ok);
  send(browser, { type: "restart_node", reqId: "restart", clientId: "multi" });
  await until(
    () =>
      a.messages.some((m) => m.type === "restart_node") &&
      b.messages.some((m) => m.type === "restart_node"),
  );
  const other = await connect();
  send(other, { type: "auth", username: "other", password: "pw" });
  await until(() => other.messages.some((m) => m.type === "auth_ok"));
  send(other, { type: "push_update", reqId: "forbidden", clientId: "multi" });
  const denied = await until(() =>
    other.messages.find((m) => m.type === "push_update_result"),
  );
  assert.equal(denied.ok, false);
  console.log(
    "PASS one transfer per installation, all-monitor health completion, restart fanout and owner isolation",
  );
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const ws of sockets) ws.terminate();
    server.kill();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
