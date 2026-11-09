"use strict";
const fs = require("fs");
const path = require("path");
const { fork } = require("child_process");
const {
  digest,
  store,
  readJson,
  writeJson,
  processStamp,
  isAlive,
  lock,
} = require("./release-package");
function installRoot(root) {
  return fs.realpathSync(process.env.SWT_INSTALL_ROOT || root);
}
function activeId(root) {
  try {
    const link = fs.readlinkSync(path.join(store(root), "current"));
    if (!/^releases\/[a-f0-9]{64}$/.test(link))
      throw Error("Invalid release pointer");
    return path.basename(link);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
function setActive(root, id) {
  const current = path.join(store(root), "current");
  if (!id) {
    fs.rmSync(current, { force: true });
    return;
  }
  if (
    !/^[a-f0-9]{64}$/.test(id) ||
    !fs.existsSync(
      path.join(store(root), "releases", id, "release-manifest.json"),
    )
  )
    throw Error("Release is not prepared");
  const temp = current + "." + process.pid + ".next";
  fs.rmSync(temp, { force: true });
  fs.symlinkSync("releases/" + id, temp);
  fs.renameSync(temp, current);
}
function activeRoot(root) {
  const id = activeId(root);
  return id ? path.join(store(root), "releases", id) : root;
}
function instances(root) {
  const dir = path.join(store(root), "instances");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => /^\d+\.json$/.test(n))
    .map((n) => readJson(path.join(dir, n)))
    .filter(isAlive);
}
function identity(root) {
  root = installRoot(root);
  const state = readJson(path.join(store(root), "activation.json"));
  const updateState = state
    ? Object.fromEntries(
        ["id", "previous", "phase", "startedAt", "finishedAt", "error"]
          .filter((k) => state[k] !== undefined)
          .map((k) => [k, state[k]]),
      )
    : null;
  return {
    updateProtocol: 1,
    installationId: digest(root).slice(0, 24),
    releaseId:
      process.env.SWT_WORKER === "1"
        ? process.env.SWT_RELEASE_ID || null
        : activeId(root),
    updateState,
  };
}
function notifyReady() {
  if (process.env.SWT_WORKER === "1" && process.send)
    process.send({ type: "swt_ready" });
}
function configPath(root, argv) {
  const value = argv.find((v) => v.startsWith("--config="));
  const i = argv.indexOf("--config");
  return path.resolve(
    value
      ? value.slice(9)
      : i >= 0
        ? argv[i + 1]
        : path.join(root, "config.json"),
  );
}
function hookCommand(root, app) {
  const quote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
  return [process.execPath, path.join(root, "file-update.js"), "--hook", app]
    .map(quote)
    .join(" ");
}
function mergeHooks(root, target) {
  if (
    !["codex", "claude"].includes(target.app) ||
    !path.isAbsolute(target.directory)
  )
    throw Error("Invalid hook target");
  const dir = fs.realpathSync(target.directory),
    configDir = path.join(dir, target.app === "codex" ? ".codex" : ".claude");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(configDir).isSymbolicLink())
    throw Error("Hook configuration directory cannot be a symlink");
  const file = path.join(
    configDir,
    target.app === "codex" ? "hooks.json" : "settings.local.json",
  );
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())
    throw Error("Hook configuration cannot be a symlink");
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const config = before ? JSON.parse(before) : {},
    command = hookCommand(root, target.app);
  const events = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Stop",
    "SessionEnd",
    ...(target.app === "codex"
      ? ["Interrupt"]
      : ["PostToolUseFailure", "Notification"]),
  ];
  config.hooks = config.hooks || {};
  for (const event of events) {
    const groups = config.hooks[event] || [];
    config.hooks[event] = groups
      .map((g) => ({
        ...g,
        hooks: (g.hooks || []).filter((h) => h.command !== command),
      }))
      .filter((g) => g.hooks.length)
      .concat([{ hooks: [{ type: "command", command, timeout: 2 }] }]);
  }
  writeJson(file, config);
  return {
    file,
    before: before?.toString("base64") ?? null,
    after: digest(fs.readFileSync(file)),
  };
}
function restoreHooks(backups) {
  for (const b of backups || []) {
    if (!fs.existsSync(b.file) || digest(fs.readFileSync(b.file)) !== b.after)
      continue; // keep concurrent user edits
    if (b.before === null) fs.unlinkSync(b.file);
    else
      fs.writeFileSync(b.file, Buffer.from(b.before, "base64"), {
        mode: 0o600,
      });
  }
}
function configureHooks(root, target) {
  root = installRoot(root);
  const unlock = lock(root);
  try {
    if (!fs.existsSync(path.join(activeRoot(root), "cli-hook.js")))
      throw Error("This release has no CLI hook adapter");
    mergeHooks(root, target);
    const file = path.join(store(root), "hook-targets.json"),
      targets = readJson(file, []).filter(
        (t) => !(t.app === target.app && t.directory === target.directory),
      );
    writeJson(file, [...targets, target]);
    return {
      app: target.app,
      directory: target.directory,
      message:
        "已配置事件上报；CLI 加载或重新启动后生效，Codex 可能需要在 /hooks 中信任",
    };
  } finally {
    unlock();
  }
}
function activate(root, id) {
  root = installRoot(root);
  const unlock = lock(root);
  try {
    if (readJson(path.join(store(root), "prepared.json"))?.id !== id)
      throw Error("Release has not been prepared");
    if (
      readJson(path.join(store(root), "activation.json"))?.phase === "checking"
    )
      throw Error("An activation is in progress");
    const expected = instances(root);
    if (!expected.length)
      throw Error("No managed monitor processes are available");
    const previous = activeId(root),
      backups = [];
    try {
      const dir = path.join(store(root), "releases", id);
      if (fs.existsSync(path.join(dir, "cli-hook.js")))
        for (const target of readJson(
          path.join(store(root), "hook-targets.json"),
          [],
        ))
          backups.push(mergeHooks(root, target));
      const state = {
        id,
        previous,
        phase: "checking",
        startedAt: Date.now(),
        deadline: Date.now() + Number(process.env.SWT_HEALTH_TIMEOUT || 30000),
        expected: expected.map(({ pid, start }) => ({ pid, start })),
        backups,
      };
      writeJson(path.join(store(root), "activation.json"), state);
      setActive(root, id);
      return state;
    } catch (e) {
      restoreHooks(backups);
      throw e;
    }
  } finally {
    unlock();
  }
}
function rollback(root, state, reason) {
  let unlock;
  try {
    unlock = lock(root);
  } catch {
    return;
  }
  try {
    const current = readJson(path.join(store(root), "activation.json"));
    if (current?.phase !== "checking" || current.id !== state.id) return;
    setActive(root, state.previous);
    restoreHooks(state.backups);
    writeJson(path.join(store(root), "activation.json"), {
      ...state,
      phase: "rolled_back",
      error: reason,
      finishedAt: Date.now(),
    });
  } finally {
    unlock();
  }
}
function runManaged(role, root) {
  if (process.env.SWT_WORKER === "1") {
    // SIGKILL of a launcher must not leave an orphan attached to Screen.
    if (process.send) process.once("disconnect", () => process.exit(0));
    return false;
  }
  if (!["client", "server"].includes(role)) throw Error("Invalid managed role");
  root = installRoot(root);
  fs.mkdirSync(path.join(store(root), "instances"), {
    recursive: true,
    mode: 0o700,
  });
  const argv = process.argv.slice(2),
    config = configPath(root, argv),
    record = path.join(store(root), "instances", process.pid + ".json");
  let child = null,
    running,
    readyAt = 0,
    stopping = false,
    switching = false;
  const report = (status) =>
    writeJson(record, {
      pid: process.pid,
      start: processStamp(process.pid),
      role,
      config,
      releaseId: running || null,
      status,
    });
  function start() {
    running = activeId(root);
    readyAt = 0;
    const dir = activeRoot(root),
      manifest = readJson(path.join(dir, "release-manifest.json"));
    const entry = manifest?.entries[role] || role + ".js";
    report("starting");
    child = fork(path.join(dir, entry), argv, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SWT_WORKER: "1",
        SWT_INSTALL_ROOT: root,
        SWT_RELEASE_ID: running || "",
      },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });
    child.on("message", (msg) => {
      if (msg?.type === "swt_ready") readyAt = Date.now();
      if (msg?.type === "swt_restart") {
        switching = true;
        child.kill("SIGTERM");
      }
    });
    let exited = false;
    const onExit = (code) => {
      if (exited) return;
      exited = true;
      child = null;
      readyAt = 0;
      if (stopping) return;
      const state = readJson(path.join(store(root), "activation.json"));
      if (state?.phase === "checking" && running === state.id) {
        rollback(root, state, "新版本启动退出，已回滚");
        // A short-lived lock owner must not make the launcher exit before
        // another tick can restore the previous pointer.
        switching = true;
        setTimeout(() => {
          switching = false;
          start();
        }, 250);
        return;
      }
      if (switching || activeId(root) !== running) {
        switching = false;
        start();
      } else finish(code || 0);
    };
    child.once("exit", onExit);
    child.on("error", (e) => {
      console.error("[release]", e.message);
      onExit(1);
    });
  }
  function finish(code = 0) {
    stopping = true;
    clearInterval(timer);
    fs.rmSync(record, { force: true });
    if (child) child.kill("SIGTERM");
    process.exit(code);
  }
  const timer = setInterval(() => {
    if (stopping) return;
    const state = readJson(path.join(store(root), "activation.json"));
    if (child && activeId(root) !== running && !switching) {
      switching = true;
      child.kill("SIGTERM");
      return;
    }
    if (readyAt && Date.now() - readyAt >= 500) report("ready");
    if (state?.phase === "checking") {
      if (Date.now() > state.deadline) {
        rollback(root, state, "新版本健康检查超时，已回滚");
        return;
      }
      const live = instances(root);
      if (
        state.expected.every((e) =>
          live.some(
            (i) =>
              i.pid === e.pid &&
              i.start === e.start &&
              i.releaseId === state.id &&
              i.status === "ready",
          ),
        )
      ) {
        let unlock;
        try {
          unlock = lock(root);
        } catch {
          return;
        }
        try {
          if (
            readJson(path.join(store(root), "activation.json"))?.phase ===
            "checking"
          )
            writeJson(path.join(store(root), "activation.json"), {
              ...state,
              phase: "completed",
              finishedAt: Date.now(),
              backups: [],
            });
        } finally {
          unlock();
        }
      }
    }
  }, 250);
  process.once("SIGTERM", () => finish());
  process.once("SIGINT", () => finish());
  start();
  return true;
}
function restartWorker() {
  if (process.env.SWT_WORKER === "1" && process.send) {
    process.send({ type: "swt_restart" });
    return true;
  }
  // The initial bridge still runs inside the original service process. Ask
  // its supervisor to relaunch only when we can verify we are that unit's MainPID.
  if (process.env.INVOCATION_ID)
    try {
      const unit = fs
        .readFileSync("/proc/self/cgroup", "utf8")
        .match(/\/([A-Za-z0-9_.@-]+\.service)(?:\/|$)/m)?.[1];
      if (unit) {
        const main = require("child_process")
          .execFileSync(
            "systemctl",
            ["show", unit, "--property=MainPID", "--value"],
            { encoding: "utf8", timeout: 3000 },
          )
          .trim();
        if (Number(main) === process.pid) {
          setTimeout(() => process.exit(75), 250);
          return true;
        }
      }
    } catch {}
  return false;
}
function runHook(app, root = __dirname) {
  if (!["codex", "claude"].includes(app)) return;
  root = installRoot(root);
  const file = path.join(activeRoot(root), "cli-hook.js");
  if (!fs.existsSync(file)) return;
  process.argv = [process.execPath, file, app];
  require(file);
}
module.exports = {
  installRoot,
  activeId,
  activeRoot,
  instances,
  identity,
  notifyReady,
  runManaged,
  restartWorker,
  activate,
  configureHooks,
  runHook,
};
