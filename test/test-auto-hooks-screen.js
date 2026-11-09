"use strict";
// Real client + GNU Screen + process discovery + auto configuration + command
// hooks. The disposable CLIs are Node fixtures; no model requests are made.
const assert = require("assert"),
  fs = require("fs"),
  path = require("path"),
  os = require("os");
const { spawn, execFileSync } = require("child_process");
const { WebSocketServer } = require("ws");
const source = path.resolve(__dirname, ".."),
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "swt-auto-hook-screen-"));
const screenDir = path.join(scratch, "screens");
fs.mkdirSync(screenDir, { mode: 0o700 });
const env = {
  ...process.env,
  SCREENDIR: screenDir,
  HOME: path.join(scratch, "home"),
  TERMINFO: path.join(os.homedir(), ".terminfo"),
};
fs.mkdirSync(env.HOME);
for (const k of ["SWT_WORKER", "SWT_INSTALL_ROOT", "SWT_RELEASE_ID"])
  delete env[k];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(100);
  }
  throw Error("Timeout " + label);
}
const screen = (args) => execFileSync("screen", args, { env, stdio: "pipe" });
let wss,
  client,
  log = "";
(async () => {
  const install = path.join(scratch, "installation");
  fs.mkdirSync(install);
  for (const f of require("../managed-files").DEPLOY_FILES) {
    fs.mkdirSync(path.dirname(path.join(install, f)), { recursive: true });
    fs.copyFileSync(path.join(source, f), path.join(install, f));
  }
  fs.symlinkSync(
    path.join(source, "node_modules"),
    path.join(install, "node_modules"),
  );
  wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.on("listening", r));
  let states = [];
  wss.on("connection", (ws) =>
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.type === "register")
        ws.send(JSON.stringify({ type: "release_registered" }));
      if (m.type === "cli_state") states.push(m.state);
      if (m.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    }),
  );
  for (const app of ["codex", "claude"]) {
    states = [];
    log = "";
    const project = path.join(scratch, app + "-project");
    fs.mkdirSync(project);
    execFileSync("git", ["init", "-q", project]);
    const fake = path.join(scratch, app);
    fs.symlinkSync(process.execPath, fake);
    const name = "auto-" + app + "-" + process.pid,
      configFile = path.join(
        project,
        app === "codex" ? ".codex/hooks.json" : ".claude/settings.local.json",
      ),
      gate = path.join(project, "send-event");
    const fixture = path.join(project, "cli-fixture.js");
    const title =
      app === "codex" ? "OpenAI Codex v0.159.3" : "Claude Code v2.1.197";
    fs.writeFileSync(
      fixture,
      `const fs=require('fs'),cp=require('child_process');
process.stdout.write(${JSON.stringify(title + "\r\n\r\n› Ask anything\r\n? for shortcuts\r\ngpt-6 · 99% context left\r\n")});
let sent=false;setInterval(()=>{if(sent||!fs.existsSync(${JSON.stringify(gate)})||!fs.existsSync(${JSON.stringify(configFile)}))return;sent=true;
 const hook=JSON.parse(fs.readFileSync(${JSON.stringify(configFile)})).hooks.UserPromptSubmit.flatMap(g=>g.hooks).find(h=>h.command.includes('file-update.js'));
 cp.execSync(hook.command,{input:JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:'auto-'+${JSON.stringify(app)},turn_id:'turn1',prompt:'PRIVATE INPUT MUST NOT LEAVE HOOK'})});
},100);`,
    );
    execFileSync(
      "screen",
      [
        "-dmS",
        name,
        fake,
        fixture,
        ...(app === "codex" ? ["-C", project] : []),
      ],
      { env, cwd: app === "codex" ? scratch : project, stdio: "pipe" },
    );
    const config = path.join(scratch, app + "-client.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        client: {
          serverUrl: "ws://127.0.0.1:" + wss.address().port,
          token: "fixture",
          name: "fixture",
          screen: name,
          clientId: "fixture-" + app,
        },
      }),
    );
    client = spawn(
      process.execPath,
      [path.join(install, "client.js"), "--config=" + config],
      { env, cwd: install },
    );
    client.stdout.on("data", (d) => (log += d));
    client.stderr.on("data", (d) => (log += d));
    await until(
      () => states.some((s) => s.hookSetup?.phase === "configured"),
      "automatic " + app + " configuration",
    );
    const generated = JSON.parse(fs.readFileSync(configFile));
    assert(
      generated.hooks.UserPromptSubmit[0].hooks[0].command.includes(
        path.join(install, "file-update.js"),
      ),
    );
    assert(
      states.every((s) => s.source !== "hooks"),
      "installing configuration alone must not claim events",
    );
    fs.writeFileSync(gate, "send");
    await until(
      () => states.some((s) => s.source === "hooks" && s.status === "working"),
      "verified " + app + " event",
    );
    assert(!JSON.stringify(states).includes("PRIVATE INPUT"));
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(install, ".swt/hook-targets.json")),
      ).filter((t) => t.app === app && t.directory === project).length,
      1,
    );
    const taskPid = screen(["-ls"])
      .toString()
      .match(new RegExp("(\\d+)\\." + name + "\\s"))[1];
    const exited = new Promise((r) => client.once("exit", r));
    client.kill("SIGTERM");
    await exited;
    client = null;
    assert.equal(
      screen(["-ls"])
        .toString()
        .match(new RegExp("(\\d+)\\." + name + "\\s"))[1],
      taskPid,
    );
    screen(["-S", name, "-X", "quit"]);
    console.log(
      "PASS " +
        app +
        " foreground discovery -> automatic project hooks -> real command/socket event; source remains truthful and task Screen survives monitor exit",
    );
  }
})()
  .catch((e) => {
    console.error(e.message, log.slice(-2500));
    process.exitCode = 1;
  })
  .finally(() => {
    client?.kill();
    for (const ws of wss?.clients || []) ws.terminate();
    wss?.close();
    let list = "";
    try {
      list = screen(["-ls"]).toString();
    } catch (e) {
      list = e.stdout?.toString() || "";
    }
    for (const m of list.matchAll(/\s(\d+\.[^\s]+)\s/g))
      try {
        screen(["-S", m[1], "-X", "quit"]);
      } catch {}
    fs.rmSync(scratch, { recursive: true, force: true });
  });
