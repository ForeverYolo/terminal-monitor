"use strict";
// Staging-only end-to-end check; never sends input to the existing task.
const assert = require("assert"),
  fs = require("fs"),
  path = require("path"),
  os = require("os");
const { spawn, execFileSync } = require("child_process");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root =
  process.env.STAGING_ROOT || "/home/renhangqi/terminal-monitor-staging";
const access = JSON.parse(
  fs.readFileSync(path.join(root, "runtime/access.json")),
);
const settings = JSON.parse(
  fs.readFileSync(path.join(root, "runtime/settings.json")),
);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "swt-staging-auto-hooks-"));
const screen = "staging-auto-hooks-" + process.pid,
  name = "自动事件接入验收";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  const end = Date.now() + 40000;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {}
    await sleep(150);
  }
  throw Error("Timeout " + label);
}
function taskPid() {
  return execFileSync("screen", ["-ls"], { encoding: "utf8" }).match(
    /\b(\d+)\.swt-staging-codex\s/,
  )?.[1];
}
let browser,
  client,
  log = "";
(async () => {
  const meta = await (await fetch(new URL("staging.json", access.url))).json();
  assert.equal(meta.environment, "staging");
  const taskBefore = taskPid();
  assert(taskBefore);
  const project = path.join(temp, "project");
  fs.mkdirSync(project);
  execFileSync("git", ["init", "-q", project]);
  const fake = path.join(temp, "codex");
  fs.symlinkSync(settings.node, fake);
  const hookFile = path.join(project, ".codex/hooks.json"),
    gate = path.join(temp, "send-event"),
    fixture = path.join(temp, "fixture.js");
  fs.writeFileSync(
    fixture,
    `const fs=require('fs'),cp=require('child_process');process.stdout.write('OpenAI Codex v0.159.3\\r\\n\\r\\n› Ask anything\\r\\n? for shortcuts\\r\\ngpt-6 · 99% context left\\r\\n');let sent=false;setInterval(()=>{if(sent||!fs.existsSync(${JSON.stringify(gate)})||!fs.existsSync(${JSON.stringify(hookFile)}))return;sent=true;const command=JSON.parse(fs.readFileSync(${JSON.stringify(hookFile)})).hooks.UserPromptSubmit.flatMap(g=>g.hooks).find(h=>h.command.includes('file-update.js')).command;cp.execSync(command,{input:JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:'staging-auto-hook-probe',turn_id:'probe-turn'})});},100);`,
  );
  const env = { ...process.env };
  for (const key of ["SWT_WORKER", "SWT_INSTALL_ROOT", "SWT_RELEASE_ID"])
    delete env[key];
  execFileSync("screen", ["-dmS", screen, fake, fixture], {
    cwd: project,
    env,
  });
  const config = path.join(temp, "client.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      client: {
        serverUrl: access.url.replace(/^http/, "ws"),
        token: access.token,
        name,
        screen,
        clientId: "staging-auto-hook-probe",
      },
    }),
    { mode: 0o600 },
  );
  client = spawn(
    settings.node,
    [path.join(root, "current/client.js"), "--config=" + config],
    { env, cwd: root },
  );
  client.stdout.on("data", (d) => (log += d));
  client.stderr.on("data", (d) => (log += d));
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(access.url);
  await page.locator("#username-input").fill(access.username);
  await page.locator("#password-input").fill(access.password);
  await page.locator(".login-box button").click();
  const card = page
    .locator(".agent-card")
    .filter({ has: page.locator(".name").filter({ hasText: name }) });
  await until(
    async () => (await card.innerText()).includes("事件待接通"),
    "deployed automatic configuration",
  );
  assert(
    (await card.locator(".hook-setup-hint").innerText()).includes("/hooks"),
  );
  assert(fs.existsSync(hookFile));
  const output = path.join(root, "runtime/auto-hooks-verification");
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  await card.screenshot({ path: path.join(output, "pending.png") });
  fs.writeFileSync(gate, "send");
  await until(
    async () =>
      (await card.locator(".claude-badge").innerText()).includes(
        "工作中 · Codex · 事件",
      ) && (await card.locator(".hook-setup-hint").count()) === 0,
    "deployed verified hook event",
  );
  assert.equal(
    await card
      .locator(".claude-badge")
      .evaluate((e) => getComputedStyle(e).backgroundColor),
    "rgb(45, 26, 74)",
  );
  assert.equal(taskPid(), taskBefore);
  assert.deepEqual(errors, []);
  await card.screenshot({ path: path.join(output, "connected.png") });
  fs.writeFileSync(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        commit: meta.commit,
        verifiedAt: new Date().toISOString(),
        automaticConfiguration: true,
        pendingUi: true,
        verifiedCommandEvent: true,
        purpleBadge: true,
        existingTaskPidUnchanged: true,
        browserErrors: errors,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    "PASS deployed automatic hook setup, pending instructions, verified command event, purple badge and existing task Screen preservation",
  );
})()
  .catch((e) => {
    console.error(e.message, log.slice(-2000));
    process.exitCode = 1;
  })
  .finally(async () => {
    client?.kill("SIGTERM");
    if (client) await sleep(600);
    if (browser) await browser.close();
    try {
      execFileSync("screen", ["-S", screen, "-X", "quit"], { stdio: "ignore" });
    } catch {}
    fs.rmSync(temp, { recursive: true, force: true });
  });
