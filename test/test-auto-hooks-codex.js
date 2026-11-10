"use strict";
// Local Codex UI only: no model prompt, hook-trust bypass or user session input.
if (process.env.RUN_LOCAL_CODEX_HOOK_SETUP_TEST !== "1") {
  console.log("SKIP local Codex hook setup UI");
  process.exit(0);
}
const assert = require("assert"),
  fs = require("fs"),
  os = require("os"),
  path = require("path");
const { execFileSync } = require("child_process"),
  pty = require("node-pty");
const { TerminalState } = require("../terminal-state");
const { createAutoHookSetup } = require("../cli-hook-setup");
const { screenProcesses } = require("../cli-process");
const { prepareScreenTerminal } = require("../screen-terminal");
const { CliTracker } = require("../cli-tracker");
const source = path.resolve(__dirname, ".."),
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "swt-auto-real-codex-")),
  name = "auto-real-codex-" + process.pid;
let display, term;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(100);
  }
  throw Error("Timeout " + label);
}
const view = () => term?.readScreen().join("\n") || "";
(async () => {
  const project = path.join(temp, "project"),
    install = path.join(temp, "monitor");
  fs.mkdirSync(project);
  fs.mkdirSync(install);
  execFileSync("git", ["init", "-q", project]);
  for (const f of require("../managed-files").DEPLOY_FILES) {
    fs.mkdirSync(path.dirname(path.join(install, f)), { recursive: true });
    fs.copyFileSync(path.join(source, f), path.join(install, f));
  }
  const args = require("./fixtures/codex-history")(
    path.join(temp, "codex-home"),
    project,
  );
  const env = { ...process.env, TERM: "screen-256color" };
  for (const k of [
    "SWT_WORKER",
    "SWT_INSTALL_ROOT",
    "SWT_RELEASE_ID",
    "NO_COLOR",
  ])
    delete env[k];
  execFileSync("screen", ["-c", "/dev/null", "-dmS", name, ...args], {
    cwd: project,
    env,
  });
  const terminal = prepareScreenTerminal();
  display = pty.spawn("screen", ["-x", name], {
    cwd: project,
    env: { ...env, TERM: terminal },
    name: terminal,
    cols: 150,
    rows: 40,
  });
  term = new TerminalState(150, 40, () => {});
  term.term.onData((data) => display.write(data));
  display.onData((data) => term.write(data));
  await until(
    () =>
      !term.pending &&
      /ANSWER-\d+/.test(view()) &&
      !/Resuming session|Waiting for startup/.test(view()),
    "Codex history ready",
    60000,
  );
  const setup = createAutoHookSetup(install);
  const tracker = new CliTracker();
  let state;
  await until(() => {
    state = tracker.screen(term.readScreen(), screenProcesses(name));
    return state.isCodeCli;
  }, "generic UI detection and process naming");
  setup.observe(screenProcesses(name), state);
  await until(
    () => setup.observe(screenProcesses(name), state)?.phase === "configured",
    "automatic project configuration",
  );
  assert(fs.existsSync(path.join(project, ".codex/hooks.json")));
  display.write("/hooks");
  await sleep(200);
  display.write("\r");
  await until(
    () =>
      /SessionStart|UserPromptSubmit|No hooks configured|No hooks found|Review hooks|Hook events/i.test(
        view(),
      ),
    "hook browser",
    20000,
  );
  await sleep(500);
  const freshView = view(),
    sawConfigured =
      /SessionStart|UserPromptSubmit|SessionEnd|review|untrusted|Trust|trust|command hook/i.test(
        freshView,
      ) && !/No hooks configured|No hooks found/i.test(freshView);
  console.log(
    "Codex hook menu after automatic setup:",
    freshView
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => l.replaceAll(temp, "<fixture>"))
      .slice(-23)
      .join("\n"),
  );
  assert(
    sawConfigured,
    "the current Codex hook browser must discover the generated project hooks",
  );
  assert.equal(
    setup.observe(screenProcesses(name), state).phase,
    "configured",
    "trust/configuration is not an event",
  );
  console.log(
    "PASS real existing Codex discovers automatically created project hooks without a model prompt or trust bypass",
  );
  // Only these eight fixture adapters exist in this temporary Codex home.
  display.write("t");
  await until(
    () =>
      /Installed\s+Active\s+Description/.test(view()) &&
      !/hooks need review/.test(view()),
    "fixture hook review",
  );
  assert.equal(setup.observe(screenProcesses(name), state).phase, "configured");
  console.log(
    "PASS native Codex review accepts the generated hooks; trust alone never claims an event connection",
  );
})()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    display?.kill();
    term?.dispose();
    try {
      execFileSync("screen", ["-S", name, "-X", "quit"], { stdio: "ignore" });
    } catch {}
    fs.rmSync(temp, { recursive: true, force: true });
  });
