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
function isMonitorHook(command, root, app, currentCommand) {
  if (command === currentCommand) return true;
  if (typeof command !== "string") return false;
  // Generated stable adapters use single-quoted shell arguments.
  // Parse only that generated form; never evaluate arbitrary shell text.
  const words = command.match(/(?:'[^']*'|\\.)+/g);
  if (!words || words.join(" ") !== command) return false;
  const args = words.map((word) =>
    word.replace(/'([^']*)'|\\(.)/g, (_, quoted, escaped) => quoted ?? escaped),
  );
  if (!/^(?:node|nodejs)$/.test(path.basename(args[0]))) return false;
  const stable =
    args.length === 4 &&
    args[2] === "--hook" &&
    args[3] === app &&
    path.basename(args[1]) === "file-update.js";
  if (!stable) return false;
  try {
    const script = fs.realpathSync(args[1]);
    return (
      script === path.join(root, path.basename(args[1])) ||
      new RegExp("^releases/[a-f0-9]{64}/file-update\\.js$").test(
        path.relative(store(root), script),
      )
    );
  } catch {
    return false;
  }
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
  let config;
  try { config = before ? JSON.parse(before) : {}; }
  catch { throw Error("Invalid hook configuration"); }
  const command = hookCommand(root, target.app);
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    (config.hooks !== undefined &&
      (!config.hooks ||
        typeof config.hooks !== "object" ||
        Array.isArray(config.hooks)))
  )
    throw Error("Invalid hook configuration");
  const original = JSON.stringify(config);
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
    const groups = config.hooks[event] === undefined ? [] : config.hooks[event];
    if (
      !Array.isArray(groups) ||
      groups.some((g) => !g || !Array.isArray(g.hooks))
    )
      throw Error("Invalid hook groups");
    // Leave unrelated groups, including empty groups and their matchers, intact.
    config.hooks[event] = groups
      .flatMap((g) => {
        if (
          !g.hooks.some((h) =>
            isMonitorHook(h.command, root, target.app, command),
          )
        )
          return [g];
        const hooks = g.hooks.filter(
          (h) => !isMonitorHook(h.command, root, target.app, command),
        );
        return hooks.length ? [{ ...g, hooks }] : [];
      })
      .concat([{ hooks: [{ type: "command", command, timeout: 2 }] }]);
  }
  if (JSON.stringify(config) !== original) {
    const current = fs.existsSync(file) ? fs.readFileSync(file) : null;
    if (
      (before === null) !== (current === null) ||
      (before && !before.equals(current))
    )
      throw Error("Hook configuration changed; retry later");
    const backup = path.join(
      store(root),
      "hook-config-backups",
      digest(file) + ".json",
    );
    if (!fs.existsSync(backup))
      writeJson(backup, { file, before: before?.toString("base64") ?? null });
    writeJson(file, config);
  }
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
    if (
      readJson(path.join(store(root), "activation.json"))?.phase === "checking"
    )
      throw Error("Release health check in progress");
    if (!fs.existsSync(path.join(activeRoot(root), "cli-hook.js")))
      throw Error("This release has no CLI hook adapter");
    mergeHooks(root, target);
    const file = path.join(store(root), "hook-targets.json"),
      targets = readJson(file, []).filter(
        (t) => !(t.app === target.app && t.directory === target.directory),
      );
    const next = [...targets, target].sort((a, b) =>
      (a.app + a.directory).localeCompare(b.app + b.directory),
    );
    if (JSON.stringify(readJson(file, [])) !== JSON.stringify(next))
      writeJson(file, next);
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
        )) {
          const file = path.join(
            target.directory,
            target.app === "codex"
              ? ".codex/hooks.json"
              : ".claude/settings.local.json",
          );
          // A deleted project or removed local configuration must not block
          // application upgrades or be recreated by the migration step.
          if (fs.existsSync(file)) backups.push(mergeHooks(root, target));
        }
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
