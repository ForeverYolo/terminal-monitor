"use strict";
// Configure a verified foreground CLI's working directory, including HOME.
// No prompts, transcripts, credentials or trust databases are written.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { readProcess, processApp } = require("./cli-process");
const { configureHooks, installRoot } = require("./release-runtime");

function readContext(processInfo) {
  const current = readProcess(processInfo.pid);
  if (
    !current ||
    current.start !== processInfo.start ||
    processApp(current.pid) !== processInfo.app
  )
    throw Error("CLI changed");
  const env = {};
  for (const entry of fs
    .readFileSync(`/proc/${current.pid}/environ`, "utf8")
    .split("\0")) {
    const i = entry.indexOf("="),
      key = entry.slice(0, i);
    if (["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"].includes(key))
      env[key] = entry.slice(i + 1);
  }
  const processCwd = fs.realpathSync(`/proc/${current.pid}/cwd`);
  const args = fs
    .readFileSync(`/proc/${current.pid}/cmdline`, "utf8")
    .split("\0");
  const requested =
    processInfo.app === "codex" ? option(args, ["-C", "--cd"]) : null;
  const cwd = fs.realpathSync(path.resolve(processCwd, requested || "."));
  const after = readProcess(current.pid);
  if (!after || after.start !== current.start) throw Error("CLI changed");
  let version;
  if (processInfo.app === "claude")
    try {
      const executable = path.basename(
        fs.readlinkSync(`/proc/${current.pid}/exe`),
      );
      if (/^\d+\.\d+\.\d+$/.test(executable)) version = executable;
      else if (args[1]?.includes("/@anthropic-ai/claude-code/"))
        version = readSettings(
          path.join(path.dirname(args[1]), "package.json"),
        ).version;
    } catch {}
  return { cwd, env, args, version };
}
function option(args, names) {
  let value;
  for (let i = 0; i < args.length && args[i] !== "--"; i++)
    for (const name of names) {
      if (args[i] === name) value = args[i + 1];
      else if (args[i].startsWith(name + "="))
        value = args[i].slice(name.length + 1);
    }
  return value;
}
function readSettings(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error();
    return value;
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw Error("现有 hooks 配置无法解析，未作修改");
  }
}
function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return "";
    throw e;
  }
}
function hookFeature(text) {
  let section = "",
    enabled;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) section = line.replace(/\s*#.*$/, "");
    const match =
      section === "[features]"
        ? line.match(/^(?:hooks|codex_hooks)\s*=\s*(true|false)\b/)
        : !section
          ? line.match(/^features\.(?:hooks|codex_hooks)\s*=\s*(true|false)\b/)
          : null;
    if (match) enabled = match[1] === "true";
  }
  return enabled;
}
function projectDirectory(app, context) {
  let directory = context.cwd;
  const v = String(context.version || "")
    .split(".")
    .map(Number);
  const rootLocalSettings =
    app === "claude" &&
    (v[0] > 2 || (v[0] === 2 && (v[1] > 1 || (v[1] === 1 && v[2] >= 211))));
  if (app === "codex" || rootLocalSettings)
    try {
      const options = {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      };
      if (rootLocalSettings) {
        const listing = execFileSync(
          "git",
          [
            "-c",
            "core.quotepath=false",
            "-C",
            directory,
            "worktree",
            "list",
            "--porcelain",
          ],
          options,
        );
        const main = listing
          .split("\n\n")
          .find((entry) => !/^bare$/m.test(entry))
          ?.match(/^worktree (.+)$/m)?.[1];
        if (!main) throw Error("No project worktree");
        directory = main.startsWith('"') ? JSON.parse(main) : main;
      } else
        directory = execFileSync(
          "git",
          ["-C", directory, "rev-parse", "--show-toplevel"],
          options,
        ).trim();
      if (
        rootLocalSettings &&
        fs.realpathSync(directory) ===
          fs.realpathSync(context.env.HOME || os.homedir())
      )
        directory = context.cwd;
    } catch {}
  directory = fs.realpathSync(directory);
  if (process.getuid && fs.statSync(directory).uid !== process.getuid())
    throw Error("项目目录不属于当前用户，未自动修改 hooks");
  return directory;
}
function disabledReason(app, directory, context) {
  const home = context.env.HOME || os.homedir();
  if (app === "codex") {
    const project = readText(path.join(directory, ".codex/config.toml"));
    const user = readText(
      path.join(
        context.env.CODEX_HOME || path.join(home, ".codex"),
        "config.toml",
      ),
    );
    let enabled = hookFeature(user);
    if (hookFeature(project) !== undefined) enabled = hookFeature(project);
    for (let i = 0; i < context.args.length && context.args[i] !== "--"; i++) {
      const arg = context.args[i],
        toggle = arg.match(/^--(enable|disable)(?:=(hooks|codex_hooks))?$/);
      if (
        toggle &&
        ["hooks", "codex_hooks"].includes(toggle[2] || context.args[i + 1])
      )
        enabled = toggle[1] === "enable";
      const override = ["-c", "--config"].includes(arg)
        ? context.args[i + 1]
        : arg.startsWith("--config=")
          ? arg.slice(9)
          : "";
      const feature = override?.match(
        /^features\.(?:hooks|codex_hooks)\s*=\s*(true|false)$/,
      );
      if (feature) enabled = feature[1] === "true";
    }
    if (enabled === false)
      return "Codex hooks 已关闭；保留原设置，请先启用 hooks";
    if (/^\s*\[\[?hooks(?:\.|\])/m.test(project))
      return "项目使用内联 hooks 配置，未覆盖；请将监控 hook 合并到现有配置";
  } else {
    if (context.args.includes("--bare"))
      return "Claude 本次未加载项目配置，无法接入项目事件";
    const sources = option(context.args, ["--setting-sources"]);
    if (sources !== undefined && !sources.split(",").includes("local"))
      return "Claude 当前未加载 local 配置，无法接入项目事件";
    let disabled;
    for (const [source, file] of [
      [
        "user",
        path.join(
          context.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"),
          "settings.json",
        ),
      ],
      ["project", path.join(directory, ".claude/settings.json")],
      ["local", path.join(directory, ".claude/settings.local.json")],
    ]) {
      if (sources !== undefined && !sources.split(",").includes(source))
        continue;
      const setting = readSettings(file);
      if (setting.disableAllHooks !== undefined)
        disabled = setting.disableAllHooks;
    }
    const override = option(context.args, ["--settings"]);
    if (override) {
      const setting = override.trim().startsWith("{")
        ? JSON.parse(override)
        : readSettings(path.resolve(context.cwd, override));
      if (setting.disableAllHooks !== undefined)
        disabled = setting.disableAllHooks;
    }
    if (disabled === true)
      return "Claude hooks 已关闭；保留原设置，请先启用 hooks";
  }
  return null;
}
function excludeLocalFile(directory, app) {
  // Keep generated monitoring settings out of a project's commits, without
  // changing its tracked .gitignore or the user's global git configuration.
  const relative =
    app === "codex" ? ".codex/hooks.json" : ".claude/settings.local.json";
  try {
    const options = {
      cwd: directory,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    };
    if (execFileSync("git", ["ls-files", "--", relative], options).trim())
      return;
    try {
      execFileSync("git", ["check-ignore", "--", relative], options);
      return;
    } catch {}
    const gitPath = execFileSync(
      "git",
      ["rev-parse", "--git-path", "info/exclude"],
      options,
    ).trim();
    const exclude = path.resolve(directory, gitPath),
      pattern = "/" + relative;
    if (fs.existsSync(exclude) && fs.lstatSync(exclude).isSymbolicLink())
      return;
    const content = readText(exclude);
    if (!content.split("\n").includes(pattern)) {
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      fs.appendFileSync(
        exclude,
        (content && !content.endsWith("\n") ? "\n" : "") + pattern + "\n",
      );
    }
  } catch {
    /* Git availability does not control hook delivery. */
  }
}
function createAutoHookSetup(
  root,
  {
    enabled = true,
    getContext = readContext,
    isCurrent = (cli) =>
      readProcess(cli.pid)?.start === cli.start &&
      processApp(cli.pid) === cli.app,
    install = configureHooks,
    schedule = setImmediate,
    now = Date.now,
  } = {},
) {
  root = installRoot(root);
  let key = null,
    result = null,
    busy = false,
    due = 0;
  return {
    observe(processes, state, receiverReady = true) {
      if (
        !state.isCodeCli ||
        !["codex", "claude"].includes(state.app) ||
        processes?.clis.length !== 1 ||
        processes.clis[0].app !== state.app
      ) {
        key = null;
        result = null;
        return null;
      }
      const cli = processes.clis[0],
        next = cli.app + ":" + cli.pid + ":" + cli.start;
      if (key !== next) {
        key = next;
        result = null;
        due = 0;
      }
      if (state.source === "hooks") return { phase: "connected", message: "" };
      if (!enabled)
        return {
          phase: "disabled",
          message: "已关闭自动事件接入，当前使用画面推断",
        };
      if (!receiverReady)
        return {
          phase: "error",
          message: "事件接收器尚未就绪，当前使用画面推断",
        };
      if (!busy && now() >= due) {
        busy = true;
        due = now() + 10000;
        if (!result)
          result = { phase: "installing", message: "正在自动配置事件接入" };
        schedule(() => {
          try {
            if (key !== next) return;
            const context = getContext(cli),
              directory = projectDirectory(cli.app, context);
            const blocked = disabledReason(cli.app, directory, context);
            if (blocked) {
              result = { phase: "blocked", message: blocked };
              return;
            }
            if (key !== next || !isCurrent(cli)) return;
            install(root, { app: cli.app, directory });
            excludeLocalFile(directory, cli.app);
            result = {
              phase: "configured",
              message:
                cli.app === "codex"
                  ? "已自动配置事件；请在 Codex 的 /hooks 中信任监控 hooks。若未列出，请重新加载会话配置"
                  : "已自动配置事件，等待 Claude 加载并上报；若仍未接通，请检查 /hooks 或重新加载会话配置",
            };
          } catch (e) {
            result = {
              phase: "error",
              message: /Another update|health check/.test(e.message)
                ? "版本切换中，稍后自动重试事件接入"
                : /^(?:项目目录不属于|现有 hooks 配置无法解析)/.test(
                      e.message,
                    )
                  ? e.message
                  : "自动事件接入未完成，请检查项目 hooks 配置或目录权限",
            };
          } finally {
            busy = false;
          }
        });
      }
      return result;
    },
  };
}
module.exports = {
  createAutoHookSetup,
  readContext,
  disabledReason,
  projectDirectory,
};
