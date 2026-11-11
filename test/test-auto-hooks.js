"use strict";
const assert = require("assert"),
  fs = require("fs"),
  os = require("os"),
  path = require("path");
const { execFileSync } = require("child_process");
const {
  createAutoHookSetup,
  projectDirectory,
  disabledReason,
} = require("../cli-hook-setup");
const { configureHooks, activate } = require("../release-runtime");
const { normalizeState, stateText, hookHint } = require("../cli-state");
const {
  writeJson,
  readJson,
  store,
  processStamp,
} = require("../release-package");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "swt-auto-hook-unit-"));
const install = path.join(root, "install 'quoted'"),
  project = path.join(root, "project"),
  home = path.join(root, "home");
for (const dir of [install, project, home]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(install, "cli-hook.js"), "// observer");
execFileSync("git", ["init", "-q", project]);
const cli = { app: "codex", pid: 123, start: "first" },
  processes = { clis: [cli] },
  state = { isCodeCli: true, app: "codex", status: "idle", source: "screen" };
let now = 100,
  queue = [],
  writes = 0,
  current = true;
function manager(options = {}) {
  return createAutoHookSetup(install, {
    getContext: () => ({ cwd: project, env: { HOME: home }, args: ["codex"] }),
    isCurrent: () => current,
    now: () => now,
    schedule: (fn) => queue.push(fn),
    install: (...args) => {
      writes++;
      return configureHooks(...args);
    },
    ...options,
  });
}
function flush() {
  for (const fn of queue.splice(0)) fn();
}
try {
  const file = path.join(project, ".codex/hooks.json");
  fs.mkdirSync(path.dirname(file));
  const quote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
  const monitorCommand = [
    process.execPath,
    path.join(install, "file-update.js"),
    "--hook",
    "codex",
  ]
    .map(quote)
    .join(" ");
  const custom = {
    description: "keep",
    hooks: {
      UserPromptSubmit: [
        {
          matcher: "custom",
          hooks: [{ type: "command", command: "echo keep" }],
        },
        { hooks: [{ type: "command", command: monitorCommand }] },
      ],
      Stop: [{ hooks: [] }],
    },
  };
  writeJson(file, custom);
  const auto = manager();
  assert.equal(auto.observe({ clis: [] }, { isCodeCli: false }), null);
  assert.equal(writes, 0);
  assert.equal(
    auto.observe({ clis: [cli, { ...cli, pid: 124 }] }, state),
    null,
  );
  assert.equal(writes, 0);
  assert.equal(auto.observe(processes, state, false).phase, "error");
  assert.equal(writes, 0);
  assert.equal(auto.observe(processes, state).phase, "installing");
  flush();
  assert.equal(auto.observe(processes, state).phase, "configured");
  assert.equal(writes, 1);
  const data = readJson(file);
  assert.equal(data.description, "keep");
  assert.equal(data.hooks.UserPromptSubmit[0].hooks[0].command, "echo keep");
  assert.equal(
    data.hooks.UserPromptSubmit.length,
    2,
    "old monitor adapter is replaced without duplicate event delivery",
  );
  assert.equal(data.hooks.Stop.length, 2, "unrelated empty group is preserved");
  const command = data.hooks.Stop[1].hooks[0].command;
  assert(command.includes("file-update.js"));
  assert(command.includes("'\\''"), "installation path is shell quoted");
  const content = fs.readFileSync(file),
    mtime = fs.statSync(file).mtimeMs;
  const targets = path.join(store(install), "hook-targets.json"),
    targetMtime = fs.statSync(targets).mtimeMs;
  now += 11000;
  auto.observe(processes, state);
  flush();
  assert(fs.readFileSync(file).equals(content));
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  assert.equal(fs.statSync(targets).mtimeMs, targetMtime);
  const backups = fs.readdirSync(
    path.join(store(install), "hook-config-backups"),
  );
  assert.equal(backups.length, 1);
  assert.deepEqual(
    JSON.parse(
      Buffer.from(
        readJson(path.join(store(install), "hook-config-backups", backups[0]))
          .before,
        "base64",
      ),
    ),
    custom,
  );
  execFileSync("git", ["-C", project, "check-ignore", ".codex/hooks.json"]);
  assert.equal(
    auto.observe(processes, { ...state, source: "hooks" }).phase,
    "connected",
  );
  assert.equal(writes, 2);
  let wire = normalizeState({
    ...state,
    hookSetup: auto.observe(processes, state),
  });
  assert(stateText(wire).includes("事件待接通"));
  assert(hookHint(wire).includes("/hooks"));
  assert(!stateText({ ...wire, source: "hooks" }).includes("待接通"));
  assert.equal(hookHint({ ...wire, source: "hooks" }), "");
  assert(
    !(
      "hookSetup" in
      normalizeState({
        isCodeCli: false,
        hookSetup: { phase: "configured", message: "must hide" },
      })
    ),
  );
  console.log(
    "PASS automatic project setup, hook preservation, stable command quoting, private backup, git exclusion, idempotent config/registry and truthful UI state",
  );

  const off = manager({ enabled: false });
  assert.equal(off.observe(processes, state).phase, "disabled");
  assert.equal(queue.length, 0);
  const disabled = manager({
    getContext: () => ({
      cwd: project,
      env: { HOME: home },
      args: ["codex", "--disable", "hooks"],
    }),
  });
  disabled.observe(processes, state);
  flush();
  assert.equal(disabled.observe(processes, state).phase, "blocked");
  assert(fs.readFileSync(file).equals(content));
  const homeSession = manager({
    getContext: () => ({ cwd: home, env: { HOME: home }, args: ["codex"] }),
  });
  homeSession.observe(processes, state);
  flush();
  assert.equal(homeSession.observe(processes, state).phase, "configured");
  assert(fs.existsSync(path.join(home, ".codex/hooks.json")), "HOME is a valid working directory");
  const cancellation = manager();
  cancellation.observe(processes, state);
  cancellation.observe({ clis: [] }, { isCodeCli: false });
  flush();
  assert.equal(writes, 3, "a cancelled discovery cannot write configuration");
  current = false;
  const exited = manager();
  exited.observe(processes, state);
  flush();
  assert.equal(
    writes,
    3,
    "an exited/replaced process cannot write configuration",
  );
  current = true;
  console.log(
    "PASS HOME sessions, opt-out, disabled hooks, ambiguous/shell processes and discovery cancellation",
  );

  const bad = path.join(project, ".claude/settings.local.json");
  fs.mkdirSync(path.dirname(bad));
  fs.writeFileSync(bad, "{ private-token invalid json");
  const claudeProc = { clis: [{ ...cli, app: "claude" }] },
    claudeState = { ...state, app: "claude" };
  const homeLocal = path.join(home, ".claude/settings.local.json"),
    homeGlobal = path.join(home, ".claude/settings.json");
  fs.mkdirSync(path.dirname(homeLocal));
  writeJson(homeGlobal, { env: { KEEP: "user setting" } });
  writeJson(homeLocal, { permissions: { allow: ["Read"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo home-custom" }] }] } });
  const globalBefore = fs.readFileSync(homeGlobal);
  const claudeHome = manager({ getContext: () => ({cwd: home, env: {HOME: home}, args: ["claude"], version: "2.1.300"}) });
  claudeHome.observe(claudeProc, claudeState); flush();
  assert.equal(claudeHome.observe(claudeProc, claudeState).phase, "configured");
  assert.deepEqual(readJson(homeLocal).permissions, { allow: ["Read"] });
  assert.equal(readJson(homeLocal).hooks.Stop.length, 2);
  assert(fs.readFileSync(homeGlobal).equals(globalBefore), "Claude HOME setup preserves user settings.json");
  const claude = manager();
  claude.observe(claudeProc, claudeState);
  flush();
  const failure = claude.observe(claudeProc, claudeState);
  assert.equal(failure.phase, "error");
  assert(!failure.message.includes("private-token"));
  assert.equal(fs.readFileSync(bad, "utf8"), "{ private-token invalid json");
  writeJson(bad, {
    permissions: { allow: ["Read"] },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "echo custom" }] }] },
  });
  now += 11000;
  claude.observe(claudeProc, claudeState);
  flush();
  assert.equal(claude.observe(claudeProc, claudeState).phase, "configured");
  assert.deepEqual(readJson(bad).permissions, { allow: ["Read"] });
  assert.equal(readJson(bad).hooks.Stop.length, 2);
  const sources = manager({
    getContext: () => ({
      cwd: project,
      env: { HOME: home },
      args: ["claude", "--setting-sources", "user"],
    }),
  });
  sources.observe(claudeProc, claudeState);
  flush();
  assert.equal(sources.observe(claudeProc, claudeState).phase, "blocked");
  console.log(
    "PASS Claude local setup, settings source restrictions, preserved permissions and malformed-config privacy/retry",
  );
  const sub = path.join(project, "src");
  fs.mkdirSync(sub);
  const context = { cwd: sub, env: { HOME: home }, args: [] };
  assert.equal(projectDirectory("codex", context), project);
  assert.equal(
    projectDirectory("claude", { ...context, version: "2.1.197" }),
    sub,
  );
  assert.equal(
    projectDirectory("claude", { ...context, version: "2.1.300" }),
    project,
  );
  assert.equal(
    disabledReason("codex", project, {
      ...context,
      args: ["codex", "Explain features.hooks=false"],
    }),
    null,
    "prompt text is not a feature flag",
  );
  assert(
    disabledReason("codex", project, {
      ...context,
      args: ["codex", "-c", "features.hooks=false"],
    }),
  );
  assert.equal(
    disabledReason("codex", project, {
      ...context,
      args: ["codex", "--disable", "hooks", "--enable", "hooks"],
    }),
    null,
  );
  assert.equal(
    disabledReason("codex", project, {
      ...context,
      args: ["codex", "--", "--disable", "hooks"],
    }),
    null,
  );
  execFileSync("git", [
    "-C",
    project,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  ]);
  const worktree = path.join(root, "worktree");
  execFileSync("git", [
    "-C",
    project,
    "worktree",
    "add",
    "-qb",
    "fixture-worktree",
    worktree,
  ]);
  assert.equal(
    projectDirectory("claude", {
      ...context,
      cwd: worktree,
      version: "2.1.300",
    }),
    project,
    "new Claude versions share local settings with the main checkout",
  );
  assert.equal(
    projectDirectory("codex", { ...context, cwd: worktree }),
    worktree,
    "Codex keeps its own project config layer",
  );
  console.log(
    "PASS project and worktree config roots, CLI version differences and actual feature flags",
  );
  const id = "a".repeat(64),
    release = path.join(store(install), "releases", id);
  fs.mkdirSync(release, { recursive: true });
  fs.writeFileSync(path.join(release, "cli-hook.js"), "// observer");
  writeJson(path.join(release, "release-manifest.json"), {});
  writeJson(path.join(store(install), "prepared.json"), { id });
  writeJson(path.join(store(install), "instances", process.pid + ".json"), {
    pid: process.pid,
    start: processStamp(process.pid),
  });
  writeJson(targets, [
    ...readJson(targets),
    { app: "codex", directory: path.join(root, "deleted-project") },
  ]);
  fs.unlinkSync(bad);
  assert.equal(activate(install, id).phase, "checking");
  assert(
    !fs.existsSync(bad),
    "an application upgrade cannot recreate removed local hook configuration",
  );
  assert(!fs.existsSync(path.join(root, "deleted-project")));
  console.log(
    "PASS deleted auto-discovered projects/configuration cannot block an application upgrade",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
